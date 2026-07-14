/**
 * routes-review.js — v2 间隔复习调度
 *
 * 答错后自动生成 4 轮复习任务（当天/3天/7天/14天），
 * 每轮复测后更新掌握度和下一轮计划。
 */
import { randomUUID } from "node:crypto";
import express from "express";
import {
  db,
  nowIso,
  parseJson,
  todayLocal
} from "./db.js";
import { requireAuth } from "./auth.js";
import { AppError, asyncRoute, fail, ok } from "./http.js";

export const reviewRouter = express.Router();

// ——— 复习间隔定义 ———
const REVIEW_INTERVALS = [0, 3, 7, 14]; // 天数

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, "VALIDATION_ERROR", `${label}不能为空。`);
  }
  return value.trim();
}

function toReviewTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    knowledge_tag: row.knowledge_tag,
    subject: row.subject,
    source_question_id: row.source_question_id,
    source_question_type: row.source_question_type,
    review_question_id: row.review_question_id,
    review_question_type: row.review_question_type,
    scheduled_date: row.scheduled_date,
    interval_days: row.interval_days,
    review_round: row.review_round,
    status: row.status,
    result: row.result,
    score: row.score,
    mastery_level_before: row.mastery_level_before,
    mastery_level_after: row.mastery_level_after,
    feedback_text: row.feedback_text,
    created_at: row.created_at,
    completed_at: row.completed_at
  };
}

// ——— 查找同类题目（限公共题与用户自己的题）———
function findSimilarQuestion({ userId, subject, knowledgeTag, difficulty, excludeId }) {
  const row = db.prepare(`
    SELECT id FROM practice_questions
    WHERE subject = ? AND difficulty = ? AND id != ? AND knowledge_tags_json LIKE ?
      AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)
    ORDER BY RANDOM() LIMIT 1
  `).get(subject, difficulty, excludeId, `%${knowledgeTag}%`, userId);
  if (row) return row.id;

  const fallback = db.prepare(`
    SELECT id FROM practice_questions
    WHERE subject = ? AND id != ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)
    ORDER BY RANDOM() LIMIT 1
  `).get(subject, excludeId, userId);
  if (fallback) return fallback.id;
  return excludeId;
}

// ——— 为答错的题目创建复习任务链（供外部调用）———
export function createReviewTasks({ userId, subject, knowledgeTags, difficulty, sourceQuestionId, sourceQuestionType = "practice" }) {
  const existing = db.prepare(`
    SELECT id FROM review_tasks
    WHERE user_id = ? AND source_question_id = ? AND status = 'pending'
    ORDER BY review_round
  `).all(userId, sourceQuestionId);
  if (existing.length) return existing.map((item) => item.id);

  const taskIds = [];

  for (let round = 0; round < REVIEW_INTERVALS.length; round++) {
    const intervalDays = REVIEW_INTERVALS[round];
    const scheduledDateStr = todayLocal(intervalDays);

    const id = randomUUID();
    const normalizedTag = knowledgeTags[0] || subject;

    // 找一道同类题用于复习（非原题）
    const reviewQuestionId = findSimilarQuestion({
      userId,
      subject,
      knowledgeTag: normalizedTag,
      difficulty: difficulty || "medium",
      excludeId: sourceQuestionId
    });

    db.prepare(`
      INSERT INTO review_tasks (
        id, user_id, knowledge_tag, subject,
        source_question_id, source_question_type,
        review_question_id, review_question_type,
        scheduled_date, interval_days, review_round,
        status, mastery_level_before,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'practice', ?, ?, ?, 'pending', 'weak', ?)
    `).run(
      id, userId, normalizedTag, subject,
      sourceQuestionId, sourceQuestionType,
      reviewQuestionId,
      scheduledDateStr, intervalDays, round + 1,
      nowIso()
    );

    taskIds.push(id);
  }

  return taskIds;
}

// ——— 1. 今日待复习 ———
reviewRouter.get("/review/today", requireAuth, (req, res) => {
  const today = todayLocal();
  const subject = typeof req.query.subject === "string" ? req.query.subject : null;

  let sql = `
    SELECT rt.*, pq.title AS review_question_title, pq.content_text AS review_question_content,
           pq.knowledge_tags_json AS review_question_tags, pq.difficulty AS review_question_difficulty
    FROM review_tasks rt
    LEFT JOIN practice_questions pq ON pq.id = rt.review_question_id
    WHERE rt.user_id = ? AND rt.scheduled_date <= ? AND rt.status = 'pending'
  `;
  const params = [req.user.id, today];

  if (subject) {
    sql += " AND rt.subject = ?";
    params.push(subject);
  }

  sql += " ORDER BY rt.review_round ASC, rt.scheduled_date ASC";
  const rows = db.prepare(sql).all(...params);

  const items = rows.map((row) => ({
    ...toReviewTask(row),
    review_question_title: row.review_question_title || null,
    review_question_content: row.review_question_content || null,
    review_question_tags: parseJson(row.review_question_tags, []),
    review_question_difficulty: row.review_question_difficulty || null
  }));

  // 同时查出逾期未复习的
  const overdueCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM review_tasks WHERE user_id = ? AND scheduled_date < ? AND status = 'pending'
  `).get(req.user.id, today).cnt;

  res.json(ok({ items, pending_count: items.length, overdue_count: Number(overdueCount) }));
});

// ——— 2. 待复习（含未来） ———
reviewRouter.get("/review/pending", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT rt.*, pq.title AS review_question_title
    FROM review_tasks rt
    LEFT JOIN practice_questions pq ON pq.id = rt.review_question_id
    WHERE rt.user_id = ? AND rt.status = 'pending'
    ORDER BY rt.scheduled_date ASC, rt.review_round ASC
    LIMIT 50
  `).all(req.user.id);

  const items = rows.map((row) => ({
    ...toReviewTask(row),
    review_question_title: row.review_question_title || null
  }));

  res.json(ok({ items }));
});

