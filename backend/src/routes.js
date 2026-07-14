import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcryptjs";
import express from "express";
import {
  db,
  canonicalTagsForSubject,
  nowIso,
  normalizeKnowledgeTags,
  parseJson,
  toAnswer,
  toExamPaper,
  toExamQuestion,
  toIngestionJob,
  toPracticeAttempt,
  toPracticeQuestion,
  toQuestionCollection,
  toQuestion,
  toQuestionProfile,
  toUser
} from "./db.js";
import { requireAuth, signToken } from "./auth.js";
import { AppError, asyncRoute, fail, ok } from "./http.js";
import { config } from "./config.js";
import {
  buildQuestionCollection,
  ensureAiConfigured,
  evaluatePracticeAttempt,
  generateAnswer,
  generateFollowUp,
  generatePracticeFollowUp,
  generateFullSolution,
  generateLearningPath,
  recognizeQuestionImage,
  profileExamQuestion
} from "./ai.js";
import { authRateLimiter } from "./rate-limiter.js";
import { createReviewTasks } from "./routes-review.js";
import { withAiQuota } from "./quota.js";

export const router = express.Router();

// 可见性规则：公共资源（owner_user_id 为 NULL 的种子/官方内容）+ 自己导入的资源。
function accessiblePaper(paperId, userId) {
  return db.prepare(
    "SELECT * FROM exam_papers WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)"
  ).get(paperId, userId);
}

function accessibleExamQuestion(questionId, userId) {
  return db.prepare(`
    SELECT q.* FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    WHERE q.id = ? AND (p.owner_user_id IS NULL OR p.owner_user_id = ? OR p.is_shared = 1)
  `).get(questionId, userId);
}

router.get("/system/readiness", (_req, res) => {
  res.json(ok({
    server: true,
    database: true,
    ai: {
      configured: Boolean(
        config.aiApiKey &&
        config.aiApiKey !== "sk-your-api-key-here" &&
        config.aiApiKey !== "your-zhipu-api-key-here"
      ),
      provider: config.aiProvider,
      model: config.aiModel,
      vision_model: config.aiVisionModel,
      base_url: config.aiBaseUrl,
      timeout_ms: config.aiTimeoutMs,
      daily_limit: config.aiDailyLimit
    },
    auth: {
      jwt_secret_configured: Boolean(config.jwtSecret && config.jwtSecret !== "dev-only-change-me"),
      jwt_expires_in: config.jwtExpiresIn
    }
  }));
});

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, "VALIDATION_ERROR", `${label}不能为空。`);
  }
  return value.trim();
}

function collectionRow(collectionId, userId) {
  return db.prepare(`
    SELECT c.*, COUNT(cq.exam_question_id) AS question_count,
      (c.user_id = ?) AS is_owner,
      EXISTS(
        SELECT 1 FROM practice_sessions ps
        WHERE ps.collection_id = c.id AND ps.user_id = ? AND ps.status = 'completed'
      ) AS is_completed
    FROM question_collections c
    LEFT JOIN collection_questions cq ON cq.collection_id = c.id
    WHERE c.id = ? AND (c.user_id = ? OR c.user_id IS NULL OR c.is_shared = 1)
    GROUP BY c.id
  `).get(userId, userId, collectionId, userId);
}

function createCollection({ userId, title, description, subject, creationMode, coverStyle, sourcePaperId, questionIds }) {
  const collectionId = randomUUID();
  const createdAt = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO question_collections (
        id, user_id, title, description, subject, creation_mode, cover_style, source_paper_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(collectionId, userId, title, description, subject, creationMode, coverStyle, sourcePaperId || null, createdAt);
    questionIds.forEach((questionId, index) => {
      db.prepare(`
        INSERT INTO collection_questions (collection_id, exam_question_id, position)
        VALUES (?, ?, ?)
      `).run(collectionId, questionId, index + 1);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return toQuestionCollection(collectionRow(collectionId, userId));
}

function evaluationCacheKey(practiceQuestion, answerText) {
  const normalizedAnswer = answerText.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
  const answerHash = createHash("sha256").update(normalizedAnswer).digest("hex");
  const questionVersion = createHash("sha256").update(JSON.stringify({
    content_text: practiceQuestion.content_text,
    official_answer_text: practiceQuestion.official_answer_text,
    knowledge_tags: practiceQuestion.knowledge_tags
  })).digest("hex").slice(0, 16);
  return { answerHash, cacheKey: `${practiceQuestion.id}:${questionVersion}:${answerHash}` };
}

async function evaluatePracticeWithCache({ userId, practiceQuestion, answerText }) {
  const { answerHash, cacheKey } = evaluationCacheKey(practiceQuestion, answerText);
  const cached = db.prepare("SELECT evaluation_json FROM practice_evaluation_cache WHERE cache_key = ?").get(cacheKey);
  if (cached) {
    const evaluation = parseJson(cached.evaluation_json, null);
    if (evaluation) {
      db.prepare("UPDATE practice_evaluation_cache SET hit_count = hit_count + 1, last_used_at = ? WHERE cache_key = ?")
        .run(nowIso(), cacheKey);
      return { evaluation, fromCache: true };
    }
  }

  ensureAiConfigured();
  const evaluation = await withAiQuota(userId, () => evaluatePracticeAttempt({
    practiceQuestion,
    answerText,
    canonicalTags: canonicalTagsForSubject(practiceQuestion.subject)
  }));
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO practice_evaluation_cache (
      cache_key, practice_question_id, answer_hash, evaluation_json, hit_count, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      evaluation_json = excluded.evaluation_json,
      last_used_at = excluded.last_used_at
  `).run(cacheKey, practiceQuestion.id, answerHash, JSON.stringify(evaluation), createdAt, createdAt);
  return { evaluation, fromCache: false };
}

function practiceWeakTags(userId) {
  const rows = db.prepare(`
    SELECT pq.knowledge_tags_json, pa.score
    FROM practice_attempts pa
    JOIN practice_questions pq ON pq.id = pa.practice_question_id
    WHERE pa.user_id = ?
  `).all(userId);
  const totals = new Map();
  for (const row of rows) {
    for (const tag of parseJson(row.knowledge_tags_json, [])) {
      const current = totals.get(tag) || { attempts: 0, score: 0 };
      current.attempts += 1;
      current.score += row.score;
      totals.set(tag, current);
    }
  }
  return [...totals.entries()]
    .map(([tag, value]) => ({ tag, average_score: Math.round(value.score / value.attempts), attempts: value.attempts }))
    .sort((a, b) => a.average_score - b.average_score || b.attempts - a.attempts);
}

function upsertLearningPathItem({ userId, knowledgeTag, reason, recommendedAction, relatedQuestionIds = [], source = "ai" }) {
  const existing = db.prepare(`
    SELECT id FROM learning_path_items
    WHERE user_id = ? AND knowledge_tag = ? AND status = 'pending'
  `).get(userId, knowledgeTag);
  const generatedAt = nowIso();
  if (existing) {
    db.prepare(`
      UPDATE learning_path_items
      SET reason = ?, recommended_action = ?, related_question_ids_json = ?, source = ?, generated_at = ?
      WHERE id = ?
    `).run(reason, recommendedAction, JSON.stringify(relatedQuestionIds), source, generatedAt, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO learning_path_items (
      id, user_id, knowledge_tag, reason, recommended_action,
      related_question_ids_json, status, source, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, userId, knowledgeTag, reason, recommendedAction, JSON.stringify(relatedQuestionIds), source, generatedAt);
  return id;
}

function collectWeaknesses(userId) {
  const totals = new Map();
  const add = (subject, tag, weight, source, questionId) => {
    const key = `${subject}:${tag}`;
    const current = totals.get(key) || { subject, knowledge_tag: tag, weakness_score: 0, evidence_count: 0, sources: new Set(), question_ids: new Set() };
    current.weakness_score += weight;
    current.evidence_count += 1;
    current.sources.add(source);
    if (questionId) current.question_ids.add(questionId);
    totals.set(key, current);
  };

  const attempts = db.prepare(`
    SELECT pq.subject, pq.knowledge_tags_json, pq.exam_question_id, pa.score
    FROM practice_attempts pa
    JOIN practice_questions pq ON pq.id = pa.practice_question_id
    WHERE pa.user_id = ? AND pa.score < 80
  `).all(userId);
  for (const row of attempts) {
    for (const tag of normalizeKnowledgeTags(row.subject, parseJson(row.knowledge_tags_json, []))) {
      add(row.subject, tag, Math.max(1, 100 - row.score), "低分作答", row.exam_question_id);
    }
  }

  const mistakes = db.prepare(`
    SELECT q.subject, m.knowledge_tags_json, m.mistake_count, m.question_id
    FROM mistake_records m
    JOIN questions q ON q.id = m.question_id
    WHERE m.user_id = ? AND m.mastery_status != 'mastered'
  `).all(userId);
  for (const row of mistakes) {
    for (const tag of normalizeKnowledgeTags(row.subject, parseJson(row.knowledge_tags_json, []))) {
      add(row.subject, tag, row.mistake_count * 25, "解析错题", row.question_id);
    }
  }

  return [...totals.values()]
    .map((item) => ({ ...item, sources: [...item.sources], question_ids: [...item.question_ids] }))
    .sort((a, b) => b.weakness_score - a.weakness_score)
    .slice(0, 8);
}

router.post("/auth/register", authRateLimiter(), asyncRoute(async (req, res) => {
  // 内测邀请码：设置了 INVITE_CODE 环境变量才启用，防止开放注册烧穿 AI 余额
  if (config.inviteCode) {
    const invite = typeof req.body.invite_code === "string" ? req.body.invite_code.trim() : "";
    if (invite !== config.inviteCode) {
      throw new AppError(403, "INVITE_REQUIRED", "内测阶段注册需要邀请码，请向管理员获取。");
    }
  }
  const nickname = requireString(req.body.nickname, "昵称");
  if (nickname.length < 2 || nickname.length > 30 || !/^[\u4e00-\u9fff\w_-]+$/.test(nickname)) {
    throw new AppError(400, "VALIDATION_ERROR", "昵称需 2-30 位，仅支持中文、字母、数字、下划线和连字符。");
  }
  const password = requireString(req.body.password, "密码");
  const grade = requireString(req.body.grade, "年级");
  if (password.length < 6 || password.length > 128) {
    throw new AppError(400, "VALIDATION_ERROR", "密码长度应介于 6 到 128 位之间。");
  }

  const exists = db.prepare("SELECT id FROM users WHERE nickname = ?").get(nickname);
  if (exists) {
    throw new AppError(400, "VALIDATION_ERROR", "这个昵称已经被使用。");
  }

  const userId = randomUUID();
  const createdAt = nowIso();
  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(`
    INSERT INTO users (id, nickname, password_hash, grade, subjects_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, nickname, passwordHash, grade, JSON.stringify([]), createdAt);

  const user = toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId));
  const token = signToken(user);
  res.cookie("token", token, { httpOnly: true, sameSite: "strict", secure: config.secureCookie, maxAge: 604800000, path: "/" });
  res.status(201).json(ok({ user, token }));
}));

