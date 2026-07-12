/**
 * routes-recommend.js — v2 规则驱动学习路径推荐
 *
 * 推荐算法：低掌握度 + 到期复习 + 最近错误优先（纯规则，可解释）
 * AI 仅用于生成解释文案，不决定调度优先级。
 */
import express from "express";
import {
  db,
  canonicalTagsForSubject,
  nowIso,
  normalizeKnowledgeTags,
  parseJson,
  todayLocal
} from "./db.js";
import { requireAuth } from "./auth.js";
import { AppError, asyncRoute, ok } from "./http.js";

export const recommendRouter = express.Router();

/**
 * 计算多维优先级分数：
 * - mastery_penalty: 掌握度越低分越高 (weak=50, reviewing=30, mastered=0)
 * - overdue_bonus: 每逾期一天 +5 分
 * - recent_error_bonus: 7 天内错过额外 +20 分
 */
function computePriority(task, nowDate) {
  let score = 0;

  // 掌握度惩罚
  if (task.mastery_level_before === "weak") score += 50;
  else if (task.mastery_level_before === "reviewing") score += 30;

  // 逾期奖励
  if (task.scheduled_date) {
    const scheduled = new Date(task.scheduled_date);
    const diffDays = Math.max(0, Math.floor((nowDate - scheduled) / (1000 * 60 * 60 * 24)));
    score += diffDays * 5;
  }

  // 最近错误
  if (task.last_error_at) {
    const errorDate = new Date(task.last_error_at);
    const diffDays = Math.floor((nowDate - errorDate) / (1000 * 60 * 60 * 24));
    if (diffDays <= 7) score += 20;
  }

  // 复习轮次（高轮次 = 顽固错题 = 高优先级）
  score += (task.review_round || 1) * 3;

  return score;
}

// ——— 1. 推荐今日待做（规则驱动）———
recommendRouter.get("/recommend/today", requireAuth, (req, res) => {
  const today = todayLocal();
  const nowDate = new Date();

  // 获取待复习任务（含关联题目详情）
  const reviewRows = db.prepare(`
    SELECT rt.*, pq.title AS question_title, pq.content_text AS question_content,
           pq.knowledge_tags_json AS question_tags, pq.difficulty AS question_difficulty
    FROM review_tasks rt
    LEFT JOIN practice_questions pq ON pq.id = rt.review_question_id
    WHERE rt.user_id = ? AND rt.scheduled_date <= ? AND rt.status = 'pending'
  `).all(req.user.id, today);

  // 获取近期错题
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentErrors = db.prepare(`
    SELECT pa.practice_question_id, pq.subject, pq.knowledge_tags_json, pa.score, pa.created_at
    FROM practice_attempts pa
    JOIN practice_questions pq ON pq.id = pa.practice_question_id
    WHERE pa.user_id = ? AND pa.is_correct = 0 AND pa.created_at >= ?
    ORDER BY pa.created_at DESC
    LIMIT 30
  `).all(req.user.id, sevenDaysAgo.toISOString());

  // 按优先级排序复习任务
  const tasksWithPriority = reviewRows.map((row) => ({
    ...row,
    questionTitle: row.question_title,
    questionTags: parseJson(row.question_tags, []),
    questionDifficulty: row.question_difficulty,
    priority: computePriority(row, nowDate)
  }));
  tasksWithPriority.sort((a, b) => b.priority - a.priority);

  // 按知识点分组统计
  const tagStats = new Map();
  for (const row of reviewRows) {
    const tag = row.knowledge_tag;
    if (!tagStats.has(tag)) tagStats.set(tag, { knowledge_tag: tag, subject: row.subject, review_count: 0, overdue_count: 0 });
    const stat = tagStats.get(tag);
    stat.review_count++;
    if (row.scheduled_date < today) stat.overdue_count++;
  }

  res.json(ok({
    recommended: tasksWithPriority.slice(0, 10).map((t) => ({
      review_task_id: t.id,
      knowledge_tag: t.knowledge_tag,
      subject: t.subject,
      review_round: t.review_round,
      scheduled_date: t.scheduled_date,
      interval_days: t.interval_days,
      mastery_level: t.mastery_level_before,
      question_id: t.review_question_id,
      question_title: t.questionTitle,
      question_tags: t.questionTags,
      question_difficulty: t.questionDifficulty,
      priority: t.priority,
      is_overdue: t.scheduled_date < today
    })),
    tag_summary: [...tagStats.values()].sort((a, b) => b.overdue_count - a.overdue_count || b.review_count - a.review_count),
    recent_errors_count: recentErrors.length,
    due_today_count: reviewRows.length
  }));
});

