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

const knowledgeDependencies = {
  "数学": [["基础运算", "函数"], ["函数", "二次函数"], ["函数", "三角函数"], ["函数", "数列"], ["二次函数", "导数"], ["导数", "综合应用"], ["概率统计", "综合应用"]],
  "物理": [["运动学", "牛顿运动定律"], ["牛顿运动定律", "机械能"], ["电路", "电磁学"], ["机械能", "综合应用"], ["电磁学", "综合应用"]],
  "化学": [["物质的量", "离子反应"], ["离子反应", "氧化还原反应"], ["氧化还原反应", "化学平衡"], ["化学平衡", "综合应用"]],
  "生物": [["细胞结构", "遗传规律"], ["细胞结构", "稳态与调节"], ["稳态与调节", "生态系统"], ["遗传规律", "生物技术"]],
  "历史": [["史料实证", "中国近代史"], ["中国近代史", "中国现代史"], ["世界近代史", "工业革命"], ["工业革命", "综合论证"]],
  "地理": [["地球运动", "大气运动"], ["大气运动", "农业区位"], ["农业区位", "城市化"], ["城市化", "区域可持续发展"]],
  "政治": [["市场经济", "民主政治"], ["民主政治", "依法治国"], ["哲学原理", "文化传承"], ["依法治国", "综合论述"]],
  "语文": [["语言文字运用", "现代文阅读"], ["文言文阅读", "古诗词鉴赏"], ["现代文阅读", "写作"], ["古诗词鉴赏", "写作"]],
  "英语": [["词汇", "语法"], ["词汇", "阅读理解"], ["语法", "完形填空"], ["阅读理解", "书面表达"]]
};

const contextKeywordTags = {
  "数学": [["函数", ["函数"]], ["二次", ["二次函数"]], ["导数", ["导数"]], ["概率", ["概率统计"]], ["数列", ["数列"]], ["三角", ["三角函数"]], ["压轴", ["综合应用"]]],
  "物理": [["运动", ["运动学"]], ["力学", ["牛顿运动定律", "机械能"]], ["电路", ["电路"]], ["电磁", ["电磁学"]], ["压轴", ["综合应用"]]],
  "化学": [["物质的量", ["物质的量"]], ["离子", ["离子反应"]], ["氧化还原", ["氧化还原反应"]], ["平衡", ["化学平衡"]]],
  "生物": [["细胞", ["细胞结构"]], ["遗传", ["遗传规律"]], ["稳态", ["稳态与调节"]], ["生态", ["生态系统"]]],
  "历史": [["史料", ["史料实证"]], ["近代", ["中国近代史", "世界近代史"]], ["现代", ["中国现代史"]], ["工业革命", ["工业革命"]]],
  "地理": [["地球运动", ["地球运动"]], ["大气", ["大气运动"]], ["农业", ["农业区位"]], ["城市", ["城市化"]], ["区域", ["区域可持续发展"]]],
  "政治": [["经济", ["市场经济"]], ["民主", ["民主政治"]], ["法治", ["依法治国"]], ["哲学", ["哲学原理"]], ["文化", ["文化传承"]]],
  "语文": [["语言文字", ["语言文字运用"]], ["现代文", ["现代文阅读"]], ["文言", ["文言文阅读"]], ["古诗", ["古诗词鉴赏"]], ["作文", ["写作"]], ["写作", ["写作"]]],
  "英语": [["词汇", ["词汇"]], ["语法", ["语法"]], ["阅读", ["阅读理解"]], ["完形", ["完形填空"]], ["作文", ["书面表达"]], ["写作", ["书面表达"]]]
};

function contextTagsForSubject(subject, context) {
  if (!context) return [];
  const matches = [];
  for (const [keyword, tags] of contextKeywordTags[subject] || []) {
    if (context.includes(keyword)) matches.push(...tags);
  }
  return [...new Set(normalizeKnowledgeTags(subject, matches))];
}