router.post("/auth/login", authRateLimiter(), asyncRoute(async (req, res) => {
  const nickname = requireString(req.body.nickname, "昵称");
  const password = requireString(req.body.password, "密码");
  const row = db.prepare("SELECT * FROM users WHERE nickname = ?").get(nickname);

  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new AppError(401, "AUTH_INVALID_TOKEN", "昵称或密码不正确。");
  }

  const user = toUser(row);
  const token = signToken(user);
  res.cookie("token", token, { httpOnly: true, sameSite: "strict", secure: config.secureCookie, maxAge: 604800000, path: "/" });
  res.json(ok({ user, token }));
}));

router.post("/auth/logout", (req, res) => {
  res.clearCookie("token", { path: "/" });
  res.json(ok({}));
});

router.get("/users/me", requireAuth, (req, res) => {
  res.json(ok(req.user));
});

router.patch("/users/me", requireAuth, asyncRoute(async (req, res) => {
  const grade = typeof req.body.grade === "string" ? req.body.grade : req.user.grade;
  const subjects = Array.isArray(req.body.subjects) ? req.body.subjects.filter((item) => typeof item === "string") : req.user.subjects;
  db.prepare("UPDATE users SET grade = ?, subjects_json = ? WHERE id = ?").run(grade, JSON.stringify(subjects), req.user.id);
  const user = toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id));
  res.json(ok(user));
}));

router.get("/profile/stats", requireAuth, (req, res) => {
  const summary = db.prepare(`
    SELECT COUNT(*) AS total_attempts,
      COALESCE(ROUND(AVG(score)), 0) AS average_score,
      COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct_count
    FROM practice_attempts
    WHERE user_id = ?
  `).get(req.user.id);
  const recentRows = db.prepare(`
    SELECT pa.*, pq.title, pq.subject, pq.knowledge_tags_json
    FROM practice_attempts pa
    JOIN practice_questions pq ON pq.id = pa.practice_question_id
    WHERE pa.user_id = ?
    ORDER BY pa.created_at DESC
    LIMIT 8
  `).all(req.user.id);
  const collectionCount = db.prepare("SELECT COUNT(*) AS count FROM question_collections WHERE user_id = ?").get(req.user.id).count;
  const abilities = practiceWeakTags(req.user.id);
  const totalAttempts = Number(summary.total_attempts || 0);
  res.json(ok({
    summary: {
      total_attempts: totalAttempts,
      average_score: Number(summary.average_score || 0),
      correct_count: Number(summary.correct_count || 0),
      correct_rate: totalAttempts ? Math.round(Number(summary.correct_count) / totalAttempts * 100) : 0,
      collection_count: Number(collectionCount)
    },
    abilities,
    recent_attempts: recentRows.map((row) => ({
      ...toPracticeAttempt(row),
      title: row.title,
      subject: row.subject,
      knowledge_tags: parseJson(row.knowledge_tags_json, [])
    }))
  }));
});

router.get("/exam/papers", requireAuth, (req, res) => {
  const subject = typeof req.query.subject === "string" ? req.query.subject : null;
  const rows = subject
    ? db.prepare("SELECT * FROM exam_papers WHERE subject = ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1) ORDER BY year DESC, created_at DESC").all(subject, req.user.id)
    : db.prepare("SELECT * FROM exam_papers WHERE owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1 ORDER BY year DESC, created_at DESC").all(req.user.id);
  res.json(ok({ items: rows.map(toExamPaper) }));
});

