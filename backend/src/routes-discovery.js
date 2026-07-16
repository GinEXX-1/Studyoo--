import { randomUUID } from "node:crypto";
import express from "express";
import { requireAdmin, requireAuth } from "./auth.js";
import { db, normalizeKnowledgeTags, nowIso, parseJson, recordEvent } from "./db.js";
import { AppError, fail, ok } from "./http.js";
import { ensureAiConfigured } from "./ai.js";
import { runCrawlJob, validateCrawlUrl } from "./web-crawler.js";

export const discoveryRouter = express.Router();
const supportedSubjects = new Set(["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"]);

function toCrawlJob(row) {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
    FROM discovery_candidates WHERE job_id = ?
  `).get(row.id);
  return {
    id: row.id,
    seed_url: row.seed_url,
    subject: row.subject,
    max_pages: row.max_pages,
    status: row.status,
    pages_crawled: row.pages_crawled,
    candidates_found: row.candidates_found,
    error_message: row.error_message || null,
    candidate_counts: {
      total: Number(counts.total || 0),
      pending: Number(counts.pending || 0),
      approved: Number(counts.approved || 0),
      rejected: Number(counts.rejected || 0)
    },
    created_at: row.created_at,
    completed_at: row.completed_at || null
  };
}

function toCrawlCandidate(row) {
  return {
    id: row.id,
    job_id: row.job_id,
    source_url: row.source_url,
    page_title: row.page_title,
    question_number: row.question_number,
    question_type: row.question_type,
    content_text: row.content_text,
    official_answer_text: row.official_answer_text || "",
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    difficulty: row.difficulty,
    confidence: Number(row.confidence || 0),
    status: row.status,
    review_note: row.review_note || "",
    published_question_id: row.published_question_id || null,
    created_at: row.created_at
  };
}

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

discoveryRouter.post("/admin/discovery/crawl", requireAdmin, (req, res) => {
  const url = validateCrawlUrl(req.body.url);
  const subject = typeof req.body.subject === "string" ? req.body.subject.trim() : "";
  if (!supportedSubjects.has(subject)) {
    return fail(res, 400, "VALIDATION_ERROR", "请选择有效学科。");
  }
  ensureAiConfigured();
  const maxPages = Math.max(1, Math.min(5, Number.parseInt(req.body.max_pages, 10) || 3));
  const active = db.prepare(`
    SELECT id FROM discovery_crawl_jobs
    WHERE user_id = ? AND seed_url = ? AND status IN ('queued', 'running')
  `).get(req.user.id, url.href);
  if (active) return fail(res, 409, "CRAWL_ALREADY_RUNNING", "这个网址已有爬取任务正在进行。");

  const id = randomUUID();
  db.prepare(`
    INSERT INTO discovery_crawl_jobs (id, user_id, seed_url, subject, max_pages, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?)
  `).run(id, req.user.id, url.href, subject, maxPages, nowIso());
  queueMicrotask(() => runCrawlJob(id));
  res.status(202).json(ok({ job: toCrawlJob(db.prepare("SELECT * FROM discovery_crawl_jobs WHERE id = ?").get(id)) }));
});

discoveryRouter.get("/admin/discovery/crawl-jobs", requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT * FROM discovery_crawl_jobs ORDER BY created_at DESC LIMIT 30").all();
  res.json(ok({ items: rows.map(toCrawlJob) }));
});

discoveryRouter.get("/admin/discovery/crawl-jobs/:jobId", requireAdmin, (req, res) => {
  const job = db.prepare("SELECT * FROM discovery_crawl_jobs WHERE id = ?").get(req.params.jobId);
  if (!job) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个爬取任务。");
  const candidates = db.prepare("SELECT * FROM discovery_candidates WHERE job_id = ? ORDER BY created_at, question_number").all(job.id);
  res.json(ok({ job: toCrawlJob(job), candidates: candidates.map(toCrawlCandidate) }));
});

discoveryRouter.patch("/admin/discovery/candidates/:candidateId", requireAdmin, (req, res) => {
  const candidate = db.prepare("SELECT * FROM discovery_candidates WHERE id = ?").get(req.params.candidateId);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道候选题。");
  if (candidate.status !== "pending") return fail(res, 409, "REVIEW_ALREADY_FINISHED", "已审核的候选题不能再编辑。");
  const job = db.prepare("SELECT * FROM discovery_crawl_jobs WHERE id = ?").get(candidate.job_id);
  const content = typeof req.body.content_text === "string" ? req.body.content_text.trim() : candidate.content_text;
  if (!content) return fail(res, 400, "VALIDATION_ERROR", "题目内容不能为空。");
  const answer = typeof req.body.official_answer_text === "string" ? req.body.official_answer_text.trim() : candidate.official_answer_text;
  const difficulty = ["easy", "medium", "hard"].includes(req.body.difficulty) ? req.body.difficulty : candidate.difficulty;
  const tags = Array.isArray(req.body.knowledge_tags)
    ? normalizeKnowledgeTags(job.subject, req.body.knowledge_tags)
    : parseJson(candidate.knowledge_tags_json, []);
  db.prepare(`
    UPDATE discovery_candidates SET
      question_number = ?, question_type = ?, content_text = ?, official_answer_text = ?,
      knowledge_tags_json = ?, difficulty = ?, review_note = ?
    WHERE id = ?
  `).run(
    String(req.body.question_number || candidate.question_number).trim().slice(0, 30),
    String(req.body.question_type || candidate.question_type).trim().slice(0, 30),
    content, answer || null, JSON.stringify(tags), difficulty,
    typeof req.body.review_note === "string" ? req.body.review_note.trim().slice(0, 500) : candidate.review_note,
    candidate.id
  );
  res.json(ok(toCrawlCandidate(db.prepare("SELECT * FROM discovery_candidates WHERE id = ?").get(candidate.id))));
});

function publishCandidate(candidate, reviewerId) {
  const job = db.prepare("SELECT * FROM discovery_crawl_jobs WHERE id = ?").get(candidate.job_id);
  const duplicate = db.prepare(`
    SELECT q.id FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    WHERE p.import_kind = 'web' AND q.content_text = ? LIMIT 1
  `).get(candidate.content_text);
  if (duplicate) throw new AppError(409, "DUPLICATE_QUESTION", "这道题已经发布过，请拒绝重复候选。");
  let paperId = job.published_paper_id;
  const createdAt = nowIso();
  db.exec("BEGIN");
  try {
    if (!paperId) {
      paperId = randomUUID();
      const source = new URL(job.seed_url);
      db.prepare(`
        INSERT INTO exam_papers (
          id, year, region, subject, title, source_name, source_url, license_note,
          status, created_at, owner_user_id, is_shared, import_kind
        ) VALUES (?, ?, '网络', ?, ?, ?, ?, '自动采集后经管理员人工审核发布，保留原始来源链接。', 'published', ?, ?, 1, 'web')
      `).run(paperId, new Date().getFullYear(), job.subject, candidate.page_title, source.hostname, job.seed_url, createdAt, reviewerId);
      db.prepare("UPDATE discovery_crawl_jobs SET published_paper_id = ? WHERE id = ?").run(paperId, job.id);
    }
    const questionId = randomUUID();
    const tags = parseJson(candidate.knowledge_tags_json, []);
    const answer = candidate.official_answer_text || "原网页未附参考答案，请先独立推导。";
    db.prepare(`
      INSERT INTO exam_questions (
        id, paper_id, question_number, subject, question_type, content_text,
        official_answer_text, source, knowledge_tags_json, difficulty, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_profile', ?)
    `).run(questionId, paperId, candidate.question_number, job.subject, candidate.question_type, candidate.content_text,
      answer, candidate.page_title, JSON.stringify(tags), candidate.difficulty, createdAt);
    db.prepare(`
      INSERT INTO practice_questions (
        id, subject, title, source, content_text, official_answer_text,
        knowledge_tags_json, difficulty, created_at, exam_question_id, owner_user_id, is_shared
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(`practice-${questionId}`, job.subject, `${candidate.page_title} · 第 ${candidate.question_number} 题`,
      candidate.page_title, candidate.content_text, answer, JSON.stringify(tags), candidate.difficulty, createdAt, questionId, reviewerId);
    db.prepare(`
      UPDATE discovery_candidates SET status = 'approved', reviewed_at = ?, reviewed_by = ?, published_question_id = ? WHERE id = ?
    `).run(createdAt, reviewerId, questionId, candidate.id);
    db.exec("COMMIT");
    return questionId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function finishReviewIfComplete(jobId) {
  const pending = db.prepare("SELECT COUNT(*) AS count FROM discovery_candidates WHERE job_id = ? AND status = 'pending'").get(jobId).count;
  if (!pending) db.prepare("UPDATE discovery_crawl_jobs SET status = 'completed' WHERE id = ?").run(jobId);
}

discoveryRouter.post("/admin/discovery/candidates/:candidateId/approve", requireAdmin, (req, res) => {
  const candidate = db.prepare("SELECT * FROM discovery_candidates WHERE id = ?").get(req.params.candidateId);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道候选题。");
  if (candidate.status !== "pending") return fail(res, 409, "REVIEW_ALREADY_FINISHED", "这道候选题已经审核过了。");
  const questionId = publishCandidate(candidate, req.user.id);
  finishReviewIfComplete(candidate.job_id);
  recordEvent(req.user.id, "discovery_imported", { job_id: candidate.job_id, question_id: questionId, source_url: candidate.source_url });
  res.status(201).json(ok(toCrawlCandidate(db.prepare("SELECT * FROM discovery_candidates WHERE id = ?").get(candidate.id))));
});

discoveryRouter.post("/admin/discovery/candidates/:candidateId/reject", requireAdmin, (req, res) => {
  const candidate = db.prepare("SELECT * FROM discovery_candidates WHERE id = ?").get(req.params.candidateId);
  if (!candidate) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道候选题。");
  if (candidate.status !== "pending") return fail(res, 409, "REVIEW_ALREADY_FINISHED", "这道候选题已经审核过了。");
  db.prepare(`
    UPDATE discovery_candidates SET status = 'rejected', review_note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?
  `).run(typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : null, nowIso(), req.user.id, candidate.id);
  finishReviewIfComplete(candidate.job_id);
  res.json(ok(toCrawlCandidate(db.prepare("SELECT * FROM discovery_candidates WHERE id = ?").get(candidate.id))));
});
