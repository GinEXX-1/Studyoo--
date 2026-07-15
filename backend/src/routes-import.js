/**
 * routes-import.js — v2 结构化 PDF 导入流水线
 *
 * 流程：上传 PDF → 渲染页面 → AI 逐页识别 → 生成题目候选 → 人工校对 → 确认入库
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import express from "express";
import {
  db,
  canonicalTagsForSubject,
  nowIso,
  normalizeKnowledgeTags,
  parseJson,
  recordEvent
} from "./db.js";
import { requireAuth } from "./auth.js";
import { AppError, asyncRoute, fail, ok } from "./http.js";
import { config } from "./config.js";
import { ensureAiConfigured, recognizePageQuestions, recognizeSingleQuestion, recognizePhotoQuestion } from "./ai.js";
import { withAiQuota } from "./quota.js";
import sharp from "sharp";
import { extractStructuredPdfText } from "./pdf-text.js";

const execFileAsync = promisify(execFile);

export const importRouter = express.Router();

async function prepareVisionImageDataUrl(imagePath) {
  const optimized = await sharp(imagePath)
    .rotate()
    .normalize()
    .sharpen({ sigma: 0.6 })
    .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return `data:image/jpeg;base64,${optimized.toString("base64")}`;
}

// ——— 工具 ———
function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, "VALIDATION_ERROR", `${label}不能为空。`);
  }
  return value.trim();
}

function toImportTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    subject: row.subject,
    source_name: row.source_name,
    title: row.title || row.source_name.replace(/\.pdf$/i, ""),
    year: row.year || new Date().getFullYear(),
    status: row.status,
    total_pages: row.total_pages,
    processed_pages: row.processed_pages,
    question_count: row.question_count,
    error_message: row.error_message,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toImportPage(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    page_number: row.page_number,
    image_url: row.image_url,
    render_status: row.render_status,
    ocr_status: row.ocr_status,
    ocr_raw_text: row.ocr_raw_text,
    error_message: row.error_message,
    created_at: row.created_at
  };
}

function toQuestionCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    page_id: row.page_id,
    page_number: row.page_number,
    question_number: row.question_number,
    crop_image_url: row.crop_image_url,
    crop_bbox_json: row.crop_bbox_json ? parseJson(row.crop_bbox_json, null) : null,
    subject: row.subject,
    stem_text: row.stem_text,
    options: parseJson(row.options_json, []),
    reference_answer_text: row.reference_answer_text,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    difficulty: row.difficulty,
    question_type: row.question_type,
    recognition_confidence: row.recognition_confidence,
    has_figure: Boolean(row.has_figure),
    requires_manual_review: Boolean(row.requires_manual_review),
    review_status: row.review_status,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    review_notes: row.review_notes,
    confirmed_question_id: row.confirmed_question_id,
    confirmed_question_type: row.confirmed_question_type,
    recognition_attempts: row.recognition_attempts,
    last_recognition_error: row.last_recognition_error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// ——— 单题裁切 ———
// 依据 AI 标注的 bbox_rel（0-100 相对坐标）从整页 PNG 裁出单题图片，
// 供前端校对展示与后续"单题精细重识别"使用。裁剪失败不影响主流程。
const CROP_PADDING_PERCENT = 2;

async function generateCandidateCrop({ pagePngPath, bboxRel, outPath }) {
  const image = sharp(pagePngPath);
  const metadata = await image.metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!width || !height) return false;

  const x = Math.max(0, Math.round((Number(bboxRel.x) - CROP_PADDING_PERCENT) / 100 * width));
  const y = Math.max(0, Math.round((Number(bboxRel.y) - CROP_PADDING_PERCENT) / 100 * height));
  const w = Math.min(width - x, Math.round((Number(bboxRel.width) + CROP_PADDING_PERCENT * 2) / 100 * width));
  const h = Math.min(height - y, Math.round((Number(bboxRel.height) + CROP_PADDING_PERCENT * 2) / 100 * height));
  if (w < 40 || h < 24) return false;

  await image.extract({ left: x, top: y, width: w, height: h }).png().toFile(outPath);
  return existsSync(outPath);
}

function cleanupImportFiles(uploadDir, taskId) {
  const prefix = `import-${taskId}`;
  for (const fileName of readdirSync(uploadDir)) {
    if (fileName === `${prefix}.pdf` || fileName.startsWith(`${prefix}-page-`)) {
      try { unlinkSync(resolve(uploadDir, fileName)); } catch {}
    }
  }
}

function cleanupUploadUrls(uploadDir, urls) {
  for (const url of urls) {
    if (typeof url !== "string" || !(url.startsWith("/uploads/crop-") || url.startsWith("/uploads/photo-"))) continue;
    const fileName = url.slice("/uploads/".length);
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) continue;
    try { unlinkSync(resolve(uploadDir, fileName)); } catch {}
  }
}

async function generateCropsForCandidates(page, candidateIds) {
  const uploadDir = resolve(config.uploadDir);
  const pagePngPath = resolve(uploadDir, page.image_url.replace("/uploads/", ""));
  if (!existsSync(pagePngPath)) return;
  for (const candidateId of candidateIds) {
    const candidate = db.prepare("SELECT id, crop_bbox_json FROM question_candidates WHERE id = ?").get(candidateId);
    const bbox = candidate?.crop_bbox_json ? parseJson(candidate.crop_bbox_json, null) : null;
    if (!bbox || typeof bbox.width !== "number" || typeof bbox.height !== "number") continue;
    const fileName = `crop-${candidateId}.png`;
    try {
      const done = await generateCandidateCrop({ pagePngPath, bboxRel: bbox, outPath: resolve(uploadDir, fileName) });
      if (done) {
        db.prepare("UPDATE question_candidates SET crop_image_url = ? WHERE id = ?").run(`/uploads/${fileName}`, candidateId);
      }
    } catch {
      // 裁剪失败保留整页图兜底
    }
  }
}

function ensureImportedLibrary({ task, userId, createdAt }) {
  const paperId = `paper-import-${task.id}`;
  const collectionId = `collection-import-${task.id}`;
  const title = task.title || task.source_name.replace(/\.pdf$/i, "");
  db.prepare(`
    INSERT OR IGNORE INTO exam_papers (
      id, year, region, subject, title, source_name, source_url, license_note,
      status, created_at, owner_user_id, import_kind
    ) VALUES (?, ?, '个人题库', ?, ?, ?, NULL, ?, 'draft', ?, ?, 'pdf')
  `).run(
    paperId,
    Number(task.year) || new Date().getFullYear(),
    task.subject,
    title,
    task.source_name,
    "用户本地上传，仅用于个人学习。",
    createdAt,
    userId
  );
  db.prepare(`
    INSERT OR IGNORE INTO question_collections (
      id, user_id, title, description, subject, creation_mode,
      cover_style, source_paper_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pdf-structured', 'blue', ?, ?)
  `).run(
    collectionId,
    userId,
    title,
    "由 PDF 逐题识别并经人工确认建立的个人题库",
    task.subject,
    paperId,
    createdAt
  );
  return { paperId, collectionId };
}

function updateTaskCandidateCount(taskId) {
  const questionCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ?").get(taskId).cnt;
  db.prepare("UPDATE import_tasks SET question_count = ?, status = 'awaiting_review', updated_at = ? WHERE id = ?")
    .run(questionCount, nowIso(), taskId);
}

function normalizeManualBBox(value) {
  if (value == null) return null;
  const bbox = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height)
  };
  if (Object.values(bbox).some((item) => !Number.isFinite(item))
    || bbox.x < 0 || bbox.y < 0 || bbox.width <= 0 || bbox.height <= 0
    || bbox.x + bbox.width > 100.01 || bbox.y + bbox.height > 100.01) {
    throw new AppError(400, "VALIDATION_ERROR", "框选区域坐标不合法。");
  }
  return bbox;
}

function insertManualCandidate({ task, page, input = {}, fallback = {}, createdAt = nowIso() }) {
  const candidateId = randomUUID();
  const questionNumber = Number(input.question_number ?? fallback.question_number);
  const stemText = requireString(input.stem_text ?? fallback.stem_text, "题目内容");
  const options = Array.isArray(input.options) ? input.options : parseJson(fallback.options_json, []);
  const tags = normalizeKnowledgeTags(task.subject, Array.isArray(input.knowledge_tags)
    ? input.knowledge_tags
    : parseJson(fallback.knowledge_tags_json, []));
  const difficulty = ["easy", "medium", "hard"].includes(input.difficulty) ? input.difficulty : (fallback.difficulty || "medium");
  const questionType = ["choice", "fill-in-blank", "short-answer"].includes(input.question_type)
    ? input.question_type
    : (fallback.question_type || "choice");
  const manualBBox = normalizeManualBBox(input.crop_bbox_json);

  if (!Number.isInteger(questionNumber) || questionNumber < 1) {
    throw new AppError(400, "VALIDATION_ERROR", "题号必须是正整数。");
  }

  const hasFigure = typeof input.has_figure === "boolean" ? input.has_figure : Boolean(fallback.has_figure);

  db.prepare(`
    INSERT INTO question_candidates (
      id, task_id, page_id, page_number, question_number, subject,
      stem_text, options_json, reference_answer_text, knowledge_tags_json,
      difficulty, question_type, recognition_confidence, requires_manual_review,
      review_status, reviewed_by, reviewed_at, review_notes, created_at, updated_at,
      crop_bbox_json, has_figure
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'reviewing', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId, task.id, page.id, page.page_number, questionNumber, task.subject,
    stemText,
    JSON.stringify(options.filter((item) => item && typeof item.label === "string")),
    typeof input.reference_answer_text === "string" ? input.reference_answer_text.trim() : (fallback.reference_answer_text || ""),
    JSON.stringify(tags), difficulty, questionType,
    typeof fallback.recognition_confidence === "number" ? fallback.recognition_confidence : null,
    task.user_id, createdAt,
    typeof input.review_notes === "string" ? input.review_notes.trim() : "人工校对创建",
    createdAt, createdAt,
    manualBBox ? JSON.stringify(manualBBox) : (fallback.crop_bbox_json || null),
    hasFigure ? 1 : 0
  );
  return db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(candidateId);
}

// ——— 1. 上传 PDF，创建导入任务 ———
importRouter.post("/import/pipeline/upload", requireAuth, asyncRoute(async (req, res) => {
  const fileName = requireString(req.body.file_name, "PDF 文件名");
  const dataBase64 = requireString(req.body.data_base64, "PDF 文件内容");
  const subject = requireString(req.body.subject || "数学", "学科");
  const title = requireString(req.body.title || fileName.replace(/\.pdf$/i, ""), "题库名称");
  const year = Number(req.body.year || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1) {
    throw new AppError(400, "VALIDATION_ERROR", "试卷年份不合法。");
  }

  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024 || buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw new AppError(400, "VALIDATION_ERROR", "请上传不超过 20MB 的有效 PDF 文件。");
  }
  if (!/^%PDF-1\.[0-8]/.test(buffer.subarray(0, 8).toString())) {
    throw new AppError(400, "VALIDATION_ERROR", "PDF 文件头格式无效。");
  }

  const taskId = randomUUID();
  const uploadDir = resolve(config.uploadDir);
  mkdirSync(uploadDir, { recursive: true });

  // 保存 PDF 文件
  const pdfFileName = `import-${taskId}.pdf`;
  const pdfPath = resolve(uploadDir, pdfFileName);
  writeFileSync(pdfPath, buffer);

  // 渲染页面
  const pagePrefix = resolve(uploadDir, `import-${taskId}-page`);
  let pageFiles = [];
  try {
    await execFileAsync(config.pdfRenderCommand, ["-png", "-r", "180", pdfPath, pagePrefix], { timeout: 120000 });
    pageFiles = readdirSync(uploadDir)
      .filter((name) => name.startsWith(`import-${taskId}-page-`) && name.endsWith(".png"))
      .sort((a, b) => Number(a.match(/-(\d+)\.png$/)?.[1]) - Number(b.match(/-(\d+)\.png$/)?.[1]));
  } catch (err) {
    cleanupImportFiles(uploadDir, taskId);
    console.error(`[import] PDF 渲染失败 task=${taskId}:`, err.message);
    throw new AppError(500, "PDF_RENDER_ERROR", "PDF 页面渲染失败，请确认文件是有效的 PDF 后重试。");
  }

  if (pageFiles.length === 0) {
    cleanupImportFiles(uploadDir, taskId);
    throw new AppError(500, "PDF_RENDER_ERROR", "PDF 没有生成可用页面。");
  }

  const createdAt = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO import_tasks (
        id, user_id, subject, source_name, title, year, pdf_filename,
        status, total_pages, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?)
    `).run(taskId, req.user.id, subject, fileName, title, year, pdfFileName, pageFiles.length, createdAt, createdAt);

    pageFiles.forEach((pageFile, index) => {
      const pageId = randomUUID();
      db.prepare(`
        INSERT INTO import_pages (id, task_id, page_number, image_url, render_status, ocr_status, created_at)
        VALUES (?, ?, ?, ?, 'rendered', 'pending', ?)
      `).run(pageId, taskId, index + 1, `/uploads/${pageFile}`, createdAt);
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    cleanupImportFiles(uploadDir, taskId);
    throw error;
  }

  const task = toImportTask(db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(taskId));
  const pages = db.prepare("SELECT * FROM import_pages WHERE task_id = ? ORDER BY page_number").all(taskId).map(toImportPage);
  recordEvent(req.user.id, "import_started", { task_id: taskId, total_pages: pages.length });
  res.status(201).json(ok({ task, pages }));
}));

// ——— 2. 获取导入任务列表 ———
importRouter.get("/import/pipeline/tasks", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, user_id, subject, source_name, title, year, status, total_pages,
           processed_pages, question_count, error_message, created_at, updated_at
    FROM import_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
  `).all(req.user.id);
  res.json(ok({ items: rows.map(toImportTask) }));
});

// ——— 3. 获取单个任务详情（含页面和候选） ———
importRouter.get("/import/pipeline/tasks/:taskId", requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ? AND user_id = ?").get(req.params.taskId, req.user.id);
  if (!task) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个导入任务。");

  const pages = db.prepare("SELECT * FROM import_pages WHERE task_id = ? ORDER BY page_number").all(task.id).map(toImportPage);
  const candidates = db.prepare("SELECT * FROM question_candidates WHERE task_id = ? ORDER BY page_number, question_number").all(task.id).map(toQuestionCandidate);
  const numbers = candidates
    .map((item) => Number(item.question_number))
    .filter((item) => Number.isInteger(item) && item > 0);
  const highestQuestionNumber = numbers.length ? Math.max(...numbers) : 0;
  const knownNumbers = new Set(numbers);
  const numberCounts = numbers.reduce((counts, number) => counts.set(number, (counts.get(number) || 0) + 1), new Map());
  const duplicateQuestionNumbers = [...numberCounts.entries()].filter(([, count]) => count > 1).map(([number]) => number);
  const missingQuestionNumbers = Array.from({ length: highestQuestionNumber }, (_, index) => index + 1)
    .filter((number) => !knownNumbers.has(number));

  res.json(ok({
    task: toImportTask(task),
    pages,
    candidates,
    integrity: {
      recognized_count: candidates.length,
      highest_question_number: highestQuestionNumber,
      missing_question_numbers: missingQuestionNumbers,
      duplicate_question_numbers: duplicateQuestionNumbers
    }
  }));
});

// 放弃尚未入库的导入任务，并清理对应 PDF、页面图和裁切图。
importRouter.delete("/import/pipeline/tasks/:taskId", requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ? AND user_id = ?").get(req.params.taskId, req.user.id);
  if (!task) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个导入任务。");

  const confirmedCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ? AND review_status = 'confirmed'")
    .get(task.id).cnt;
  if (confirmedCount > 0) {
    throw new AppError(409, "VALIDATION_ERROR", "已有题目确认入库，不能删除这次导入。");
  }

  const cropUrls = db.prepare("SELECT crop_image_url FROM question_candidates WHERE task_id = ? AND crop_image_url IS NOT NULL")
    .all(task.id).map((row) => row.crop_image_url);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM candidate_crops WHERE candidate_id IN (SELECT id FROM question_candidates WHERE task_id = ?)").run(task.id);
    db.prepare("DELETE FROM question_candidates WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM import_pages WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM import_tasks WHERE id = ?").run(task.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const uploadDir = resolve(config.uploadDir);
  cleanupUploadUrls(uploadDir, cropUrls);
  cleanupImportFiles(uploadDir, task.id);
  res.json(ok({ id: task.id }));
});

// ——— 4. 处理某一页（AI 识别题目）———
importRouter.post("/import/pipeline/pages/:pageId/process", requireAuth, asyncRoute(async (req, res) => {
  const page = db.prepare(`
    SELECT p.* FROM import_pages p
    JOIN import_tasks t ON t.id = p.task_id
    WHERE p.id = ? AND t.user_id = ?
  `).get(req.params.pageId, req.user.id);
  if (!page) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个页面。");

  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(page.task_id);
  const confirmedCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE page_id = ? AND review_status = 'confirmed'")
    .get(page.id).cnt;
  if (confirmedCount > 0) {
    throw new AppError(409, "VALIDATION_ERROR", "这一页已有题目确认入库，不能重新识别以免覆盖校对记录。");
  }

  ensureAiConfigured();

  // 读取页面图片
  const uploadDir = resolve(config.uploadDir);
  const imageName = page.image_url.replace("/uploads/", "");
  const imagePath = resolve(uploadDir, imageName);
  if (!existsSync(imagePath)) {
    throw new AppError(500, "FILE_ERROR", "页面图片文件丢失，请重新上传PDF。");
  }
  const imageDataUrl = await prepareVisionImageDataUrl(imagePath);

  // 调用 AI 识别（计入每日配额）
  let recognition;
  try {
    recognition = await withAiQuota(req.user.id, () => recognizePageQuestions({
      subject: task.subject,
      imageDataUrl,
      canonicalTags: canonicalTagsForSubject(task.subject)
    }));
  } catch (error) {
    db.prepare("UPDATE import_pages SET ocr_status = 'failed', error_message = ? WHERE id = ?")
      .run(error.message.slice(0, 500), page.id);
    db.prepare("UPDATE import_tasks SET updated_at = ? WHERE id = ?").run(nowIso(), task.id);
    throw error;
  }

  const createdAt = nowIso();
  const candidates = [];
  const questions = Array.isArray(recognition.questions) ? recognition.questions : [];
  const oldCropUrls = db.prepare("SELECT crop_image_url FROM question_candidates WHERE page_id = ? AND crop_image_url IS NOT NULL")
    .all(page.id).map((row) => row.crop_image_url);

  db.exec("BEGIN");
  try {
    // 删除旧候选与写入新结果必须同处一个事务，避免失败时丢失人工校对内容。
    db.prepare("DELETE FROM question_candidates WHERE page_id = ?").run(page.id);
    for (const q of questions) {
      const candidateId = randomUUID();
      const knowledgeTags = normalizeKnowledgeTags(task.subject, Array.isArray(q.knowledge_tags) ? q.knowledge_tags : []);
      const options = Array.isArray(q.options) ? q.options.filter((o) => o && typeof o.label === "string") : [];
      const confidence = typeof q.confidence === "number" ? Math.max(0, Math.min(1, q.confidence)) : 0.7;
      const requiresManual = confidence < 0.85;

      db.prepare(`
          INSERT INTO question_candidates (
          id, task_id, page_id, page_number, question_number, subject,
          stem_text, options_json, reference_answer_text, knowledge_tags_json,
          difficulty, question_type, recognition_confidence, requires_manual_review,
          review_status, created_at, updated_at, crop_bbox_json, has_figure
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        candidateId, task.id, page.id, page.page_number,
        Number(q.question_number) || candidates.length + 1,
        task.subject,
        typeof q.stem_text === "string" ? q.stem_text.trim() : "",
        JSON.stringify(options),
        typeof q.reference_answer_text === "string" ? q.reference_answer_text.trim() : "",
        JSON.stringify(knowledgeTags),
        ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
        ["choice", "fill-in-blank", "short-answer"].includes(q.question_type) ? q.question_type : "choice",
        confidence,
        requiresManual ? 1 : 0,
        createdAt, createdAt,
        q.bbox_rel ? JSON.stringify(q.bbox_rel) : null,
        q.has_figure ? 1 : 0
      );

      candidates.push(toQuestionCandidate(db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(candidateId)));
    }

    db.prepare("UPDATE import_pages SET ocr_status = 'processed', ocr_raw_text = ?, ocr_result_json = ? WHERE id = ?")
      .run(
        (recognition.page_text || "").slice(0, 8000),
        JSON.stringify(recognition),
        page.id
      );
    const processedPages = db.prepare("SELECT COUNT(*) AS cnt FROM import_pages WHERE task_id = ? AND ocr_status = 'processed'").get(task.id).cnt;
    const questionCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ?").get(task.id).cnt;
    const status = processedPages >= task.total_pages ? "awaiting_review" : "processing";
    db.prepare("UPDATE import_tasks SET processed_pages = ?, question_count = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(processedPages, questionCount, status, createdAt, task.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  cleanupUploadUrls(uploadDir, oldCropUrls);

  // 逐题裁切单题图（本地操作，不计配额）
  await generateCropsForCandidates(page, candidates.map((item) => item.id));

  const refreshed = db.prepare("SELECT * FROM question_candidates WHERE page_id = ? ORDER BY question_number").all(page.id).map(toQuestionCandidate);
  res.json(ok({ page: toImportPage(db.prepare("SELECT * FROM import_pages WHERE id = ?").get(page.id)), candidates: refreshed }));
}));

// ——— 5. 处理任务所有页面 ———
importRouter.post("/import/pipeline/tasks/:taskId/process-all", requireAuth, asyncRoute(async (req, res) => {
  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ? AND user_id = ?").get(req.params.taskId, req.user.id);
  if (!task) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个导入任务。");

  const pages = db.prepare("SELECT * FROM import_pages WHERE task_id = ? AND ocr_status = 'pending' ORDER BY page_number").all(task.id);
  if (pages.length === 0) {
    return res.json(ok({ message: "所有页面已处理完毕。", processed: 0, total: 0 }));
  }

  // 数字版 PDF 优先使用内置文字层：本地完成题号切分和答案关联，避免逐页调用视觉模型。
  const confirmedCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ? AND review_status = 'confirmed'")
    .get(task.id).cnt;
  if (confirmedCount === 0 && pages.length === task.total_pages && task.pdf_filename) {
    const pdfPath = resolve(config.uploadDir, task.pdf_filename);
    try {
      const extraction = await extractStructuredPdfText(pdfPath);
      if (extraction.reliable) {
        const pageByNumber = new Map(pages.map((page) => [page.page_number, page]));
        const createdAt = nowIso();
        db.exec("BEGIN");
        try {
          db.prepare("DELETE FROM question_candidates WHERE task_id = ?").run(task.id);
          for (const question of extraction.questions) {
            const page = pageByNumber.get(question.page_number) || pages[0];
            db.prepare(`
              INSERT INTO question_candidates (
                id, task_id, page_id, page_number, question_number, subject,
                stem_text, options_json, reference_answer_text, knowledge_tags_json,
                difficulty, question_type, recognition_confidence, requires_manual_review,
                review_status, created_at, updated_at, crop_bbox_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, '[]', ?, ?, ?, 1, 'pending', ?, ?, NULL)
            `).run(
              randomUUID(), task.id, page.id, question.page_number, question.question_number, task.subject,
              question.stem_text, question.reference_answer_text, question.difficulty,
              question.question_type, question.confidence, createdAt, createdAt
            );
          }
          for (const page of pages) {
            const pageQuestions = extraction.questions.filter((question) => question.page_number === page.page_number);
            db.prepare("UPDATE import_pages SET ocr_status = 'processed', ocr_raw_text = ?, ocr_result_json = ?, error_message = NULL WHERE id = ?")
              .run(
                (extraction.pages[page.page_number - 1] || "").slice(0, 8000),
                JSON.stringify({ mode: "pdf_text", questions: pageQuestions }),
                page.id
              );
          }
          db.prepare("UPDATE import_tasks SET status = 'awaiting_review', processed_pages = ?, question_count = ?, updated_at = ? WHERE id = ?")
            .run(task.total_pages, extraction.questions.length, createdAt, task.id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }

        console.log(`[import] local-text task=${task.id} pages=${task.total_pages} questions=${extraction.questions.length} elapsed_ms=${extraction.elapsed_ms}`);
        return res.json(ok({
          mode: "pdf_text",
          results: pages.map((page) => ({
            page_number: page.page_number,
            status: "processed",
            question_count: extraction.questions.filter((question) => question.page_number === page.page_number).length
          })),
          processed: task.total_pages,
          total: task.total_pages,
          elapsed_ms: extraction.elapsed_ms
        }));
      }
      console.log(`[import] local-text-unreliable task=${task.id} detected=${extraction.questions.length} elapsed_ms=${extraction.elapsed_ms}; fallback=vision`);
    } catch (error) {
      console.warn(`[import] local-text-failed task=${task.id} error=${error.message}; fallback=vision`);
    }
  }

  // 前端先走快速文字层探测；只有确实需要视觉模型时，才改为逐页请求并展示真实进度。
  if (req.query.prefer_text_only === "1") {
    return res.json(ok({
      mode: "vision_required",
      processed: 0,
      total: pages.length,
      pages: pages.map((page) => ({ id: page.id, page_number: page.page_number }))
    }));
  }

  ensureAiConfigured();
  db.prepare("UPDATE import_tasks SET status = 'processing', updated_at = ? WHERE id = ?").run(nowIso(), task.id);

  const uploadDir = resolve(config.uploadDir);
  const results = [];

  for (const page of pages) {
    let transactionStarted = false;
    try {
      const imageName = page.image_url.replace("/uploads/", "");
      const imagePath = resolve(uploadDir, imageName);
      if (!existsSync(imagePath)) {
        db.prepare("UPDATE import_pages SET ocr_status = 'failed', error_message = '页面图片丢失' WHERE id = ?").run(page.id);
        results.push({ page_number: page.page_number, status: "failed", error: "页面图片丢失" });
        continue;
      }
      const imageDataUrl = await prepareVisionImageDataUrl(imagePath);

      const recognition = await withAiQuota(req.user.id, () => recognizePageQuestions({
        subject: task.subject,
        imageDataUrl,
        canonicalTags: canonicalTagsForSubject(task.subject)
      }));

      const createdAt = nowIso();
      const questions = Array.isArray(recognition.questions) ? recognition.questions : [];
      const pageCandidateIds = [];
      const oldCropUrls = db.prepare("SELECT crop_image_url FROM question_candidates WHERE page_id = ? AND crop_image_url IS NOT NULL")
        .all(page.id).map((row) => row.crop_image_url);

      db.exec("BEGIN");
      transactionStarted = true;
      db.prepare("DELETE FROM question_candidates WHERE page_id = ?").run(page.id);
      for (const q of questions) {
        const candidateId = randomUUID();
        pageCandidateIds.push(candidateId);
        const knowledgeTags = normalizeKnowledgeTags(task.subject, Array.isArray(q.knowledge_tags) ? q.knowledge_tags : []);
        const options = Array.isArray(q.options) ? q.options.filter((o) => o && typeof o.label === "string") : [];

        db.prepare(`
          INSERT INTO question_candidates (
            id, task_id, page_id, page_number, question_number, subject,
            stem_text, options_json, reference_answer_text, knowledge_tags_json,
            difficulty, question_type, recognition_confidence, requires_manual_review,
            review_status, created_at, updated_at, crop_bbox_json, has_figure
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(
          candidateId, task.id, page.id, page.page_number,
          Number(q.question_number) || 0,
          task.subject,
          typeof q.stem_text === "string" ? q.stem_text.trim() : "",
          JSON.stringify(options),
          typeof q.reference_answer_text === "string" ? q.reference_answer_text.trim() : "",
          JSON.stringify(knowledgeTags),
          ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
          ["choice", "fill-in-blank", "short-answer"].includes(q.question_type) ? q.question_type : "choice",
          typeof q.confidence === "number" ? q.confidence : 0.7,
          (typeof q.confidence === "number" ? q.confidence : 0.7) < 0.85 ? 1 : 0,
          createdAt, createdAt,
          q.bbox_rel ? JSON.stringify(q.bbox_rel) : null,
          q.has_figure ? 1 : 0
        );
      }
      db.exec("COMMIT");
      transactionStarted = false;
      cleanupUploadUrls(uploadDir, oldCropUrls);

      db.prepare("UPDATE import_pages SET ocr_status = 'processed', ocr_raw_text = ?, ocr_result_json = ? WHERE id = ?")
        .run((recognition.page_text || "").slice(0, 8000), JSON.stringify(recognition), page.id);

      await generateCropsForCandidates(page, pageCandidateIds);

      results.push({ page_number: page.page_number, status: "processed", question_count: questions.length });
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      // 配额用尽时停止整批处理，页面保持 pending 供次日继续
      if (error instanceof AppError && error.status === 429) {
        results.push({ page_number: page.page_number, status: "skipped", error: "AI 每日配额已用尽，剩余页面明天可继续处理。" });
        break;
      }
      db.prepare("UPDATE import_pages SET ocr_status = 'failed', error_message = ? WHERE id = ?")
        .run(error.message.slice(0, 500), page.id);
      results.push({ page_number: page.page_number, status: "failed", error: error.message });
    }
  }

  const processedPages = db.prepare("SELECT COUNT(*) AS cnt FROM import_pages WHERE task_id = ? AND ocr_status = 'processed'").get(task.id).cnt;
  const questionCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ?").get(task.id).cnt;
  const newStatus = processedPages >= task.total_pages ? "awaiting_review" : "processing";
  db.prepare("UPDATE import_tasks SET status = ?, processed_pages = ?, question_count = ?, updated_at = ? WHERE id = ?")
    .run(newStatus, processedPages, questionCount, nowIso(), task.id);

  res.json(ok({ results, processed: processedPages, total: task.total_pages }));
}));

// ——— 6. 获取单个候选 ———
importRouter.get("/import/pipeline/candidates/:candidateId", requireAuth, (req, res) => {
  const candidate = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id = ? AND t.user_id = ?
  `).get(req.params.candidateId, req.user.id);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题目候选。");

  res.json(ok(toQuestionCandidate(candidate)));
});

// ——— 7. 校对更新候选 ———
importRouter.patch("/import/pipeline/candidates/:candidateId", requireAuth, asyncRoute(async (req, res) => {
  const candidate = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id = ? AND t.user_id = ?
  `).get(req.params.candidateId, req.user.id);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题目候选。");

  const subject = db.prepare("SELECT subject FROM import_tasks WHERE id = ?").get(candidate.task_id).subject;
  const updates = {};
  if (typeof req.body.stem_text === "string") updates.stem_text = req.body.stem_text.trim();
  if (typeof req.body.reference_answer_text === "string") updates.reference_answer_text = req.body.reference_answer_text.trim();
  if (typeof req.body.difficulty === "string" && ["easy", "medium", "hard"].includes(req.body.difficulty)) updates.difficulty = req.body.difficulty;
  if (typeof req.body.question_type === "string" && ["choice", "fill-in-blank", "short-answer"].includes(req.body.question_type)) updates.question_type = req.body.question_type;
  if (typeof req.body.question_number === "number") updates.question_number = req.body.question_number;
  if (typeof req.body.has_figure === "boolean") updates.has_figure = req.body.has_figure ? 1 : 0;
  if (Array.isArray(req.body.options)) updates.options_json = JSON.stringify(req.body.options.filter((o) => o && typeof o.label === "string"));
  if (Array.isArray(req.body.knowledge_tags)) {
    updates.knowledge_tags_json = JSON.stringify(normalizeKnowledgeTags(subject, req.body.knowledge_tags));
  }
  if (typeof req.body.review_notes === "string") updates.review_notes = req.body.review_notes.trim();

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "没有提供可更新的字段。");
  }

  // 首次人工修改前，把 AI 原始识别结果快照下来——"识别纠错对"是未来微调的核心语料
  if (!candidate.ai_snapshot_json && candidate.recognition_confidence != null) {
    updates.ai_snapshot_json = JSON.stringify({
      question_number: candidate.question_number,
      stem_text: candidate.stem_text,
      options_json: candidate.options_json,
      reference_answer_text: candidate.reference_answer_text,
      knowledge_tags_json: candidate.knowledge_tags_json,
      difficulty: candidate.difficulty,
      question_type: candidate.question_type,
      has_figure: candidate.has_figure,
      recognition_confidence: candidate.recognition_confidence
    });
  }

  updates.updated_at = nowIso();
  updates.review_status = "reviewing";
  updates.reviewed_by = req.user.id;
  updates.reviewed_at = nowIso();

  const setClauses = Object.keys(updates).map((key) => `${key} = ?`).join(", ");
  const values = Object.values(updates);
  db.prepare(`UPDATE question_candidates SET ${setClauses} WHERE id = ?`).run(...values, candidate.id);

  res.json(ok(toQuestionCandidate(db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(candidate.id))));
}));

// 人工补录漏识别题目。
importRouter.post("/import/pipeline/pages/:pageId/candidates", requireAuth, asyncRoute(async (req, res) => {
  const page = db.prepare(`
    SELECT p.* FROM import_pages p
    JOIN import_tasks t ON t.id = p.task_id
    WHERE p.id = ? AND t.user_id = ?
  `).get(req.params.pageId, req.user.id);
  if (!page) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个页面。");
  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(page.task_id);

  db.exec("BEGIN");
  let row;
  try {
    row = insertManualCandidate({ task, page, input: req.body });
    updateTaskCandidateCount(task.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  await generateCropsForCandidates(page, [row.id]);
  const refreshed = db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(row.id);
  res.status(201).json(ok(toQuestionCandidate(refreshed)));
}));

// 按用户拖动后的顺序重排候选题，并连续重编号。
importRouter.post("/import/pipeline/tasks/:taskId/candidates/reorder", requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ? AND user_id = ?").get(req.params.taskId, req.user.id);
  if (!task) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个导入任务。");
  const confirmedCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ? AND review_status = 'confirmed'")
    .get(task.id).cnt;
  if (confirmedCount > 0) {
    throw new AppError(409, "VALIDATION_ERROR", "已有题目确认入库，不能再整体调整题目顺序。");
  }

  const orderedIds = Array.isArray(req.body.candidate_ids)
    ? [...new Set(req.body.candidate_ids.filter((id) => typeof id === "string"))]
    : [];
  const activeRows = db.prepare("SELECT id FROM question_candidates WHERE task_id = ? AND review_status != 'rejected'").all(task.id);
  const activeIds = new Set(activeRows.map((row) => row.id));
  if (orderedIds.length !== activeIds.size || orderedIds.some((id) => !activeIds.has(id))) {
    throw new AppError(400, "VALIDATION_ERROR", "排序列表与当前待校对题目不一致，请刷新后重试。");
  }

  const updatedAt = nowIso();
  db.exec("BEGIN");
  try {
    orderedIds.forEach((id, index) => {
      db.prepare("UPDATE question_candidates SET question_number = ?, review_status = 'reviewing', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
        .run(index + 1, req.user.id, updatedAt, updatedAt, id);
    });
    db.prepare("UPDATE import_tasks SET updated_at = ? WHERE id = ?").run(updatedAt, task.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const items = db.prepare("SELECT * FROM question_candidates WHERE task_id = ? ORDER BY question_number").all(task.id).map(toQuestionCandidate);
  res.json(ok({ items }));
});

// 将 AI 错误合并的一道候选题人工拆成 2-5 道。
importRouter.post("/import/pipeline/candidates/:candidateId/split", requireAuth, asyncRoute(async (req, res) => {
  const candidate = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id = ? AND t.user_id = ?
  `).get(req.params.candidateId, req.user.id);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题目候选。");
  if (["confirmed", "rejected"].includes(candidate.review_status)) {
    throw new AppError(409, "VALIDATION_ERROR", "已确认或已排除的题目不能拆分。");
  }
  const parts = Array.isArray(req.body.parts) ? req.body.parts : [];
  if (parts.length < 2 || parts.length > 5) {
    throw new AppError(400, "VALIDATION_ERROR", "拆分结果必须包含 2 至 5 道题。");
  }

  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(candidate.task_id);
  const page = db.prepare("SELECT * FROM import_pages WHERE id = ?").get(candidate.page_id);
  const createdAt = nowIso();
  const created = [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM candidate_crops WHERE candidate_id = ?").run(candidate.id);
    db.prepare("DELETE FROM question_candidates WHERE id = ?").run(candidate.id);
    parts.forEach((part, index) => {
      const fallback = {
        ...candidate,
        question_number: Number(candidate.question_number || 1) + index,
        options_json: index === 0 ? candidate.options_json : "[]",
        reference_answer_text: index === 0 ? candidate.reference_answer_text : "",
        crop_bbox_json: null
      };
      created.push(insertManualCandidate({ task, page, input: part, fallback, createdAt }));
    });
    updateTaskCandidateCount(task.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  cleanupUploadUrls(resolve(config.uploadDir), [candidate.crop_image_url]);
  res.json(ok({ items: created.map(toQuestionCandidate) }));
}));

// 合并 2-5 个被 AI 错误拆开的候选题，可用于跨页题干续接。
importRouter.post("/import/pipeline/candidates/merge", requireAuth, asyncRoute(async (req, res) => {
  const candidateIds = Array.isArray(req.body.candidate_ids)
    ? [...new Set(req.body.candidate_ids.filter((id) => typeof id === "string"))]
    : [];
  if (candidateIds.length < 2 || candidateIds.length > 5) {
    throw new AppError(400, "VALIDATION_ERROR", "请选择 2 至 5 道候选题进行合并。");
  }
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id IN (${placeholders}) AND t.user_id = ?
    ORDER BY c.page_number, c.question_number
  `).all(...candidateIds, req.user.id);
  if (rows.length !== candidateIds.length) {
    throw new AppError(400, "VALIDATION_ERROR", "部分候选题不存在或无权操作。");
  }
  if (new Set(rows.map((row) => row.task_id)).size !== 1) {
    throw new AppError(400, "VALIDATION_ERROR", "只能合并同一次 PDF 导入中的题目。");
  }
  if (rows.some((row) => ["confirmed", "rejected"].includes(row.review_status))) {
    throw new AppError(409, "VALIDATION_ERROR", "已确认或已排除的题目不能合并。");
  }

  const first = rows[0];
  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(first.task_id);
  const page = db.prepare("SELECT * FROM import_pages WHERE id = ?").get(first.page_id);
  const allTags = rows.flatMap((row) => parseJson(row.knowledge_tags_json, []));
  const optionsRow = rows.find((row) => parseJson(row.options_json, []).length > 0);
  const fallback = {
    ...first,
    stem_text: rows.map((row) => row.stem_text).filter(Boolean).join("\n\n"),
    options_json: optionsRow?.options_json || "[]",
    reference_answer_text: rows.map((row) => row.reference_answer_text).filter(Boolean).join("\n"),
    knowledge_tags_json: JSON.stringify(allTags),
    crop_bbox_json: null
  };
  const input = {
    ...req.body,
    question_number: req.body.question_number ?? first.question_number,
    stem_text: req.body.stem_text ?? fallback.stem_text,
    knowledge_tags: Array.isArray(req.body.knowledge_tags) ? req.body.knowledge_tags : allTags
  };

  let merged;
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM candidate_crops WHERE candidate_id IN (${placeholders})`).run(...candidateIds);
    db.prepare(`DELETE FROM question_candidates WHERE id IN (${placeholders})`).run(...candidateIds);
    merged = insertManualCandidate({ task, page, input, fallback });
    updateTaskCandidateCount(task.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  cleanupUploadUrls(resolve(config.uploadDir), rows.map((row) => row.crop_image_url));
  res.json(ok(toQuestionCandidate(merged)));
}));

// ——— 8. 单题重新识别 ———
importRouter.post("/import/pipeline/candidates/:candidateId/re-recognize", requireAuth, asyncRoute(async (req, res) => {
  const candidate = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id = ? AND t.user_id = ?
  `).get(req.params.candidateId, req.user.id);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题目候选。");

  const page = db.prepare("SELECT * FROM import_pages WHERE id = ?").get(candidate.page_id);
  const task = db.prepare("SELECT subject FROM import_tasks WHERE id = ?").get(candidate.task_id);

  ensureAiConfigured();

  const uploadDir = resolve(config.uploadDir);
  // 优先用单题裁切图做精细识别；没有裁切图时退回整页识别再按题号匹配。
  const cropPath = candidate.crop_image_url
    ? resolve(uploadDir, candidate.crop_image_url.replace("/uploads/", ""))
    : null;
  const useCrop = cropPath && existsSync(cropPath);

  const imagePath = useCrop ? cropPath : resolve(uploadDir, page.image_url.replace("/uploads/", ""));
  if (!existsSync(imagePath)) {
    throw new AppError(500, "FILE_ERROR", "页面图片文件丢失。");
  }
  const imageDataUrl = await prepareVisionImageDataUrl(imagePath);

  let matched;
  try {
    if (useCrop) {
      matched = await withAiQuota(req.user.id, () => recognizeSingleQuestion({
        subject: task.subject,
        imageDataUrl,
        questionNumber: candidate.question_number,
        canonicalTags: canonicalTagsForSubject(task.subject)
      }));
    } else {
      const recognition = await withAiQuota(req.user.id, () => recognizePageQuestions({
        subject: task.subject,
        imageDataUrl,
        canonicalTags: canonicalTagsForSubject(task.subject)
      }));
      const questions = Array.isArray(recognition.questions) ? recognition.questions : [];
      matched = questions.find((q) => Number(q.question_number) === candidate.question_number);
    }
  } catch (error) {
    db.prepare("UPDATE question_candidates SET recognition_attempts = recognition_attempts + 1, last_recognition_error = ?, updated_at = ? WHERE id = ?")
      .run(error.message.slice(0, 500), nowIso(), candidate.id);
    throw error;
  }

  if (matched) {
    const knowledgeTags = normalizeKnowledgeTags(task.subject, Array.isArray(matched.knowledge_tags) ? matched.knowledge_tags : []);
    const options = Array.isArray(matched.options) ? matched.options.filter((o) => o && typeof o.label === "string") : [];

    db.prepare(`
      UPDATE question_candidates SET
        stem_text = ?, options_json = ?, reference_answer_text = ?, knowledge_tags_json = ?,
        difficulty = ?, question_type = ?, recognition_confidence = ?,
        recognition_attempts = recognition_attempts + 1,
        last_recognition_error = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(
      typeof matched.stem_text === "string" ? matched.stem_text.trim() : candidate.stem_text,
      options.length ? JSON.stringify(options) : candidate.options_json,
      typeof matched.reference_answer_text === "string" ? matched.reference_answer_text.trim() : candidate.reference_answer_text,
      knowledgeTags.length ? JSON.stringify(knowledgeTags) : candidate.knowledge_tags_json,
      ["easy", "medium", "hard"].includes(matched.difficulty) ? matched.difficulty : candidate.difficulty,
      ["choice", "fill-in-blank", "short-answer"].includes(matched.question_type) ? matched.question_type : candidate.question_type,
      typeof matched.confidence === "number" ? matched.confidence : candidate.recognition_confidence,
      nowIso(),
      candidate.id
    );
  } else {
    db.prepare("UPDATE question_candidates SET recognition_attempts = recognition_attempts + 1, last_recognition_error = ?, updated_at = ? WHERE id = ?")
      .run("AI 未在当前页面图像中匹配到该题号。", nowIso(), candidate.id);
  }

  res.json(ok(toQuestionCandidate(db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(candidate.id))));
}));

// ——— 9. 确认单题入库 ———
importRouter.post("/import/pipeline/candidates/:candidateId/confirm", requireAuth, asyncRoute(async (req, res) => {
  const candidate = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id = ? AND t.user_id = ?
  `).get(req.params.candidateId, req.user.id);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题目候选。");

  if (candidate.review_status === "confirmed") {
    return res.json(ok({ candidate: toQuestionCandidate(candidate), message: "已确认过，无需重复操作。" }));
  }

  const task = db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(candidate.task_id);
  const createdAt = nowIso();
  const questionId = randomUUID();
  const questionNumber = String(candidate.question_number || 1);
  const stemText = requireString(candidate.stem_text || req.body.stem_text, `第 ${questionNumber} 题题干`);
  const answerText = candidate.reference_answer_text || "原 PDF 未附参考答案。提交作答后，AI 将独立推导并给出评阅意见。";
  const questionType = candidate.question_type || "choice";
  const difficulty = candidate.difficulty || "medium";
  const knowledgeTags = parseJson(candidate.knowledge_tags_json, []);
  const confidence = candidate.recognition_confidence;
  const sourceImageUrl = candidate.crop_image_url
    || db.prepare("SELECT image_url FROM import_pages WHERE id = ?").get(candidate.page_id)?.image_url
    || null;

  const title = `${task.source_name.replace(/\.pdf$/i, "")} · 第 ${candidate.page_number} 页第 ${questionNumber} 题`;

  db.exec("BEGIN");
  try {
    const { paperId, collectionId } = ensureImportedLibrary({ task, userId: req.user.id, createdAt });

    db.prepare(`
      INSERT INTO exam_questions (
        id, paper_id, question_number, subject, question_type, content_text,
        official_answer_text, source, knowledge_tags_json, difficulty, status,
        created_at, content_image_url, page_number, source_task_id, confidence, has_figure
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_profile', ?, ?, ?, ?, ?, ?)
    `).run(
      questionId, paperId, questionNumber, task.subject, questionType, stemText,
      answerText, task.source_name, JSON.stringify(knowledgeTags), difficulty,
      createdAt, sourceImageUrl, candidate.page_number, task.id, confidence,
      candidate.has_figure ? 1 : 0
    );

    db.prepare(`
      INSERT INTO practice_questions (
        id, subject, title, source, content_text, official_answer_text,
        knowledge_tags_json, difficulty, created_at, content_image_url, exam_question_id, source_task_id, owner_user_id, has_figure
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `practice-${questionId}`, task.subject, title, task.source_name, stemText,
      answerText, JSON.stringify(knowledgeTags), difficulty, createdAt,
      sourceImageUrl, questionId, task.id, req.user.id,
      candidate.has_figure ? 1 : 0
    );

    db.prepare(`
      INSERT OR IGNORE INTO collection_questions (collection_id, exam_question_id, position)
      VALUES (?, ?, ?)
    `).run(collectionId, questionId, Number(candidate.question_number) || 1);

    db.prepare("UPDATE question_candidates SET review_status = 'confirmed', confirmed_question_id = ?, confirmed_question_type = 'exam', updated_at = ? WHERE id = ?")
      .run(questionId, createdAt, candidate.id);

    // 检查是否所有候选都已确认，是则标记任务完成
    const pendingCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ? AND review_status != 'confirmed' AND review_status != 'rejected'").get(task.id).cnt;
    if (pendingCount === 0) {
      db.prepare("UPDATE import_tasks SET status = 'completed', updated_at = ? WHERE id = ?").run(createdAt, task.id);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  recordEvent(req.user.id, "import_succeeded", { confirmed_count: 1, mode: "single" });

  res.json(ok({
    candidate: toQuestionCandidate(db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(candidate.id)),
    exam_question_id: questionId,
    practice_question_id: `practice-${questionId}`,
    collection_id: `collection-import-${task.id}`
  }));
}));

// ——— 10. 批量确认 ———
importRouter.post("/import/pipeline/candidates/batch-confirm", requireAuth, asyncRoute(async (req, res) => {
  const candidateIds = Array.isArray(req.body.candidate_ids)
    ? [...new Set(req.body.candidate_ids.filter((id) => typeof id === "string"))]
    : [];
  if (candidateIds.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "请选择至少一个候选题目。");
  }

  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id IN (${placeholders}) AND t.user_id = ?
  `).all(...candidateIds, req.user.id);

  if (rows.length !== candidateIds.length) {
    throw new AppError(400, "VALIDATION_ERROR", "部分候选题目不存在或无权操作。");
  }

  const results = [];
  for (const candidate of rows) {
    if (candidate.review_status === "confirmed") {
      results.push({ candidate_id: candidate.id, status: "skipped", reason: "已确认" });
      continue;
    }

    const task = db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(candidate.task_id);
    const createdAt = nowIso();
    const questionId = randomUUID();
    const questionNumber = String(candidate.question_number || 1);
    const stemText = candidate.stem_text || "待补充题干";
    const answerText = candidate.reference_answer_text || "原 PDF 未附参考答案。提交作答后，AI 将独立推导并给出评阅意见。";
    const knowledgeTags = parseJson(candidate.knowledge_tags_json, []);
    const sourceImageUrl = candidate.crop_image_url
      || db.prepare("SELECT image_url FROM import_pages WHERE id = ?").get(candidate.page_id)?.image_url
      || null;

    db.exec("BEGIN");
    try {
      const { paperId, collectionId } = ensureImportedLibrary({ task, userId: req.user.id, createdAt });

      db.prepare(`
        INSERT INTO exam_questions (
          id, paper_id, question_number, subject, question_type, content_text,
          official_answer_text, source, knowledge_tags_json, difficulty, status,
          created_at, content_image_url, page_number, source_task_id, confidence, has_figure
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_profile', ?, ?, ?, ?, ?, ?)
      `).run(
        questionId, paperId, questionNumber, task.subject, candidate.question_type || "choice",
        stemText, answerText, task.source_name, JSON.stringify(knowledgeTags),
        candidate.difficulty || "medium", createdAt,
        sourceImageUrl, candidate.page_number, task.id, candidate.recognition_confidence,
        candidate.has_figure ? 1 : 0
      );

      const title = `${task.source_name.replace(/\.pdf$/i, "")} · 第 ${candidate.page_number} 页第 ${questionNumber} 题`;
      db.prepare(`
        INSERT INTO practice_questions (
          id, subject, title, source, content_text, official_answer_text,
          knowledge_tags_json, difficulty, created_at, content_image_url, exam_question_id, source_task_id, owner_user_id, has_figure
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `practice-${questionId}`, task.subject, title, task.source_name, stemText,
        answerText, JSON.stringify(knowledgeTags), candidate.difficulty || "medium", createdAt,
        sourceImageUrl, questionId, task.id, req.user.id,
        candidate.has_figure ? 1 : 0
      );

      db.prepare(`
        INSERT OR IGNORE INTO collection_questions (collection_id, exam_question_id, position)
        VALUES (?, ?, ?)
      `).run(collectionId, questionId, Number(candidate.question_number) || 1);

      db.prepare("UPDATE question_candidates SET review_status = 'confirmed', confirmed_question_id = ?, confirmed_question_type = 'exam', updated_at = ? WHERE id = ?")
        .run(questionId, createdAt, candidate.id);

      db.exec("COMMIT");
      results.push({ candidate_id: candidate.id, status: "confirmed", exam_question_id: questionId });
    } catch (error) {
      db.exec("ROLLBACK");
      results.push({ candidate_id: candidate.id, status: "failed", error: error.message });
    }
  }

  // 更新任务状态
  for (const row of rows) {
    const task = db.prepare("SELECT id FROM import_tasks WHERE id = ?").get(row.task_id);
    const pendingCount = db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ? AND review_status NOT IN ('confirmed','rejected')").get(task.id).cnt;
    if (pendingCount === 0) {
      db.prepare("UPDATE import_tasks SET status = 'completed', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
    }
  }

  recordEvent(req.user.id, "import_succeeded", {
    confirmed_count: results.filter((item) => item.status === "confirmed").length,
    failed_count: results.filter((item) => item.status === "failed").length
  });

  res.json(ok({ results }));
}));

// ——— 11. 拒绝候选 ———
importRouter.post("/import/pipeline/candidates/:candidateId/reject", requireAuth, (req, res) => {
  const candidate = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id = ? AND t.user_id = ?
  `).get(req.params.candidateId, req.user.id);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题目候选。");

  const notes = typeof req.body.review_notes === "string" ? req.body.review_notes.trim() : "";
  db.prepare("UPDATE question_candidates SET review_status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_notes = ?, updated_at = ? WHERE id = ?")
    .run(req.user.id, nowIso(), notes, nowIso(), candidate.id);

  const pendingCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM question_candidates
    WHERE task_id = ? AND review_status NOT IN ('confirmed', 'rejected')
  `).get(candidate.task_id).cnt;
  if (pendingCount === 0) {
    db.prepare("UPDATE import_tasks SET status = 'completed', updated_at = ? WHERE id = ?")
      .run(nowIso(), candidate.task_id);
  }

  res.json(ok(toQuestionCandidate(db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(candidate.id))));
});

// ——— 12. 获取候选的页面裁切图 URL（供前端展示用）———
importRouter.get("/import/pipeline/candidates/:candidateId/page-image", requireAuth, (req, res) => {
  const candidate = db.prepare(`
    SELECT c.* FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.id = ? AND t.user_id = ?
  `).get(req.params.candidateId, req.user.id);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题目候选。");

  const page = db.prepare("SELECT image_url FROM import_pages WHERE id = ?").get(candidate.page_id);
  const bbox = candidate.crop_bbox_json ? parseJson(candidate.crop_bbox_json, null) : null;

  res.json(ok({
    page_image_url: page ? page.image_url : null,
    bbox
  }));
});

// ——— 13. 拍照导入：识别 ———
// 上传一张题目照片 → 视觉 AI 识别为结构化草稿（不入库），供前端确认/修改。
// 照片与 AI 原始结果存入 photo_uploads：归属校验 + 未来微调语料。
importRouter.post("/import/photo/recognize", requireAuth, asyncRoute(async (req, res) => {
  ensureAiConfigured();
  const subject = requireString(req.body.subject || "数学", "学科");
  const dataBase64 = requireString(req.body.image_base64, "题目照片");
  const buffer = Buffer.from(dataBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
    throw new AppError(400, "VALIDATION_ERROR", "请上传不超过 10MB 的题目照片。");
  }

  const uploadDir = resolve(config.uploadDir);
  const photoId = randomUUID();
  const fileName = `photo-${photoId}.jpg`;
  // 统一转成校正方向后的 JPEG，同时防御伪装成图片的任意文件
  let normalized;
  try {
    normalized = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "无法读取这张图片，请换一张清晰的题目照片。");
  }
  writeFileSync(resolve(uploadDir, fileName), normalized);
  const imageUrl = `/uploads/${fileName}`;

  let draft;
  try {
    draft = await withAiQuota(req.user.id, () => recognizePhotoQuestion({
      subject,
      imageDataUrl: `data:image/jpeg;base64,${normalized.toString("base64")}`,
      canonicalTags: canonicalTagsForSubject(subject)
    }));
  } catch (error) {
    cleanupUploadUrls(uploadDir, [imageUrl]);
    throw error;
  }

  db.prepare(`
    INSERT INTO photo_uploads (id, user_id, image_url, subject, ai_result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(photoId, req.user.id, imageUrl, subject, JSON.stringify(draft), nowIso());

  res.json(ok({
    photo_id: photoId,
    image_url: imageUrl,
    draft: {
      stem_text: typeof draft.stem_text === "string" ? draft.stem_text : "",
      options: draft.options,
      reference_answer_text: typeof draft.reference_answer_text === "string" ? draft.reference_answer_text : "",
      knowledge_tags: normalizeKnowledgeTags(subject, draft.knowledge_tags),
      difficulty: ["easy", "medium", "hard"].includes(draft.difficulty) ? draft.difficulty : "medium",
      question_type: ["choice", "fill-in-blank", "short-answer"].includes(draft.question_type) ? draft.question_type : "choice",
      has_figure: Boolean(draft.has_figure),
      confidence: typeof draft.confidence === "number" ? draft.confidence : 0.7
    }
  }));
}));

// ——— 14. 拍照导入：确认入库 ———
// 用户校对后的最终稿入库到「拍照导入 · 学科」个人题库；与 AI 原始识别的差异即微调语料。
importRouter.post("/import/photo/confirm", requireAuth, asyncRoute(async (req, res) => {
  const photo = db.prepare("SELECT * FROM photo_uploads WHERE id = ? AND user_id = ?")
    .get(requireString(req.body.photo_id, "照片标识"), req.user.id);
  if (!photo) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这张题目照片，请重新拍照识别。");
  if (photo.confirmed_question_id) {
    throw new AppError(409, "VALIDATION_ERROR", "这张照片已经入库，请不要重复确认。");
  }

  const stemText = requireString(req.body.stem_text, "题目内容");
  const subject = photo.subject;
  const knowledgeTags = normalizeKnowledgeTags(subject, Array.isArray(req.body.knowledge_tags) ? req.body.knowledge_tags : []);
  const options = Array.isArray(req.body.options) ? req.body.options.filter((o) => o && typeof o.label === "string") : [];
  const difficulty = ["easy", "medium", "hard"].includes(req.body.difficulty) ? req.body.difficulty : "medium";
  const questionType = ["choice", "fill-in-blank", "short-answer"].includes(req.body.question_type) ? req.body.question_type : "choice";
  const answerText = typeof req.body.reference_answer_text === "string" && req.body.reference_answer_text.trim()
    ? req.body.reference_answer_text.trim()
    : "拍照导入未附参考答案。提交作答后，AI 将独立推导并给出评阅意见。";
  const hasFigure = req.body.has_figure === false ? 0 : 1; // 拍照题默认含图（原图就是照片）

  const createdAt = nowIso();
  const questionId = randomUUID();
  // ID 只用 ASCII：中文学科名进 URL 会给客户端和工具链埋坑
  const subjectSlugs = { "数学": "math", "物理": "physics", "化学": "chemistry", "生物": "biology", "语文": "chinese", "英语": "english", "历史": "history", "地理": "geography", "政治": "politics" };
  const subjectSlug = subjectSlugs[subject] || Buffer.from(subject).toString("hex");
  const paperId = `paper-photo-${req.user.id}-${subjectSlug}`;
  const collectionId = `collection-photo-${req.user.id}-${subjectSlug}`;
  const questionNumber = String(
    db.prepare("SELECT COUNT(*) AS cnt FROM exam_questions WHERE paper_id = ?").get(paperId).cnt + 1
  );

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT OR IGNORE INTO exam_papers (
        id, year, region, subject, title, source_name, source_url, license_note,
        status, created_at, owner_user_id, import_kind
      ) VALUES (?, ?, '个人题库', ?, ?, '拍照导入', NULL, '用户拍照上传，仅用于个人学习。', 'draft', ?, ?, 'photo')
    `).run(paperId, new Date().getFullYear(), subject, `拍照导入 · ${subject}`, createdAt, req.user.id);

    db.prepare(`
      INSERT OR IGNORE INTO question_collections (
        id, user_id, title, description, subject, creation_mode, cover_style, source_paper_id, created_at
      ) VALUES (?, ?, ?, '手机拍照识别并确认入库的题目', ?, 'photo', 'clay', ?, ?)
    `).run(collectionId, req.user.id, `拍照导入 · ${subject}`, subject, paperId, createdAt);

    db.prepare(`
      INSERT INTO exam_questions (
        id, paper_id, question_number, subject, question_type, content_text,
        official_answer_text, source, knowledge_tags_json, difficulty, status,
        created_at, content_image_url, source_task_id, has_figure
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '拍照导入', ?, ?, 'needs_profile', ?, ?, NULL, ?)
    `).run(
      questionId, paperId, questionNumber, subject, questionType, stemText,
      answerText, JSON.stringify(knowledgeTags), difficulty, createdAt, photo.image_url, hasFigure
    );

    db.prepare(`
      INSERT INTO practice_questions (
        id, subject, title, source, content_text, official_answer_text,
        knowledge_tags_json, difficulty, created_at, content_image_url, exam_question_id, owner_user_id, has_figure
      ) VALUES (?, ?, ?, '拍照导入', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `practice-${questionId}`, subject, `拍照导入 · ${subject} · 第 ${questionNumber} 题`,
      stemText, answerText, JSON.stringify(knowledgeTags), difficulty, createdAt,
      photo.image_url, questionId, req.user.id, hasFigure
    );

    db.prepare("INSERT OR IGNORE INTO collection_questions (collection_id, exam_question_id, position) VALUES (?, ?, ?)")
      .run(collectionId, questionId, Number(questionNumber));

    db.prepare("UPDATE photo_uploads SET confirmed_question_id = ? WHERE id = ?").run(questionId, photo.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  res.json(ok({
    exam_question_id: questionId,
    practice_question_id: `practice-${questionId}`,
    collection_id: collectionId
  }));
}));