router.get("/exam/papers/:paperId/questions", requireAuth, (req, res) => {
  const paper = accessiblePaper(req.params.paperId, req.user.id);
  if (!paper) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这份试卷。");
  }
  const rows = db.prepare(`
    SELECT * FROM exam_questions
    WHERE paper_id = ?
    ORDER BY CAST(question_number AS INTEGER), question_number
  `).all(req.params.paperId);
  res.json(ok({ paper: toExamPaper(paper), items: rows.map(toExamQuestion) }));
});

router.get("/exam/questions/:questionId", requireAuth, (req, res) => {
  const question = accessibleExamQuestion(req.params.questionId, req.user.id);
  if (!question) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道真题。");
  }
  const profile = db.prepare("SELECT * FROM ai_question_profiles WHERE exam_question_id = ?").get(req.params.questionId);
  res.json(ok({ question: toExamQuestion(question), profile: toQuestionProfile(profile) }));
});

router.post("/exam/questions/:questionId/profile", requireAuth, asyncRoute(async (req, res) => {
  const questionRow = accessibleExamQuestion(req.params.questionId, req.user.id);
  if (!questionRow) {
    throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道真题。");
  }

  ensureAiConfigured();
  const examQuestion = toExamQuestion(questionRow, { includeAnswer: true });
  const profile = await withAiQuota(req.user.id, () =>
    profileExamQuestion({ examQuestion, canonicalTags: canonicalTagsForSubject(examQuestion.subject) })
  );

  const profileId = randomUUID();
  const generatedAt = nowIso();
  const tags = normalizeKnowledgeTags(
    examQuestion.subject,
    Array.isArray(profile.knowledge_tags) ? profile.knowledge_tags : examQuestion.knowledge_tags
  );
  const mistakes = Array.isArray(profile.common_mistakes) ? profile.common_mistakes : [];
  const prerequisites = Array.isArray(profile.prerequisites) ? profile.prerequisites : [];

  db.prepare(`
    INSERT INTO ai_question_profiles (
      id, exam_question_id, knowledge_tags_json, difficulty, core_idea,
      common_mistakes_json, exam_intent, prerequisites_json, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exam_question_id) DO UPDATE SET
      knowledge_tags_json = excluded.knowledge_tags_json,
      difficulty = excluded.difficulty,
      core_idea = excluded.core_idea,
      common_mistakes_json = excluded.common_mistakes_json,
      exam_intent = excluded.exam_intent,
      prerequisites_json = excluded.prerequisites_json,
      generated_at = excluded.generated_at
  `).run(
    profileId,
    examQuestion.id,
    JSON.stringify(tags),
    profile.difficulty || examQuestion.difficulty,
    profile.core_idea || "待补充",
    JSON.stringify(mistakes),
    profile.exam_intent || "待补充",
    JSON.stringify(prerequisites),
    generatedAt
  );

  db.prepare("UPDATE exam_questions SET knowledge_tags_json = ?, difficulty = ?, status = 'profiled' WHERE id = ?")
    .run(JSON.stringify(tags), profile.difficulty || examQuestion.difficulty, examQuestion.id);
  db.prepare("UPDATE practice_questions SET knowledge_tags_json = ?, difficulty = ? WHERE id = ?")
    .run(JSON.stringify(tags), profile.difficulty || examQuestion.difficulty, `practice-${examQuestion.id}`);

  const row = db.prepare("SELECT * FROM ai_question_profiles WHERE exam_question_id = ?").get(examQuestion.id);
  res.json(ok({ question: toExamQuestion(db.prepare("SELECT * FROM exam_questions WHERE id = ?").get(examQuestion.id)), profile: toQuestionProfile(row) }));
}));

router.post("/exam/ingest/manual", requireAuth, (req, res) => {
  const paper = req.body.paper || {};
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  const sourceName = requireString(paper.source_name, "来源名称");
  const licenseNote = requireString(paper.license_note, "使用边界说明");
  const paperId = typeof paper.id === "string" && paper.id.trim() ? paper.id.trim() : randomUUID();
  const createdAt = nowIso();
  const year = Number(paper.year || new Date().getFullYear());
  const region = requireString(paper.region || "未标注", "地区");
  const subject = requireString(paper.subject || "数学", "学科");
  const title = requireString(paper.title || "未命名试卷", "试卷标题");

  if (questions.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "至少需要导入一道题。");
  }
  if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1) {
    throw new AppError(400, "VALIDATION_ERROR", "试卷年份不合法。");
  }

  // 所有权保护：已存在的试卷/题目只有其导入者本人可以覆盖；公共内容（owner 为 NULL）一律禁改。
  const existingPaper = db.prepare("SELECT owner_user_id FROM exam_papers WHERE id = ?").get(paperId);
  if (existingPaper && existingPaper.owner_user_id !== req.user.id) {
    throw new AppError(403, "FORBIDDEN", "这份试卷不属于你，不能覆盖。请换一个试卷 ID。");
  }

  const normalizedQuestions = questions.map((item, index) => {
    const questionNumber = String(item.question_number || index + 1);
    return {
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID(),
      questionNumber,
      questionType: typeof item.question_type === "string" && item.question_type.trim() ? item.question_type.trim() : "未标注",
      contentText: requireString(item.content_text, `第 ${questionNumber} 题题目内容`),
      officialAnswerText: requireString(item.official_answer_text, `第 ${questionNumber} 题参考答案`),
      knowledgeTags: normalizeKnowledgeTags(subject, item.knowledge_tags),
      difficulty: ["easy", "medium", "hard"].includes(item.difficulty) ? item.difficulty : "medium",
      title: typeof item.title === "string" && item.title.trim()
        ? item.title.trim()
        : `${title} · 第 ${questionNumber} 题`
    };
  });

  const duplicateIds = normalizedQuestions
    .map((item) => item.id)
    .filter((id, index, items) => items.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new AppError(400, "VALIDATION_ERROR", `导入内容包含重复题目 ID：${duplicateIds[0]}`);
  }

  const jobId = randomUUID();
  let createdCount = 0;
  let updatedCount = 0;

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO exam_papers (
        id, year, region, subject, title, source_name, source_url, license_note, status, created_at, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        year = excluded.year,
        region = excluded.region,
        subject = excluded.subject,
        title = excluded.title,
        source_name = excluded.source_name,
        source_url = excluded.source_url,
        license_note = excluded.license_note
    `).run(paperId, year, region, subject, title, sourceName, paper.source_url || null, licenseNote, createdAt, req.user.id);

    for (const item of normalizedQuestions) {
      const existing = db.prepare(`
        SELECT q.id, p.owner_user_id FROM exam_questions q
        JOIN exam_papers p ON p.id = q.paper_id
        WHERE q.id = ?
      `).get(item.id);
      if (existing && existing.owner_user_id !== req.user.id) {
        throw new AppError(403, "FORBIDDEN", `题目 ${item.id} 不属于你，不能覆盖。请换一个题目 ID。`);
      }
      if (existing) {
        updatedCount += 1;
        db.prepare("DELETE FROM ai_question_profiles WHERE exam_question_id = ?").run(item.id);
      } else {
        createdCount += 1;
      }

      db.prepare(`
        INSERT INTO exam_questions (
          id, paper_id, question_number, subject, question_type, content_text,
          official_answer_text, source, knowledge_tags_json, difficulty, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_profile', ?)
        ON CONFLICT(id) DO UPDATE SET
          paper_id = excluded.paper_id,
          question_number = excluded.question_number,
          subject = excluded.subject,
          question_type = excluded.question_type,
          content_text = excluded.content_text,
          official_answer_text = excluded.official_answer_text,
          source = excluded.source,
          knowledge_tags_json = excluded.knowledge_tags_json,
          difficulty = excluded.difficulty,
          status = 'needs_profile'
      `).run(
        item.id,
        paperId,
        item.questionNumber,
        subject,
        item.questionType,
        item.contentText,
        item.officialAnswerText,
        sourceName,
        JSON.stringify(item.knowledgeTags),
        item.difficulty,
        createdAt
      );

      db.prepare(`
        INSERT INTO practice_questions (
          id, subject, title, source, content_text, official_answer_text,
          knowledge_tags_json, difficulty, created_at, exam_question_id, owner_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          subject = excluded.subject,
          title = excluded.title,
          source = excluded.source,
          content_text = excluded.content_text,
          official_answer_text = excluded.official_answer_text,
          knowledge_tags_json = excluded.knowledge_tags_json,
          difficulty = excluded.difficulty
      `).run(
        `practice-${item.id}`,
        subject,
        item.title,
        sourceName,
        item.contentText,
        item.officialAnswerText,
        JSON.stringify(item.knowledgeTags),
        item.difficulty,
        createdAt,
        item.id,
        req.user.id
      );
    }

    const message = updatedCount > 0
      ? `结构化导入完成：新增 ${createdCount} 题，更新 ${updatedCount} 题。`
      : `结构化导入完成：新增 ${createdCount} 题。`;
    db.prepare(`
      INSERT INTO ingestion_jobs (id, source_name, source_url, status, message, imported_count, created_at)
      VALUES (?, ?, ?, 'completed', ?, ?, ?)
    `).run(jobId, sourceName, paper.source_url || null, message, normalizedQuestions.length, createdAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  res.json(ok({
    job_id: jobId,
    paper_id: paperId,
    imported_count: normalizedQuestions.length,
    created_count: createdCount,
    updated_count: updatedCount,
    practice_count: normalizedQuestions.length
  }));
});

router.post("/exam/ingest/pdf", requireAuth, (_req, res) => {
  return fail(
    res,
    410,
    "ENDPOINT_DEPRECATED",
    "旧版整页导入已停用，请使用 /import/pipeline/upload 结构化导入流水线。"
  );
});

router.get("/exam/ingestion/jobs", requireAuth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM ingestion_jobs ORDER BY created_at DESC LIMIT 20").all();
  res.json(ok({ items: rows.map(toIngestionJob) }));
});

router.get("/collections", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COUNT(cq.exam_question_id) AS question_count,
      (c.user_id = ?) AS is_owner,
      EXISTS(
        SELECT 1 FROM practice_sessions ps
        WHERE ps.collection_id = c.id AND ps.user_id = ? AND ps.status = 'completed'
      ) AS is_completed
    FROM question_collections c
    LEFT JOIN collection_questions cq ON cq.collection_id = c.id
    WHERE c.user_id = ? OR c.user_id IS NULL OR c.is_shared = 1
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.title
  `).all(req.user.id, req.user.id, req.user.id);
  res.json(ok({ items: rows.map(toQuestionCollection) }));
});

