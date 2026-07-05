import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import express from "express";
import { db, nowIso, parseJson, toAnswer, toQuestion, toUser } from "./db.js";
import { requireAuth, signToken } from "./auth.js";
import { AppError, asyncRoute, fail, ok } from "./http.js";
import { config } from "./config.js";
import { ensureAiConfigured, generateAnswer, generateFollowUp, generateFullSolution } from "./ai.js";

export const router = express.Router();

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, "VALIDATION_ERROR", `${label}不能为空。`);
  }
  return value.trim();
}

function consumeAiQuota(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND used_on = ?").get(userId, today);
  if (row && row.count >= config.aiDailyLimit) {
    throw new AppError(429, "RATE_LIMITED", "今天的 AI 使用次数已达上限，请明天再试。");
  }
  if (row) {
    db.prepare("UPDATE ai_usage SET count = count + 1 WHERE user_id = ? AND used_on = ?").run(userId, today);
  } else {
    db.prepare("INSERT INTO ai_usage (user_id, used_on, count) VALUES (?, ?, 1)").run(userId, today);
  }
}

router.post("/auth/register", asyncRoute(async (req, res) => {
  const nickname = requireString(req.body.nickname, "昵称");
  const password = requireString(req.body.password, "密码");
  const grade = requireString(req.body.grade, "年级");
  if (password.length < 6) {
    throw new AppError(400, "VALIDATION_ERROR", "密码至少需要 6 位。");
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
  res.json(ok({ user, token: signToken(user) }));
}));

router.post("/auth/login", asyncRoute(async (req, res) => {
  const nickname = requireString(req.body.nickname, "昵称");
  const password = requireString(req.body.password, "密码");
  const row = db.prepare("SELECT * FROM users WHERE nickname = ?").get(nickname);

  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new AppError(401, "AUTH_INVALID_TOKEN", "昵称或密码不正确。");
  }

  const user = toUser(row);
  res.json(ok({ user, token: signToken(user) }));
}));

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
  consumeAiQuota(req.user.id);
  const aiAnswer = await generateAnswer({ subject, mode, contentText, officialAnswerText });
  const questionId = randomUUID();
  const answerId = randomUUID();
  const createdAt = nowIso();
  const knowledgeTags = Array.isArray(aiAnswer.knowledge_tags) ? aiAnswer.knowledge_tags : [];

  db.prepare(`
    INSERT INTO questions (
      id, user_id, subject, mode, content_text, content_image_url,
      official_answer_text, official_answer_image_url, knowledge_tags_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'answered', ?)
  `).run(questionId, req.user.id, subject, mode, contentText, officialAnswerText, JSON.stringify(knowledgeTags), createdAt);

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
}));

router.get("/questions/:questionId/answer", requireAuth, (req, res) => {
  const question = db.prepare("SELECT * FROM questions WHERE id = ? AND user_id = ?").get(req.params.questionId, req.user.id);
  if (!question) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这道题。");
  const answer = db.prepare("SELECT * FROM answers WHERE question_id = ?").get(req.params.questionId);
  res.json(ok({ question: toQuestion(question), answer: toAnswer(answer) }));
});

router.post("/questions/:questionId/reveal-solution", requireAuth, asyncRoute(async (req, res) => {
  const questionRow = db.prepare("SELECT * FROM questions WHERE id = ? AND user_id = ?").get(req.params.questionId, req.user.id);
  if (!questionRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道题。");
  const answerRow = db.prepare("SELECT * FROM answers WHERE question_id = ?").get(req.params.questionId);
  if (!answerRow) throw new AppError(404, "RESOURCE_NOT_FOUND", "没有找到这道题的讲解。");

  const question = toQuestion(questionRow);
  let answer = toAnswer(answerRow);
  if (!answer.full_solution_text) {
    ensureAiConfigured();
    consumeAiQuota(req.user.id);
    const generated = await generateFullSolution({
      subject: question.subject,
      contentText: question.content_text,
      previousHint: answer.hint_text
    });
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
    `).run(randomUUID(), req.user.id, question.id, JSON.stringify(question.knowledge_tags));
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
  consumeAiQuota(req.user.id);
  const question = toQuestion(questionRow);
  const answer = toAnswer(answerRow);
  const reply = await generateFollowUp({ question, answer, contentText });
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
  db.prepare("UPDATE mistake_records SET mastery_status = ?, last_reviewed_at = ? WHERE id = ? AND user_id = ?")
    .run(masteryStatus, nowIso(), req.params.mistakeId, req.user.id);
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

router.get("/learning-path", requireAuth, (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  const rows = db.prepare("SELECT * FROM learning_path_items WHERE user_id = ? AND status = ?").all(req.user.id, status);
  const items = rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    knowledge_tag: row.knowledge_tag,
    reason: row.reason,
    recommended_action: row.recommended_action,
    related_question_ids: parseJson(row.related_question_ids_json, []),
    status: row.status
  }));
  res.json(ok({ items }));
});

router.patch("/learning-path/:itemId", requireAuth, (req, res) => {
  const status = requireString(req.body.status, "推荐状态");
  if (!["pending", "done", "dismissed"].includes(status)) {
    return fail(res, 400, "VALIDATION_ERROR", "推荐状态不合法。");
  }
  db.prepare("UPDATE learning_path_items SET status = ? WHERE id = ? AND user_id = ?").run(status, req.params.itemId, req.user.id);
  res.json(ok({ id: req.params.itemId, status }));
});
