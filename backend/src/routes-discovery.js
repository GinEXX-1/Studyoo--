import { randomUUID } from "node:crypto";
import express from "express";
import { requireAdmin, requireAuth } from "./auth.js";
import { config } from "./config.js";
import { db, normalizeKnowledgeTags, nowIso, parseJson, recordEvent } from "./db.js";
import { AppError, asyncRoute, fail, ok } from "./http.js";

export const discoveryRouter = express.Router();

function discoveryQuestion(questionId, userId) {
  return db.prepare(`
    SELECT q.*, p.title AS paper_title, p.source_name, p.source_url, p.import_kind,
      p.owner_user_id, p.is_shared, u.nickname AS contributor,
      ROUND(AVG(r.rating), 1) AS average_rating, COUNT(r.rating) AS rating_count,
      MAX(CASE WHEN r.user_id = ? THEN r.rating END) AS my_rating,
      EXISTS(
        SELECT 1 FROM collection_questions cq
        JOIN question_collections c ON c.id = cq.collection_id
        WHERE cq.exam_question_id = q.id AND c.user_id = ?
      ) AS is_saved
    FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    LEFT JOIN users u ON u.id = p.owner_user_id
    LEFT JOIN discovery_ratings r ON r.exam_question_id = q.id
    WHERE q.id = ? AND (p.owner_user_id IS NULL OR p.is_shared = 1)
    GROUP BY q.id
  `).get(userId, userId, questionId);
}

function toDiscoveryItem(row) {
  return {
    id: row.id,
    subject: row.subject,
    question_number: row.question_number,
    question_type: row.question_type,
    content_text: row.content_text,
    content_image_url: row.content_image_url || null,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    difficulty: row.difficulty,
    paper_title: row.paper_title,
    source_name: row.source_name,
    source_url: row.source_url || null,
    source_type: row.import_kind === "web" ? "web" : (row.owner_user_id ? "community" : "official"),
    contributor: row.import_kind === "web" ? null : (row.contributor || null),
    average_rating: Number(row.average_rating || 0),
    rating_count: Number(row.rating_count || 0),
    my_rating: Number(row.my_rating || 0),
    is_saved: Boolean(row.is_saved),
    created_at: row.created_at
  };
}

discoveryRouter.get("/discover", requireAuth, (req, res) => {
  const subject = typeof req.query.subject === "string" && req.query.subject !== "全部" ? req.query.subject : null;
  const sourceType = ["official", "community", "web"].includes(req.query.source) ? req.query.source : null;
  const params = [req.user.id, req.user.id];
  const filters = ["(p.owner_user_id IS NULL OR p.is_shared = 1)"];
  if (subject) {
    filters.push("q.subject = ?");
    params.push(subject);
  }
  if (sourceType === "community") filters.push("p.owner_user_id IS NOT NULL AND p.is_shared = 1 AND COALESCE(p.import_kind, 'manual') != 'web'");
  if (sourceType === "official") filters.push("p.owner_user_id IS NULL AND COALESCE(p.import_kind, 'manual') != 'web'");
  if (sourceType === "web") filters.push("p.import_kind = 'web'");
  const rows = db.prepare(`
    SELECT q.*, p.title AS paper_title, p.source_name, p.source_url, p.import_kind,
      p.owner_user_id, p.is_shared, u.nickname AS contributor,
      ROUND(AVG(r.rating), 1) AS average_rating, COUNT(r.rating) AS rating_count,
      MAX(CASE WHEN r.user_id = ? THEN r.rating END) AS my_rating,
      EXISTS(
        SELECT 1 FROM collection_questions cq
        JOIN question_collections c ON c.id = cq.collection_id
        WHERE cq.exam_question_id = q.id AND c.user_id = ?
      ) AS is_saved
    FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    LEFT JOIN users u ON u.id = p.owner_user_id
    LEFT JOIN discovery_ratings r ON r.exam_question_id = q.id
    WHERE ${filters.join(" AND ")}
    GROUP BY q.id
    ORDER BY q.created_at DESC, average_rating DESC
    LIMIT 120
  `).all(...params);
  res.json(ok({ items: rows.map(toDiscoveryItem) }));
});

discoveryRouter.post("/discover/:questionId/rating", requireAuth, (req, res) => {
  const question = discoveryQuestion(req.params.questionId, req.user.id);
  if (!question) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道新发现题目。");
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return fail(res, 400, "VALIDATION_ERROR", "评分应为 1-5 分。");
  }
  const comment = typeof req.body.comment === "string" ? req.body.comment.trim().slice(0, 300) : null;
  const now = nowIso();
  db.prepare(`
    INSERT INTO discovery_ratings (user_id, exam_question_id, rating, comment, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, exam_question_id) DO UPDATE SET
      rating = excluded.rating, comment = excluded.comment, updated_at = excluded.updated_at
  `).run(req.user.id, question.id, rating, comment || null, now, now);
  recordEvent(req.user.id, "discovery_rated", { question_id: question.id, rating });
  res.json(ok(toDiscoveryItem(discoveryQuestion(question.id, req.user.id))));
});