router.get("/collections/:collectionId", requireAuth, (req, res) => {
  const collection = collectionRow(req.params.collectionId, req.user.id);
  if (!collection) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题库。");
  const questions = db.prepare(`
    SELECT eq.*
    FROM collection_questions cq
    JOIN exam_questions eq ON eq.id = cq.exam_question_id
    WHERE cq.collection_id = ?
    ORDER BY cq.position
  `).all(collection.id);
  res.json(ok({ collection: toQuestionCollection(collection), questions: questions.map(toExamQuestion) }));
});

router.patch("/collections/:collectionId", requireAuth, (req, res) => {
  const collection = db.prepare("SELECT * FROM question_collections WHERE id = ? AND user_id = ?").get(req.params.collectionId, req.user.id);
  if (!collection) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到可编辑的个人题库。");
  const title = typeof req.body.title === "string" ? req.body.title.trim() : collection.title;
  const description = typeof req.body.description === "string" ? req.body.description.trim() : collection.description;
  const coverStyle = ["mint", "blue", "clay", "ink"].includes(req.body.cover_style) ? req.body.cover_style : collection.cover_style;
  if (!title) throw new AppError(400, "VALIDATION_ERROR", "题库名称不能为空。");
  db.prepare("UPDATE question_collections SET title = ?, description = ?, cover_style = ? WHERE id = ?")
    .run(title, description, coverStyle, collection.id);
  res.json(ok(toQuestionCollection(collectionRow(collection.id, req.user.id))));
});