// ——— 2. 学习路径概览（合并复习 + 薄弱项）———
recommendRouter.get("/recommend/path", requireAuth, (req, res) => {
  // 薄弱知识点（来自最近错题）
  const weakTagsRows = db.prepare(`
    SELECT pq.subject, pq.knowledge_tags_json, pa.score, pa.is_correct, pa.created_at
    FROM practice_attempts pa
    JOIN practice_questions pq ON pq.id = pa.practice_question_id
    WHERE pa.user_id = ? AND pa.is_correct = 0
    ORDER BY pa.created_at DESC
    LIMIT 50
  `).all(req.user.id);

  const tagScores = new Map();
  for (const row of weakTagsRows) {
    const tags = parseJson(row.knowledge_tags_json, []);
    for (const tag of tags) {
      const key = `${row.subject}:${tag}`;
      if (!tagScores.has(key)) tagScores.set(key, { subject: row.subject, knowledge_tag: tag, error_count: 0, avg_score: 0, total_score: 0 });
      const stat = tagScores.get(key);
      stat.error_count++;
      stat.total_score += row.score;
      stat.avg_score = Math.round(stat.total_score / stat.error_count);
    }
  }

  // 已完成复习的掌握度趋势
  const reviewStats = db.prepare(`
    SELECT knowledge_tag, subject, COUNT(*) AS total,
      SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) AS correct
    FROM review_tasks
    WHERE user_id = ? AND status = 'completed'
    GROUP BY knowledge_tag, subject
  `).all(req.user.id);

  const reviewMap = new Map();
  for (const row of reviewStats) {
    const key = `${row.subject}:${row.knowledge_tag}`;
    reviewMap.set(key, {
      total: row.total,
      correct: row.correct,
      rate: row.total ? Math.round(row.correct / row.total * 100) : 0
    });
  }

  // 合并输出
  const items = [...tagScores.values()]
    .sort((a, b) => b.error_count - a.error_count)
    .slice(0, 10)
    .map((item) => {
      const key = `${item.subject}:${item.knowledge_tag}`;
      const review = reviewMap.get(key);
      return {
        knowledge_tag: item.knowledge_tag,
        subject: item.subject,
        error_count: item.error_count,
        avg_score: item.avg_score,
        review_total: review ? review.total : 0,
        review_correct_rate: review ? review.rate : null,
        status: !review ? "not_started"
          : review.rate >= 80 ? "nearly_mastered"
          : review.rate >= 50 ? "improving"
          : "struggling"
      };
    });

  const today = todayLocal();
  const dueCount = db.prepare("SELECT COUNT(*) AS cnt FROM review_tasks WHERE user_id = ? AND scheduled_date <= ? AND status = 'pending'").get(req.user.id, today).cnt;

  res.json(ok({ items, due_review_count: Number(dueCount) }));
});

// ——— 3. 获取某知识点的推荐题目（纯规则，AI 不参与调度）———
recommendRouter.get("/recommend/questions", requireAuth, (req, res) => {
  const knowledgeTag = req.query.knowledge_tag;
  const subject = req.query.subject;

  if (!knowledgeTag || !subject) {
    const items = db.prepare(`
      SELECT id, subject, title, difficulty, knowledge_tags_json
      FROM practice_questions
      WHERE owner_user_id IS NULL OR owner_user_id = ?
      ORDER BY RANDOM()
      LIMIT 5
    `).all(req.user.id).map((row) => ({
      id: row.id,
      subject: row.subject,
      title: row.title,
      difficulty: row.difficulty,
      knowledge_tags: parseJson(row.knowledge_tags_json, [])
    }));
    return res.json(ok({ items }));
  }

  const rows = db.prepare(`
    SELECT id, subject, title, content_text, difficulty, knowledge_tags_json, content_image_url
    FROM practice_questions
    WHERE subject = ? AND knowledge_tags_json LIKE ? AND (owner_user_id IS NULL OR owner_user_id = ?)
    ORDER BY difficulty ASC, RANDOM()
    LIMIT 5
  `).all(subject, `%${knowledgeTag}%`, req.user.id);

  const items = rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    title: row.title,
    content_text: row.content_text?.slice(0, 200),
    difficulty: row.difficulty,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    content_image_url: row.content_image_url
  }));

  res.json(ok({ items }));
});