discoveryRouter.post("/discover/:questionId/save", requireAuth, (req, res) => {
  const question = discoveryQuestion(req.params.questionId, req.user.id);
  if (!question) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道新发现题目。");
  let collection = db.prepare(`
    SELECT * FROM question_collections
    WHERE user_id = ? AND subject = ? AND creation_mode = 'discovery'
    ORDER BY created_at ASC LIMIT 1
  `).get(req.user.id, question.subject);
  if (!collection) {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO question_collections (
        id, user_id, title, description, subject, creation_mode, cover_style, created_at
      ) VALUES (?, ?, ?, ?, ?, 'discovery', 'mint', ?)
    `).run(id, req.user.id, `新发现 · ${question.subject}`, "从新发现中收藏的优质题目。", question.subject, nowIso());
    collection = db.prepare("SELECT * FROM question_collections WHERE id = ?").get(id);
  }
  const position = Number(db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM collection_questions WHERE collection_id = ?").get(collection.id).position);
  db.prepare("INSERT OR IGNORE INTO collection_questions (collection_id, exam_question_id, position) VALUES (?, ?, ?)")
    .run(collection.id, question.id, position);
  recordEvent(req.user.id, "discovery_saved", { question_id: question.id, collection_id: collection.id });
  res.json(ok({ collection_id: collection.id, question_id: question.id, saved: true }));
});

discoveryRouter.post("/admin/discovery/fetch-preview", requireAdmin, asyncRoute(async (req, res) => {
  let url;
  try {
    url = new URL(req.body.url);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "网页地址不合法。");
  }
  if (url.protocol !== "https:" || !config.discoveryAllowedHosts.includes(url.hostname.toLowerCase())) {
    throw new AppError(403, "SOURCE_NOT_ALLOWED", "该域名未加入 DISCOVERY_ALLOWED_HOSTS 白名单。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "StudyooContentCollector/1.0 (+https://studyoo.space)" }
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new AppError(502, "SOURCE_FETCH_FAILED", `来源网页返回 HTTP ${response.status}。`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) throw new AppError(400, "SOURCE_TYPE_UNSUPPORTED", "目前只支持 HTML 题目页面。");
  const html = (await response.text()).slice(0, 2_000_000);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || url.hostname;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30000);
  res.json(ok({ url: url.toString(), title, text, fetched_at: nowIso() }));
}));

discoveryRouter.post("/admin/discovery/import", requireAdmin, (req, res) => {
  const subject = typeof req.body.subject === "string" ? req.body.subject.trim() : "";
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const sourceUrl = typeof req.body.source_url === "string" ? req.body.source_url.trim() : "";
  const questions = Array.isArray(req.body.questions) ? req.body.questions.slice(0, 50) : [];
  if (!subject || !title || !sourceUrl || !questions.length) {
    return fail(res, 400, "VALIDATION_ERROR", "来源、标题、学科和题目不能为空。");
  }
  let source;
  try {
    source = new URL(sourceUrl);
  } catch {
    return fail(res, 400, "VALIDATION_ERROR", "来源网页地址不合法。");
  }
  if (!["http:", "https:"].includes(source.protocol)) {
    return fail(res, 400, "VALIDATION_ERROR", "来源网页必须使用 HTTP 或 HTTPS。");
  }
  const normalized = questions.map((item, index) => ({
    id: randomUUID(),
    number: String(item.question_number || index + 1),
    type: typeof item.question_type === "string" ? item.question_type.trim() : "未标注",
    content: typeof item.content_text === "string" ? item.content_text.trim() : "",
    answer: typeof item.official_answer_text === "string" && item.official_answer_text.trim()
      ? item.official_answer_text.trim()
      : "原网页未附参考答案，请先独立推导。",
    tags: normalizeKnowledgeTags(subject, item.knowledge_tags),
    difficulty: ["easy", "medium", "hard"].includes(item.difficulty) ? item.difficulty : "medium"
  }));
  if (normalized.some((item) => !item.content)) return fail(res, 400, "VALIDATION_ERROR", "每道题都必须包含题目内容。");
  const paperId = randomUUID();
  const createdAt = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO exam_papers (
        id, year, region, subject, title, source_name, source_url, license_note,
        status, created_at, owner_user_id, is_shared, import_kind
      ) VALUES (?, ?, '网络', ?, ?, ?, ?, '仅收录公开可访问题目文本，保留原始来源链接。', 'published', ?, ?, 1, 'web')
    `).run(paperId, new Date().getFullYear(), subject, title, source.hostname, sourceUrl, createdAt, req.user.id);
    for (const item of normalized) {
      db.prepare(`
        INSERT INTO exam_questions (
          id, paper_id, question_number, subject, question_type, content_text,
          official_answer_text, source, knowledge_tags_json, difficulty, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_profile', ?)
      `).run(item.id, paperId, item.number, subject, item.type, item.content, item.answer, title, JSON.stringify(item.tags), item.difficulty, createdAt);
      db.prepare(`
        INSERT INTO practice_questions (
          id, subject, title, source, content_text, official_answer_text,
          knowledge_tags_json, difficulty, created_at, exam_question_id, owner_user_id, is_shared
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(`practice-${item.id}`, subject, `${title} · 第 ${item.number} 题`, title, item.content, item.answer, JSON.stringify(item.tags), item.difficulty, createdAt, item.id, req.user.id);
    }
    db.prepare(`
      INSERT INTO ingestion_jobs (id, source_name, source_url, status, message, imported_count, created_at)
      VALUES (?, ?, ?, 'completed', ?, ?, ?)
    `).run(randomUUID(), title, sourceUrl, `网页采集完成：${normalized.length} 题已进入新发现。`, normalized.length, createdAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  recordEvent(req.user.id, "discovery_imported", { paper_id: paperId, count: normalized.length, source_url: sourceUrl });
  res.status(201).json(ok({ paper_id: paperId, imported_count: normalized.length }));
});