router.delete("/collections/:collectionId", requireAuth, (req, res) => {
  const collection = db.prepare("SELECT * FROM question_collections WHERE id = ? AND user_id = ?").get(req.params.collectionId, req.user.id);
  if (!collection) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到可删除的个人题库。");
  // 不限定 user_id：共享题库可能已被他人练习，删除会连带清掉他人的学习记录
  const completedCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM practice_sessions
    WHERE collection_id = ? AND status = 'completed'
  `).get(collection.id).cnt;
  if (completedCount > 0) {
    throw new AppError(409, "VALIDATION_ERROR", "这份题库已有完成记录（可能包含其他同学的），为保留学习数据不能删除。");
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM practice_sessions WHERE collection_id = ?").run(collection.id);
    db.prepare("DELETE FROM collection_questions WHERE collection_id = ?").run(collection.id);
    db.prepare("DELETE FROM question_collections WHERE id = ?").run(collection.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.json(ok({ id: collection.id }));
});

// ——— 共享题库开关（仅 owner）———
// 共享 = 题库对全体用户可见可练；同步共享底层试卷与练习题，保证做题链路可访问。
// 版权红线：仅限自己创作或有权分享的内容；发现侵权内容 owner 有义务取消共享。
router.patch("/collections/:collectionId/share", requireAuth, (req, res) => {
  const collection = db.prepare("SELECT * FROM question_collections WHERE id = ? AND user_id = ?")
    .get(req.params.collectionId, req.user.id);
  if (!collection) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到可操作的个人题库。");
  const shared = req.body.shared === true ? 1 : 0;

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE question_collections SET is_shared = ? WHERE id = ?").run(shared, collection.id);
    if (collection.source_paper_id) {
      db.prepare("UPDATE exam_papers SET is_shared = ? WHERE id = ? AND owner_user_id = ?")
        .run(shared, collection.source_paper_id, req.user.id);
    }
    db.prepare(`
      UPDATE practice_questions SET is_shared = ?
      WHERE owner_user_id = ? AND exam_question_id IN (
        SELECT exam_question_id FROM collection_questions WHERE collection_id = ?
      )
    `).run(shared, req.user.id, collection.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.json(ok(toQuestionCollection(collectionRow(collection.id, req.user.id))));
});

router.post("/collections", requireAuth, (req, res) => {
  const title = requireString(req.body.title, "题库名称");
  const questionIds = Array.isArray(req.body.question_ids) ? [...new Set(req.body.question_ids.filter((id) => typeof id === "string"))] : [];
  if (questionIds.length === 0) throw new AppError(400, "VALIDATION_ERROR", "至少选择一道题。");
  const placeholders = questionIds.map(() => "?").join(",");
  const existing = db.prepare(`
    SELECT q.id FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    WHERE q.id IN (${placeholders}) AND (p.owner_user_id IS NULL OR p.owner_user_id = ? OR p.is_shared = 1)
  `).all(...questionIds, req.user.id);
  if (existing.length !== questionIds.length) throw new AppError(400, "VALIDATION_ERROR", "选择的题目中有不存在的记录。");
  const collection = createCollection({
    userId: req.user.id,
    title,
    description: typeof req.body.description === "string" ? req.body.description.trim() : "个人手动整理题库",
    subject: typeof req.body.subject === "string" ? req.body.subject : "数学",
    creationMode: "manual",
    coverStyle: "mint",
    sourcePaperId: null,
    questionIds
  });
  res.json(ok(collection));
});

router.post("/collections/ai", requireAuth, asyncRoute(async (req, res) => {
  const strategy = req.body.strategy === "weakness" ? "weakness" : "knowledge";
  const subject = requireString(req.body.subject || "数学", "学科");
  const knowledgeTag = typeof req.body.knowledge_tag === "string" ? req.body.knowledge_tag.trim() : "";
  if (strategy === "knowledge" && !knowledgeTag) throw new AppError(400, "VALIDATION_ERROR", "请选择一个知识点。");
  const questionCount = Math.min(20, Math.max(3, Number(req.body.question_count || 8)));
  const rows = db.prepare(`
    SELECT q.* FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    WHERE q.subject = ? AND (p.owner_user_id IS NULL OR p.owner_user_id = ?)
    ORDER BY q.created_at DESC
  `).all(subject, req.user.id);
  const candidates = rows.map(toExamQuestion);
  const weakTags = practiceWeakTags(req.user.id).slice(0, 5).map((item) => item.tag);
  const focused = strategy === "knowledge"
    ? candidates.filter((item) => item.knowledge_tags.some((tag) => tag.includes(knowledgeTag) || knowledgeTag.includes(tag)))
    : candidates.filter((item) => weakTags.length === 0 || item.knowledge_tags.some((tag) => weakTags.includes(tag)));
  const pool = (focused.length >= 3 ? focused : candidates).slice(0, 80);
  ensureAiConfigured();
  const built = await withAiQuota(req.user.id, () =>
    buildQuestionCollection({ strategy, knowledgeTag, weakTags, candidates: pool, questionCount: Math.min(questionCount, pool.length) })
  );
  const validIds = new Set(pool.map((item) => item.id));
  const selectedIds = Array.isArray(built.selected_ids)
    ? [...new Set(built.selected_ids.filter((id) => validIds.has(id)))].slice(0, questionCount)
    : [];
  for (const item of pool) {
    if (selectedIds.length >= Math.min(questionCount, pool.length)) break;
    if (!selectedIds.includes(item.id)) selectedIds.push(item.id);
  }
  const collection = createCollection({
    userId: req.user.id,
    title: built.title || (strategy === "weakness" ? "AI 薄弱项强化卷" : `${knowledgeTag} 专项卷`),
    description: built.description || "AI 根据当前学习数据与难度梯度完成组卷。",
    subject,
    creationMode: strategy === "weakness" ? "ai_weakness" : "ai_knowledge",
    coverStyle: strategy === "weakness" ? "clay" : "mint",
    sourcePaperId: null,
    questionIds: selectedIds
  });
  res.json(ok(collection));
}));

router.post("/collections/:collectionId/sessions", requireAuth, (req, res) => {
  const collection = collectionRow(req.params.collectionId, req.user.id);
  if (!collection) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个题库。");
  const sessionId = randomUUID();
  const gradingMode = req.body.grading_mode === "unified" ? "unified" : "individual";
  db.prepare(`
    INSERT INTO practice_sessions (id, user_id, collection_id, status, current_position, started_at, grading_mode)
    VALUES (?, ?, ?, 'active', 0, ?, ?)
  `).run(sessionId, req.user.id, collection.id, nowIso(), gradingMode);
  res.json(ok({ id: sessionId, collection_id: collection.id, status: "active", current_position: 0, grading_mode: gradingMode }));
});

router.patch("/practice/sessions/:sessionId/complete", requireAuth, (req, res) => {
  const session = db.prepare("SELECT * FROM practice_sessions WHERE id = ? AND user_id = ?")
    .get(req.params.sessionId, req.user.id);
  if (!session) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这次练习记录。");
  const completedAt = nowIso();
  db.prepare("UPDATE practice_sessions SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(completedAt, session.id);
  res.json(ok({ id: session.id, status: "completed", completed_at: completedAt }));
});

router.get("/practice/questions/current", requireAuth, (req, res) => {
  const subject = typeof req.query.subject === "string" ? req.query.subject : "数学";
  const afterId = typeof req.query.after_id === "string" ? req.query.after_id : null;
  let row = afterId
    ? db.prepare(`
        SELECT * FROM practice_questions
        WHERE subject = ? AND id > ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)
        ORDER BY id ASC
        LIMIT 1
      `).get(subject, afterId, req.user.id)
    : null;

  if (!row) {
    row = db.prepare(`
      SELECT * FROM practice_questions
      WHERE subject = ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)
      ORDER BY id ASC
      LIMIT 1
    `).get(subject, req.user.id);
  }

  if (!row) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "暂时没有这个学科的练习题。");
  }

  const latestAttempt = db.prepare(`
    SELECT * FROM practice_attempts
    WHERE user_id = ? AND practice_question_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(req.user.id, row.id);

  res.json(ok({
    question: toPracticeQuestion(row, { includeAnswer: Boolean(latestAttempt) }),
    latest_attempt: latestAttempt ? toPracticeAttempt(latestAttempt) : null
  }));
});

