import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const port = "3203";
const databasePath = "/tmp/studyoo-import-editing-test.db";
const base = `http://localhost:${port}/api/v1`;
const child = spawn("node", ["--no-warnings", "src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: port, DATABASE_PATH: databasePath, JWT_SECRET: "import-editing-test-secret" },
  stdio: "ignore"
});
let pageImagePath;
let cropImagePath;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}
function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exitCode = 1;
  } else {
    console.log("PASS:", message);
  }
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error("测试服务未能启动。");

  const suffix = Date.now();
  const ownerData = (await request("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `editor_${suffix}`, password: "123456", grade: "高三" }) })).payload.data;
  const otherData = (await request("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `other_${suffix}`, password: "123456", grade: "高三" }) })).payload.data;
  const taskId = `edit-task-${suffix}`;
  const pageId = `edit-page-${suffix}`;
  const mergedId = `merged-${suffix}`;
  const tailId = `tail-${suffix}`;
  const pageImageName = `editing-page-${suffix}.png`;
  pageImagePath = fileURLToPath(new URL(`../uploads/${pageImageName}`, import.meta.url));
  await sharp({ create: { width: 600, height: 800, channels: 3, background: "white" } }).png().toFile(pageImagePath);
  const now = new Date().toISOString();
  const db = new DatabaseSync(databasePath);
  db.prepare(`INSERT INTO import_tasks (id, user_id, subject, source_name, status, total_pages, processed_pages, question_count, created_at, updated_at) VALUES (?, ?, '数学', 'editing.pdf', 'awaiting_review', 1, 1, 2, ?, ?)`)
    .run(taskId, ownerData.user.id, now, now);
  db.prepare(`INSERT INTO import_pages (id, task_id, page_number, image_url, render_status, ocr_status, created_at) VALUES (?, ?, 1, ?, 'rendered', 'processed', ?)`)
    .run(pageId, taskId, `/uploads/${pageImageName}`, now);
  const insertCandidate = db.prepare(`INSERT INTO question_candidates (id, task_id, page_id, page_number, question_number, subject, stem_text, options_json, reference_answer_text, knowledge_tags_json, difficulty, question_type, recognition_confidence, requires_manual_review, review_status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, '数学', ?, '[]', '', '["函数"]', 'medium', 'short-answer', .7, 1, 'pending', ?, ?)`);
  insertCandidate.run(mergedId, taskId, pageId, 1, "第一题和第二题被合并", now, now);
  insertCandidate.run(tailId, taskId, pageId, 3, "第三题", now, now);

  const pdfFixturePath = fileURLToPath(new URL("../uploads/2026-national-1.pdf", import.meta.url));
  const textTaskId = `text-task-${suffix}`;
  if (existsSync(pdfFixturePath)) {
    db.prepare(`INSERT INTO import_tasks (id, user_id, subject, source_name, pdf_filename, status, total_pages, processed_pages, question_count, created_at, updated_at) VALUES (?, ?, '数学', '2026-national-1.pdf', '2026-national-1.pdf', 'uploaded', 5, 0, 0, ?, ?)`)
      .run(textTaskId, ownerData.user.id, now, now);
    const insertPage = db.prepare(`INSERT INTO import_pages (id, task_id, page_number, image_url, render_status, ocr_status, created_at) VALUES (?, ?, ?, ?, 'rendered', 'pending', ?)`);
    for (let pageNumber = 1; pageNumber <= 5; pageNumber++) {
      insertPage.run(`text-page-${suffix}-${pageNumber}`, textTaskId, pageNumber, `/uploads/text-page-${pageNumber}.png`, now);
    }
  }
  db.close();

  if (existsSync(pdfFixturePath)) {
    const textStartedAt = Date.now();
    const localTextResult = await request(`/import/pipeline/tasks/${textTaskId}/process-all`, { method: "POST", token: ownerData.token });
    const textElapsedMs = Date.now() - textStartedAt;
    const textDetail = await request(`/import/pipeline/tasks/${textTaskId}`, { token: ownerData.token });
    assert(localTextResult.payload?.data?.mode === "pdf_text", "数字版 PDF 优先使用本地文字层");
    assert(textDetail.payload?.data?.candidates?.length === 19, "数学基准卷稳定识别 19 道题");
    assert(textDetail.payload?.data?.integrity?.missing_question_numbers?.length === 0, "数学基准卷不再漏掉第 9 题");
    assert(textElapsedMs < 3000, "本地文字层处理在 3 秒内完成");
  }

  const deniedAdd = await request(`/import/pipeline/pages/${pageId}/candidates`, { method: "POST", token: otherData.token, body: JSON.stringify({ question_number: 4, stem_text: "越权补题" }) });
  assert(deniedAdd.status === 404, "其他用户不能向该页面补题");

  const added = await request(`/import/pipeline/pages/${pageId}/candidates`, { method: "POST", token: ownerData.token, body: JSON.stringify({ question_number: 4, stem_text: "人工补录第四题", question_type: "short-answer", crop_bbox_json: { x: 10, y: 20, width: 50, height: 25 } }) });
  assert(added.status === 201 && added.payload?.data?.question_number === 4, "可人工补录漏题");
  const cropFileName = added.payload?.data?.crop_image_url?.replace("/uploads/", "");
  cropImagePath = cropFileName ? fileURLToPath(new URL(`../uploads/${cropFileName}`, import.meta.url)) : null;
  assert(cropImagePath && existsSync(cropImagePath), "框选补题会生成真实裁切图");

  const split = await request(`/import/pipeline/candidates/${mergedId}/split`, { method: "POST", token: ownerData.token, body: JSON.stringify({ parts: [{ question_number: 1, stem_text: "第一题" }, { question_number: 2, stem_text: "第二题" }] }) });
  assert(split.status === 200 && split.payload?.data?.items?.length === 2, "可将候选题拆分为两题");

  const completeDetail = await request(`/import/pipeline/tasks/${taskId}`, { token: ownerData.token });
  assert(completeDetail.payload?.data?.integrity?.missing_question_numbers?.length === 0, "补题并拆分后题号完整性检查通过");

  const splitIds = split.payload.data.items.map((item) => item.id);
  const merged = await request("/import/pipeline/candidates/merge", { method: "POST", token: ownerData.token, body: JSON.stringify({ candidate_ids: splitIds }) });
  assert(merged.status === 200 && merged.payload?.data?.stem_text.includes("第一题") && merged.payload.data.stem_text.includes("第二题"), "可合并候选题并保留题干");

  const detail = await request(`/import/pipeline/tasks/${taskId}`, { token: ownerData.token });
  assert(detail.payload?.data?.task?.question_count === 3, "拆分与合并后任务题目计数保持一致");

  const beforeOrder = detail.payload.data.candidates.filter((item) => item.review_status !== "rejected");
  const reversedIds = [...beforeOrder].reverse().map((item) => item.id);
  const reordered = await request(`/import/pipeline/tasks/${taskId}/candidates/reorder`, { method: "POST", token: ownerData.token, body: JSON.stringify({ candidate_ids: reversedIds }) });
  assert(reordered.status === 200 && reordered.payload?.data?.items?.filter((item) => item.review_status !== "rejected").map((item) => item.question_number).join(",") === "1,2,3", "拖动排序后题号连续重排");
  assert(reordered.payload?.data?.items?.[0]?.id === reversedIds[0], "排序结果与提交顺序一致");

  console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
} finally {
  if (pageImagePath) try { unlinkSync(pageImagePath); } catch {}
  if (cropImagePath) try { unlinkSync(cropImagePath); } catch {}
  child.kill();
}