// ——— 3. 已完成 ———
reviewRouter.get("/review/completed", requireAuth, (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size || 20)));
  const offset = (page - 1) * pageSize;

  const rows = db.prepare(`
    SELECT rt.*, pq.title AS review_question_title
    FROM review_tasks rt
    LEFT JOIN practice_questions pq ON pq.id = rt.review_question_id
    WHERE rt.user_id = ? AND rt.status = 'completed'
    ORDER BY rt.completed_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, pageSize, offset);

  const total = db.prepare("SELECT COUNT(*) AS total FROM review_tasks WHERE user_id = ? AND status = 'completed'").get(req.user.id).total;

  const items = rows.map((row) => ({
    ...toReviewTask(row),
    review_question_title: row.review_question_title || null
  }));

  res.json(ok({ items, pagination: { page, page_size: pageSize, total } }));
});

// ——— 4. 单个复习任务及关联题目 ———
reviewRouter.get("/review/tasks/:taskId", requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT rt.*, pq.title AS review_question_title, pq.content_text AS review_question_content,
           pq.content_image_url AS review_question_image_url,
           pq.knowledge_tags_json AS review_question_tags,
           pq.difficulty AS review_question_difficulty
    FROM review_tasks rt
    LEFT JOIN practice_questions pq ON pq.id = rt.review_question_id
    WHERE rt.id = ? AND rt.user_id = ?
  `).get(req.params.taskId, req.user.id);
  if (!row) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个复习任务。");
  res.json(ok({
    ...toReviewTask(row),
    review_question_title: row.review_question_title || null,
    review_question_content: row.review_question_content || null,
    review_question_image_url: row.review_question_image_url || null,
    review_question_tags: parseJson(row.review_question_tags, []),
    review_question_difficulty: row.review_question_difficulty || null
  }));
});

// ——— 5. 提交复习结果 ———
reviewRouter.post("/review/:taskId/submit", requireAuth, asyncRoute(async (req, res) => {
  const task = db.prepare("SELECT * FROM review_tasks WHERE id = ? AND user_id = ?").get(req.params.taskId, req.user.id);
  if (!task) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个复习任务。");

  if (task.status !== "pending") {
    return fail(res, 400, "VALIDATION_ERROR", "该复习任务已经提交过。");
  }

  const result = requireString(req.body.result, "复习结果");
  if (!["correct", "partial", "incorrect"].includes(result)) {
    throw new AppError(400, "VALIDATION_ERROR", "复习结果不合法（correct/partial/incorrect）。");
  }

  const score = Number.isFinite(Number(req.body.score)) ? Math.max(0, Math.min(100, Number(req.body.score))) : (result === "correct" ? 90 : result === "partial" ? 60 : 30);
  const masteryAfter = result === "correct" ? "mastered" : result === "partial" ? "reviewing" : "weak";
  const feedbackText = typeof req.body.feedback_text === "string" ? req.body.feedback_text.trim() : "";

  db.prepare(`
    UPDATE review_tasks SET
      status = 'completed', result = ?, score = ?,
      mastery_level_before = ?, mastery_level_after = ?,
      feedback_text = ?, completed_at = ?
    WHERE id = ?
  `).run(result, score, task.mastery_level_before || "weak", masteryAfter, feedbackText, nowIso(), task.id);

  // 如果本轮答对了，取消后续轮次（前置间隔调度默认全量生成）
  if (result === "correct") {
    db.prepare(`
      UPDATE review_tasks SET
        status = 'cancelled', completed_at = ?
      WHERE user_id = ? AND source_question_id = ?
        AND review_round > ? AND status = 'pending'
    `).run(nowIso(), req.user.id, task.source_question_id, task.review_round);
  }

  res.json(ok(toReviewTask(db.prepare("SELECT * FROM review_tasks WHERE id = ?").get(task.id))));
}));

reviewRouter.post("/review/:taskId/dismiss", requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM review_tasks WHERE id = ? AND user_id = ?").get(req.params.taskId, req.user.id);
  if (!task) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个复习任务。");
  if (task.status !== "pending") return fail(res, 400, "VALIDATION_ERROR", "只有待复习任务可以忽略。");
  db.prepare("UPDATE review_tasks SET status = 'dismissed', completed_at = ? WHERE id = ?")
    .run(nowIso(), task.id);
  res.json(ok(toReviewTask(db.prepare("SELECT * FROM review_tasks WHERE id = ?").get(task.id))));
});

// ——— 6. 复习统计 ———
reviewRouter.get("/review/stats", requireAuth, (req, res) => {
  const today = todayLocal();

  const dueToday = db.prepare("SELECT COUNT(*) AS cnt FROM review_tasks WHERE user_id = ? AND scheduled_date <= ? AND status = 'pending'").get(req.user.id, today).cnt;
  const completed = db.prepare("SELECT COUNT(*) AS cnt FROM review_tasks WHERE user_id = ? AND status = 'completed'").get(req.user.id).cnt;
  const correctRate = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) AS correct
    FROM review_tasks WHERE user_id = ? AND status = 'completed'
  `).get(req.user.id);

  res.json(ok({
    due_today: Number(dueToday),
    completed_total: Number(completed),
    correct_rate: correctRate.total ? Math.round(correctRate.correct / correctRate.total * 100) : 0
  }));
});