router.get("/practice/questions/:questionId", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM practice_questions WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)")
    .get(req.params.questionId, req.user.id);
  if (!row) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道练习题。");
  }
  const latestAttempt = db.prepare(`
    SELECT * FROM practice_attempts
    WHERE user_id = ? AND practice_question_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(req.user.id, row.id);

  res.json(ok({
    question: toPracticeQuestion(row, { includeAnswer: Boolean(latestAttempt) }),
    latest_attempt: latestAttempt ? toPracticeAttempt(latestAttempt) : null
  }));
});

router.get("/practice/attempts", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM practice_attempts
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(req.user.id);

  res.json(ok({ items: rows.map(toPracticeAttempt) }));
});

router.post("/practice/questions/:questionId/attempt", requireAuth, asyncRoute(async (req, res) => {
  const answerText = requireString(req.body.answer_text, "你的作答");
  const questionRow = db.prepare("SELECT * FROM practice_questions WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)")
    .get(req.params.questionId, req.user.id);
  if (!questionRow) {
    throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道练习题。");
  }

  const evaluationQuestion = toPracticeQuestion(questionRow, { includeAnswer: true });
  const evaluationStartedAt = Date.now();
  const { evaluation, fromCache } = await evaluatePracticeWithCache({
    userId: req.user.id,
    practiceQuestion: evaluationQuestion,
    answerText
  });

  const attemptId = randomUUID();
  const stepBreakdown = Array.isArray(evaluation.step_breakdown) ? evaluation.step_breakdown : [];
  const score = Number.isFinite(Number(evaluation.score)) ? Math.max(0, Math.min(100, Number(evaluation.score))) : 0;
  const isCorrect = Boolean(evaluation.is_correct) || score >= 80;
  const createdAt = nowIso();

  db.prepare(`
    INSERT INTO practice_attempts (
      id, user_id, practice_question_id, answer_text, is_correct, score,
      feedback_text, step_breakdown_json, next_action, created_at, from_cache
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attemptId,
    req.user.id,
    evaluationQuestion.id,
    answerText,
    isCorrect ? 1 : 0,
    score,
    evaluation.feedback_text || "这次作答已完成评阅。",
    JSON.stringify(stepBreakdown),
    evaluation.next_action || "复盘本道题的关键步骤后，再独立重做一遍。",
    createdAt,
    fromCache ? 1 : 0
  );

  if (!isCorrect) {
    const tags = normalizeKnowledgeTags(
      evaluationQuestion.subject,
      Array.isArray(evaluation.knowledge_tags) && evaluation.knowledge_tags.length
        ? evaluation.knowledge_tags
        : evaluationQuestion.knowledge_tags
    );
    for (const tag of tags.slice(0, 3)) {
      upsertLearningPathItem({
        userId: req.user.id,
        knowledgeTag: tag,
        reason: `本题得分 ${Math.round(score)}，${tag} 暴露出需要巩固的步骤。`,
        recommendedAction: evaluation.next_action || "复盘关键步骤后再独立完成一道同类题。",
        relatedQuestionIds: evaluationQuestion.exam_question_id ? [evaluationQuestion.exam_question_id] : [],
        source: "practice_evaluation"
      });
    }

    // v2: 自动生成间隔复习任务（当天/3天/7天/14天）
    if (!req.body.review_task_id) {
      try {
        createReviewTasks({
          userId: req.user.id,
          subject: evaluationQuestion.subject,
          knowledgeTags: tags,
          difficulty: evaluationQuestion.difficulty || "medium",
          sourceQuestionId: evaluationQuestion.id,
          sourceQuestionType: "practice"
        });
      } catch {
        // 复习任务创建失败不影响主流程
      }
    }
  }

  const attempt = toPracticeAttempt(db.prepare("SELECT * FROM practice_attempts WHERE id = ?").get(attemptId));
  res.json(ok({ question: evaluationQuestion, attempt, cached: fromCache, elapsed_ms: Date.now() - evaluationStartedAt }));
}));

router.post("/practice/questions/:questionId/follow-up", requireAuth, asyncRoute(async (req, res) => {
  const contentText = requireString(req.body.content_text, "追问内容");
  const questionRow = db.prepare("SELECT * FROM practice_questions WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ? OR is_shared = 1)")
    .get(req.params.questionId, req.user.id);
  if (!questionRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道练习题。");
  const attemptRow = typeof req.body.attempt_id === "string"
    ? db.prepare("SELECT * FROM practice_attempts WHERE id = ? AND user_id = ? AND practice_question_id = ?")
      .get(req.body.attempt_id, req.user.id, questionRow.id)
    : null;
  const attempt = attemptRow ? toPracticeAttempt(attemptRow) : null;
  const contextType = ["question", "feedback", "step", "answer", "analysis"].includes(req.body.context_type)
    ? req.body.context_type
    : "analysis";
  const contextText = typeof req.body.context_text === "string" ? req.body.context_text.trim().slice(0, 3000) : "";

  ensureAiConfigured();
  const practiceQuestion = toPracticeQuestion(questionRow, { includeAnswer: true });
  const reply = await withAiQuota(req.user.id, () => generatePracticeFollowUp({
    practiceQuestion, attempt, contentText, contextType, contextText
  }));
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO practice_follow_ups (
      id, user_id, practice_question_id, attempt_id, context_type, context_text, content_text, reply_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, questionRow.id, attempt?.id || null, contextType, contextText, contentText, reply.reply_text, createdAt);
  res.json(ok({ id, reply_text: reply.reply_text, context_type: contextType, context_text: contextText, created_at: createdAt }));
}));

router.post("/questions", requireAuth, asyncRoute(async (req, res) => {
  const subject = requireString(req.body.subject, "学科");
  const mode = requireString(req.body.mode, "提问模式");
  const contentText = requireString(req.body.content_text, "题目内容");
  const officialAnswerText = typeof req.body.official_answer_text === "string" ? req.body.official_answer_text.trim() : null;

  if (!["solve_from_scratch", "deepen_official_answer"].includes(mode)) {
    throw new AppError(400, "VALIDATION_ERROR", "提问模式不合法。");
  }
  if (mode === "deepen_official_answer" && !officialAnswerText) {
    throw new AppError(400, "VALIDATION_ERROR", "深化官方答案模式需要填写官方答案。");
  }

  ensureAiConfigured();

  // 先落库，状态为 pending
  const questionId = randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO questions (
      id, user_id, subject, mode, content_text, content_image_url,
      official_answer_text, official_answer_image_url, knowledge_tags_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, '[]', 'pending', ?)
  `).run(questionId, req.user.id, subject, mode, contentText, officialAnswerText, createdAt);

  try {
    const aiAnswer = await withAiQuota(req.user.id, () => generateAnswer({
      subject,
      mode,
      contentText,
      officialAnswerText,
      canonicalTags: canonicalTagsForSubject(subject)
    }));
    const knowledgeTags = normalizeKnowledgeTags(subject, aiAnswer.knowledge_tags);
    const answerId = randomUUID();

    db.prepare("UPDATE questions SET knowledge_tags_json = ?, status = 'answered' WHERE id = ?")
      .run(JSON.stringify(knowledgeTags), questionId);

    db.prepare(`
      INSERT INTO answers (
        id, question_id, hint_text, step_breakdown_json, full_solution_text, revealed_full_solution, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      answerId,
      questionId,
      aiAnswer.hint_text || null,
      JSON.stringify(Array.isArray(aiAnswer.step_breakdown) ? aiAnswer.step_breakdown : []),
      aiAnswer.full_solution_text || null,
      mode === "deepen_official_answer" ? 1 : 0,
      createdAt
    );

    const question = toQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId));
    const answer = toAnswer(db.prepare("SELECT * FROM answers WHERE question_id = ?").get(questionId));
    res.json(ok({ question, answer }));
  } catch (error) {
    // AI 调用失败，更新状态为 failed，不扣配额
    db.prepare("UPDATE questions SET status = 'failed' WHERE id = ?").run(questionId);
    throw error;
  }
}));