function prerequisiteRouteTags(edges, targets) {
  const parents = new Map();
  for (const [source, target] of edges) {
    if (!parents.has(target)) parents.set(target, []);
    parents.get(target).push(source);
  }
  const route = new Set();
  function visit(tag) {
    for (const parent of parents.get(tag) || []) {
      if (route.has(parent)) continue;
      route.add(parent);
      visit(parent);
    }
  }
  targets.forEach(visit);
  return route;
}

function scoreBandMidpoint(band) {
  if (band === "600以上") return 630;
  if (band === "500-599") return 550;
  if (band === "400-499") return 450;
  if (band === "400以下") return 360;
  return null;
}

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

// ——— 关联知识图谱：画像目标 + 真实作答 + 前置依赖 ———
recommendRouter.get("/recommend/graph", requireAuth, (req, res) => {
  const allowedSubjects = req.user.subjects?.length ? req.user.subjects : [req.user.exam_track || "数学"];
  const requested = typeof req.query.subject === "string" ? req.query.subject : null;
  const subject = requested && allowedSubjects.includes(requested) ? requested : allowedSubjects[0];
  const baseEdges = knowledgeDependencies[subject] || [];
  const baseTags = [...new Set(baseEdges.flat())];
  const contextTags = contextTagsForSubject(subject, req.user.learning_context);
  const contextRouteTags = prerequisiteRouteTags(baseEdges, contextTags);
  const attemptRows = db.prepare(`
    SELECT pa.score, pq.knowledge_tags_json
    FROM practice_attempts pa JOIN practice_questions pq ON pq.id = pa.practice_question_id
    WHERE pa.user_id = ? AND pq.subject = ?
    ORDER BY pa.created_at DESC LIMIT 120
  `).all(req.user.id, subject);
  const stats = new Map();
  for (const row of attemptRows) {
    for (const tag of normalizeKnowledgeTags(subject, parseJson(row.knowledge_tags_json, []))) {
      if (!stats.has(tag)) stats.set(tag, { attempts: 0, total: 0 });
      const item = stats.get(tag);
      item.attempts += 1;
      item.total += Number(row.score || 0);
    }
  }
  const reviewRows = db.prepare(`
    SELECT knowledge_tag, status, result FROM review_tasks
    WHERE user_id = ? AND subject = ?
  `).all(req.user.id, subject);
  const reviewStats = new Map();
  for (const row of reviewRows) {
    if (!reviewStats.has(row.knowledge_tag)) reviewStats.set(row.knowledge_tag, { pending: 0, passed: 0 });
    const item = reviewStats.get(row.knowledge_tag);
    if (row.status === "pending") item.pending += 1;
    if (row.status === "completed" && row.result === "correct") item.passed += 1;
  }
  const tags = [...new Set([...baseTags, ...stats.keys(), ...contextTags])].slice(0, 18);
  const prerequisites = new Map(tags.map((tag) => [tag, baseEdges.filter(([, target]) => target === tag).map(([source]) => source)]));
  const provisional = tags.map((tag) => {
    const stat = stats.get(tag);
    const reviews = reviewStats.get(tag) || { pending: 0, passed: 0 };
    const score = stat ? Math.round(stat.total / stat.attempts) : 0;
    return { tag, score, attempts: stat?.attempts || 0, pending_reviews: reviews.pending, passed_reviews: reviews.passed };
  });
  const mastered = new Set(provisional.filter((item) => item.score >= 80 || item.passed_reviews >= 2).map((item) => item.tag));
  const currentScore = scoreBandMidpoint(req.user.current_score_band);
  const goalGap = currentScore === null || req.user.target_score === null ? null : Math.max(0, req.user.target_score - currentScore);
  const nodes = provisional.map((item) => {
    const deps = prerequisites.get(item.tag) || [];
    const depsReady = deps.every((tag) => mastered.has(tag));
    const contextMatched = contextTags.includes(item.tag);
    const contextRouteMatched = contextRouteTags.has(item.tag) && !contextMatched;
    const status = mastered.has(item.tag) ? "mastered" : (item.attempts > 0 || contextMatched) && depsReady ? "active" : depsReady ? "ready" : "locked";
    const priority = status === "mastered" ? 0 : Math.round((100 - item.score) + item.pending_reviews * 8 + Math.min(20, (goalGap || 0) / 10) + (contextMatched ? 25 : contextRouteMatched ? 15 : 0));
    const question = db.prepare(`
      SELECT id, title, exam_question_id FROM practice_questions
      WHERE subject = ? AND knowledge_tags_json LIKE ?
        AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)
      ORDER BY CASE difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT 1
    `).get(subject, `%${item.tag}%`, req.user.id);
    const collection = question?.exam_question_id ? db.prepare(`
      SELECT c.id FROM collection_questions cq
      JOIN question_collections c ON c.id = cq.collection_id
      WHERE cq.exam_question_id = ? AND (c.user_id = ? OR c.user_id IS NULL OR c.is_shared = 1)
      ORDER BY CASE WHEN c.user_id = ? THEN 0 ELSE 1 END, c.created_at DESC LIMIT 1
    `).get(question.exam_question_id, req.user.id, req.user.id) : null;
    return {
      id: `${subject}:${item.tag}`,
      tag: item.tag,
      subject,
      score: item.score,
      attempts: item.attempts,
      pending_reviews: item.pending_reviews,
      context_matched: contextMatched,
      context_route: contextRouteMatched,
      prerequisites: deps,
      status,
      priority,
      recommended_question_id: question?.id || null,
      recommended_question_title: question?.title || null,
      recommended_collection_id: collection?.id || null,
      reason: status === "mastered"
        ? "已有稳定作答或复测证据，可以作为后续知识点的基础。"
        : status === "locked"
          ? contextMatched
            ? `你在学情中提到了这一方向；先巩固 ${deps.filter((tag) => !mastered.has(tag)).join("、")}，再进入这一节点。`
            : `先巩固 ${deps.filter((tag) => !mastered.has(tag)).join("、")}，再进入这一节点。`
          : item.attempts
            ? `最近 ${item.attempts} 次作答平均 ${item.score} 分，当前应优先补齐。`
            : contextMatched
              ? "你在学情描述中提到了这一方向，系统已将它加入当前重点。"
              : contextRouteMatched
                ? `为了你在学情中提到的 ${contextTags.join("、")}，先建立这个前置节点。`
              : "前置知识已经就绪，可以开始建立这一节点。"
    };
  });
  const focusNode = nodes.filter((item) => !["mastered", "locked"].includes(item.status)).sort((a, b) => b.priority - a.priority)[0] || null;
  res.json(ok({
    subject,
    available_subjects: allowedSubjects,
    goal: {
      target_score: req.user.target_score,
      current_score_band: req.user.current_score_band,
      estimated_gap: goalGap,
      learning_context: req.user.learning_context,
      context_matches: contextTags
    },
    focus_node_id: focusNode?.id || null,
    nodes,
    edges: baseEdges.filter(([source, target]) => tags.includes(source) && tags.includes(target)).map(([source, target]) => ({ source: `${subject}:${source}`, target: `${subject}:${target}`, type: "prerequisite" }))
  }));
});

// ——— 3. 获取某知识点的推荐题目（纯规则，AI 不参与调度）———
recommendRouter.get("/recommend/questions", requireAuth, (req, res) => {
  const knowledgeTag = req.query.knowledge_tag;
  const subject = req.query.subject;

  if (!knowledgeTag || !subject) {
    const items = db.prepare(`
      SELECT id, subject, title, difficulty, knowledge_tags_json
      FROM practice_questions
      WHERE owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1
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
    WHERE subject = ? AND knowledge_tags_json LIKE ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)
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