router.post("/questions/image", requireAuth, asyncRoute(async (req, res) => {
  const subject = requireString(req.body.subject, "学科");
  const imageDataUrl = requireString(req.body.image_data_url, "题目图片");
  const match = imageDataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new AppError(400, "VALIDATION_ERROR", "请上传 PNG、JPEG 或 WebP 格式的题目图片。");
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
    throw new AppError(400, "VALIDATION_ERROR", "题目图片不能超过 8MB。");
  }

  ensureAiConfigured();
  const questionId = randomUUID();
  const extension = match[1] === "jpeg" || match[1] === "jpg" ? "jpg" : match[1];
  const fileName = `question-${questionId}.${extension}`;
  const uploadDir = resolve(config.uploadDir);
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(resolve(uploadDir, fileName), buffer);
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO questions (
      id, user_id, subject, mode, content_text, content_image_url,
      official_answer_text, official_answer_image_url, knowledge_tags_json, status, created_at
    ) VALUES (?, ?, ?, 'solve_from_scratch', '图片题目识别中', ?, NULL, NULL, '[]', 'pending', ?)
  `).run(questionId, req.user.id, subject, `/uploads/${fileName}`, createdAt);

  try {
    const recognized = await withAiQuota(req.user.id, () => recognizeQuestionImage({
      subject,
      imageDataUrl,
      canonicalTags: canonicalTagsForSubject(subject)
    }));
    const contentText = requireString(recognized.recognized_text, "AI 识别结果");
    const tags = normalizeKnowledgeTags(subject, recognized.knowledge_tags);
    db.prepare("UPDATE questions SET content_text = ?, knowledge_tags_json = ?, status = 'answered' WHERE id = ?")
      .run(contentText, JSON.stringify(tags), questionId);
    db.prepare(`
      INSERT INTO answers (
        id, question_id, hint_text, step_breakdown_json, full_solution_text, revealed_full_solution, created_at
      ) VALUES (?, ?, ?, ?, NULL, 0, ?)
    `).run(
      randomUUID(),
      questionId,
      recognized.hint_text || "先辨认题目条件与所求量，再选择对应知识点。",
      JSON.stringify(Array.isArray(recognized.step_breakdown) ? recognized.step_breakdown : []),
      createdAt
    );
    res.status(201).json(ok({
      question: toQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId)),
      answer: toAnswer(db.prepare("SELECT * FROM answers WHERE question_id = ?").get(questionId))
    }));
  } catch (error) {
    db.prepare("UPDATE questions SET status = 'failed' WHERE id = ?").run(questionId);
    throw error;
  }
}));

router.get("/questions/:questionId/answer", requireAuth, (req, res) => {
  const question = db.prepare("SELECT * FROM questions WHERE id = ? AND user_id = ?").get(req.params.questionId, req.user.id);
  if (!question) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道题。");
  const answer = db.prepare("SELECT * FROM answers WHERE question_id = ?").get(req.params.questionId);
  res.json(ok({ question: toQuestion(question), answer: toAnswer(answer) }));
});

router.get("/questions", requireAuth, (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size || 20)));
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const offset = (page - 1) * pageSize;

  let sql = "SELECT * FROM questions WHERE user_id = ?";
  const params = [req.user.id];

  if (status && ["pending", "answered", "failed"].includes(status)) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(pageSize, offset);

  const rows = db.prepare(sql).all(...params);
  const countSql = status
    ? "SELECT COUNT(*) AS total FROM questions WHERE user_id = ? AND status = ?"
    : "SELECT COUNT(*) AS total FROM questions WHERE user_id = ?";
  const countParams = status ? [req.user.id, status] : [req.user.id];
  const total = db.prepare(countSql).get(...countParams).total;

  const items = rows.map(toQuestion);
  res.json(ok({ items, pagination: { page, page_size: pageSize, total } }));
});

router.post("/questions/:questionId/retry", requireAuth, asyncRoute(async (req, res) => {
  const questionRow = db.prepare("SELECT * FROM questions WHERE id = ? AND user_id = ?").get(req.params.questionId, req.user.id);
  if (!questionRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道题。");
  const question = toQuestion(questionRow);
  if (question.status !== "failed") {
    throw new AppError(400, "VALIDATION_ERROR", "只有失败的题目才能重试。");
  }

  ensureAiConfigured();

  try {
    const aiAnswer = await withAiQuota(req.user.id, () => generateAnswer({
      subject: question.subject,
      mode: question.mode,
      contentText: question.content_text,
      officialAnswerText: question.official_answer_text,
      canonicalTags: canonicalTagsForSubject(question.subject)
    }));

    const knowledgeTags = normalizeKnowledgeTags(question.subject, aiAnswer.knowledge_tags);
    const answerId = randomUUID();

    db.prepare("UPDATE questions SET knowledge_tags_json = ?, status = 'answered' WHERE id = ?")
      .run(JSON.stringify(knowledgeTags), question.id);

    db.prepare(`
      INSERT INTO answers (id, question_id, hint_text, step_breakdown_json, full_solution_text, revealed_full_solution, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      answerId, question.id,
      aiAnswer.hint_text || null,
      JSON.stringify(Array.isArray(aiAnswer.step_breakdown) ? aiAnswer.step_breakdown : []),
      aiAnswer.full_solution_text || null,
      question.mode === "deepen_official_answer" ? 1 : 0,
      nowIso()
    );

    const answer = toAnswer(db.prepare("SELECT * FROM answers WHERE question_id = ?").get(question.id));
    res.json(ok({       question: toQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(question.id)), answer }));
  } catch (error) {
    // withAiQuota 已自动回滚配额
    db.prepare("UPDATE questions SET status = 'failed' WHERE id = ?").run(question.id);
    throw error;
  }
}));

router.post("/questions/:questionId/reveal-solution", requireAuth, asyncRoute(async (req, res) => {
  const questionRow = db.prepare("SELECT * FROM questions WHERE id = ? AND user_id = ?").get(req.params.questionId, req.user.id);
  if (!questionRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道题。");
  const answerRow = db.prepare("SELECT * FROM answers WHERE question_id = ?").get(req.params.questionId);
  if (!answerRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道题的讲解。");

  const question = toQuestion(questionRow);
  let answer = toAnswer(answerRow);
  if (!answer.full_solution_text) {
    ensureAiConfigured();
    const generated = await withAiQuota(req.user.id, () => generateFullSolution({
      subject: question.subject,
      contentText: question.content_text,
      previousHint: answer.hint_text
    }));
    db.prepare("UPDATE answers SET full_solution_text = ?, revealed_full_solution = 1 WHERE question_id = ?")
      .run(generated.full_solution_text, question.id);
  } else {
    db.prepare("UPDATE answers SET revealed_full_solution = 1 WHERE question_id = ?").run(question.id);
  }

  const mistake = db.prepare("SELECT * FROM mistake_records WHERE user_id = ? AND question_id = ?").get(req.user.id, question.id);
  if (mistake) {
    db.prepare("UPDATE mistake_records SET mistake_count = mistake_count + 1 WHERE id = ?").run(mistake.id);
  } else {
    db.prepare(`
      INSERT INTO mistake_records (id, user_id, question_id, knowledge_tags_json, mistake_count, mastery_status, last_reviewed_at)
      VALUES (?, ?, ?, ?, 1, 'weak', NULL)
    `).run(randomUUID(), req.user.id, question.id, JSON.stringify(normalizeKnowledgeTags(question.subject, question.knowledge_tags)));
  }

  for (const tag of normalizeKnowledgeTags(question.subject, question.knowledge_tags).slice(0, 3)) {
    upsertLearningPathItem({
      userId: req.user.id,
      knowledgeTag: tag,
      reason: `你查看了 ${tag} 相关题目的完整解答，建议安排一次主动复现。`,
      recommendedAction: "合上解析独立重做，再用一句话写出本题的关键依据。",
      relatedQuestionIds: [question.id],
      source: "solution_reveal"
    });
  }

  answer = toAnswer(db.prepare("SELECT * FROM answers WHERE question_id = ?").get(question.id));
  res.json(ok(answer));
}));

router.post("/questions/:questionId/follow-up", requireAuth, asyncRoute(async (req, res) => {
  const contentText = requireString(req.body.content_text, "追问内容");
  const questionRow = db.prepare("SELECT * FROM questions WHERE id = ? AND user_id = ?").get(req.params.questionId, req.user.id);
  if (!questionRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道题。");
  const answerRow = db.prepare("SELECT * FROM answers WHERE question_id = ?").get(req.params.questionId);
  if (!answerRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道题的讲解。");

  ensureAiConfigured();
  const question = toQuestion(questionRow);
  const answer = toAnswer(answerRow);
  const reply = await withAiQuota(req.user.id, () => generateFollowUp({ question, answer, contentText }));
  db.prepare(`
    INSERT INTO follow_ups (id, question_id, user_id, content_text, reply_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), question.id, req.user.id, contentText, reply.reply_text, nowIso());

  res.json(ok({ reply_text: reply.reply_text }));
}));

router.get("/mistakes", requireAuth, (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size || 20)));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`
    SELECT * FROM mistake_records
    WHERE user_id = ?
    ORDER BY mistake_count DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, pageSize, offset);
  const total = db.prepare("SELECT COUNT(*) AS total FROM mistake_records WHERE user_id = ?").get(req.user.id).total;
  const items = rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    question_id: row.question_id,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    mistake_count: row.mistake_count,
    mastery_status: row.mastery_status,
    last_reviewed_at: row.last_reviewed_at
  }));
  res.json(ok({ items, pagination: { page, page_size: pageSize, total } }));
});

router.patch("/mistakes/:mistakeId", requireAuth, (req, res) => {
  const masteryStatus = requireString(req.body.mastery_status, "复习状态");
  if (!["weak", "reviewing", "mastered"].includes(masteryStatus)) {
    return fail(res, 400, "VALIDATION_ERROR", "复习状态不合法。");
  }
  const result = db.prepare("UPDATE mistake_records SET mastery_status = ?, last_reviewed_at = ? WHERE id = ? AND user_id = ?")
    .run(masteryStatus, nowIso(), req.params.mistakeId, req.user.id);
  if (!result.changes) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这条错题记录。");
  }
  res.json(ok({ id: req.params.mistakeId, mastery_status: masteryStatus }));
});

router.get("/mistakes/stats", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT knowledge_tags_json, mistake_count FROM mistake_records WHERE user_id = ?").all(req.user.id);
  const counts = new Map();
  let total = 0;
  for (const row of rows) {
    const tags = parseJson(row.knowledge_tags_json, []);
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) || 0) + row.mistake_count);
      total += row.mistake_count;
    }
  }
  const tags = [...counts.entries()].map(([knowledge_tag, mistake_count]) => ({
    knowledge_tag,
    mistake_count,
    error_rate: total ? Number((mistake_count / total).toFixed(2)) : 0
  }));
  res.json(ok({ tags }));
});

router.post("/learning-path/generate", requireAuth, asyncRoute(async (req, res) => {
  const weaknesses = collectWeaknesses(req.user.id);
  if (!weaknesses.length) {
    return res.json(ok({ items: [], message: "完成并提交几道题后，系统会根据低分项生成学习路径。" }));
  }

  ensureAiConfigured();
  const weakTagSet = new Set(weaknesses.map((item) => `${item.subject}:${item.knowledge_tag}`));
  const candidateRows = db.prepare(`
    SELECT q.* FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    WHERE p.owner_user_id IS NULL OR p.owner_user_id = ?
    ORDER BY q.created_at DESC
  `).all(req.user.id);
  const candidates = candidateRows
    .filter((row) => normalizeKnowledgeTags(row.subject, parseJson(row.knowledge_tags_json, []))
      .some((tag) => weakTagSet.has(`${row.subject}:${tag}`)))
    .slice(0, 40)
    .map((row) => ({
      id: row.id,
      subject: row.subject,
      question_number: row.question_number,
      knowledge_tags: normalizeKnowledgeTags(row.subject, parseJson(row.knowledge_tags_json, [])),
      difficulty: row.difficulty
    }));
  const involvedSubjects = [...new Set(weaknesses.map((item) => item.subject))];
  const generated = await withAiQuota(req.user.id, () => generateLearningPath({
    weaknesses,
    candidates,
    canonicalTags: involvedSubjects.flatMap(canonicalTagsForSubject)
  }));

  for (const item of Array.isArray(generated.items) ? generated.items.slice(0, 5) : []) {
    const matchingWeakness = weaknesses.find((weakness) =>
      normalizeKnowledgeTags(weakness.subject, [item.knowledge_tag]).includes(weakness.knowledge_tag)
    );
    if (!matchingWeakness) continue;
    const tag = normalizeKnowledgeTags(matchingWeakness.subject, [item.knowledge_tag])[0];
    if (!tag) continue;
    const allowedQuestionIds = new Set(candidates.filter((candidate) => candidate.subject === matchingWeakness.subject).map((candidate) => candidate.id));
    const relatedQuestionIds = (Array.isArray(item.related_question_ids) ? item.related_question_ids : [])
      .filter((id) => allowedQuestionIds.has(id));
    upsertLearningPathItem({
      userId: req.user.id,
      knowledgeTag: tag,
      reason: typeof item.reason === "string" ? item.reason : `${tag} 是当前优先薄弱项。`,
      recommendedAction: typeof item.recommended_action === "string" ? item.recommended_action : "先复盘概念，再完成一道同类题。",
      relatedQuestionIds,
      source: "ai_generated"
    });
  }

  const rows = db.prepare("SELECT * FROM learning_path_items WHERE user_id = ? AND status = 'pending' ORDER BY generated_at DESC").all(req.user.id);
  res.json(ok({ items: rows.map((row) => ({
    id: row.id,
    knowledge_tag: row.knowledge_tag,
    reason: row.reason,
    recommended_action: row.recommended_action,
    related_question_ids: parseJson(row.related_question_ids_json, []),
    status: row.status,
    source: row.source,
    generated_at: row.generated_at
  })) }));
}));

router.get("/learning-path", requireAuth, (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  const rows = db.prepare("SELECT * FROM learning_path_items WHERE user_id = ? AND status = ? ORDER BY generated_at DESC").all(req.user.id, status);
  const items = rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    knowledge_tag: row.knowledge_tag,
    reason: row.reason,
    recommended_action: row.recommended_action,
    related_question_ids: parseJson(row.related_question_ids_json, []),
    status: row.status,
    source: row.source,
    generated_at: row.generated_at
  }));
  res.json(ok({ items }));
});

router.patch("/learning-path/:itemId", requireAuth, (req, res) => {
  const status = requireString(req.body.status, "推荐状态");
  if (!["pending", "done", "dismissed"].includes(status)) {
    return fail(res, 400, "VALIDATION_ERROR", "推荐状态不合法。");
  }
  const result = db.prepare("UPDATE learning_path_items SET status = ? WHERE id = ? AND user_id = ?").run(status, req.params.itemId, req.user.id);
  if (!result.changes) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这条学习路径推荐。");
  }
  res.json(ok({ id: req.params.itemId, status }));
});
