import { randomUUID } from "node:crypto";
import express from "express";
import { requireAdmin, requireAuth } from "./auth.js";
import { config } from "./config.js";
import { db, nowIso, parseJson, todayLocal } from "./db.js";
import { fail, ok } from "./http.js";

export const adminRouter = express.Router();

const feedbackCategories = new Set(["bug", "idea", "content", "experience", "other"]);
const feedbackStatuses = new Set(["open", "reviewing", "resolved"]);

function toFeedback(row) {
  return {
    id: row.id,
    category: row.category,
    message: row.message,
    status: row.status,
    admin_note: row.admin_note || null,
    app_version: row.app_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: row.nickname ? { id: row.user_id, nickname: row.nickname, grade: row.grade } : undefined
  };
}

function appDayBounds(date = new Date()) {
  const offsetMs = config.appTimezoneOffsetMinutes * 60_000;
  const shifted = new Date(date.getTime() + offsetMs);
  const shiftedStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return {
    start: new Date(shiftedStart - offsetMs).toISOString(),
    end: new Date(shiftedStart + 86_400_000 - offsetMs).toISOString()
  };
}

function appHour(iso) {
  const shifted = new Date(new Date(iso).getTime() + config.appTimezoneOffsetMinutes * 60_000);
  return `${shifted.toISOString().slice(0, 13)}:00`;
}

function adminSnapshot() {
  const today = todayLocal();
  const day = appDayBounds();
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const summary = {
    users: Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count),
    new_users_today: Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE created_at >= ? AND created_at < ?").get(day.start, day.end).count),
    active_users_24h: Number(db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM events WHERE user_id IS NOT NULL AND created_at >= ?").get(since24h).count),
    attempts_today: Number(db.prepare("SELECT COUNT(*) AS count FROM practice_attempts WHERE created_at >= ? AND created_at < ?").get(day.start, day.end).count),
    imports_today: Number(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_name IN ('import_succeeded', 'discovery_imported') AND created_at >= ? AND created_at < ?").get(day.start, day.end).count),
    shared_collections: Number(db.prepare("SELECT COUNT(*) AS count FROM question_collections WHERE is_shared = 1").get().count),
    open_feedback: Number(db.prepare("SELECT COUNT(*) AS count FROM user_feedback WHERE status != 'resolved'").get().count)
  };
  const attempts = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
    FROM practice_attempts WHERE created_at >= ? AND created_at < ?
  `).get(day.start, day.end);
  summary.correct_rate_today = attempts.total ? Math.round(Number(attempts.correct) / Number(attempts.total) * 100) : 0;
  const aiUsage = db.prepare("SELECT count, tokens FROM ai_usage_global WHERE used_on = ?").get(today);
  summary.ai_calls_today = Number(aiUsage?.count || 0);
  summary.ai_tokens_today = Number(aiUsage?.tokens || 0);

  const eventCounts = db.prepare(`
    SELECT event_name, COUNT(*) AS count
    FROM events WHERE created_at >= ? AND created_at < ?
    GROUP BY event_name ORDER BY count DESC
  `).all(day.start, day.end).map((row) => ({ name: row.event_name, count: Number(row.count) }));
  const recentEvents = db.prepare(`
    SELECT e.*, u.nickname
    FROM events e LEFT JOIN users u ON u.id = e.user_id
    ORDER BY e.created_at DESC LIMIT 40
  `).all().map((row) => ({
    id: row.id,
    event_name: row.event_name,
    nickname: row.nickname || "系统",
    payload: parseJson(row.payload_json, {}),
    created_at: row.created_at
  }));
  const hourlyBuckets = new Map();
  for (const row of db.prepare("SELECT created_at, user_id FROM events WHERE created_at >= ? ORDER BY created_at ASC").all(since24h)) {
    const hour = appHour(row.created_at);
    if (!hourlyBuckets.has(hour)) hourlyBuckets.set(hour, { hour, events: 0, users: new Set() });
    const bucket = hourlyBuckets.get(hour);
    bucket.events += 1;
    if (row.user_id) bucket.users.add(row.user_id);
  }
  const hourlyActivity = [...hourlyBuckets.values()].map((bucket) => ({ hour: bucket.hour, events: bucket.events, users: bucket.users.size }));

  return { summary, event_counts: eventCounts, recent_events: recentEvents, hourly_activity: hourlyActivity, generated_at: nowIso() };
}

adminRouter.get("/system/version", requireAuth, (_req, res) => {
  res.json(ok({ version: config.appVersion, channel: "beta", platform: "web-pwa" }));
});

adminRouter.post("/feedback", requireAuth, (req, res) => {
  const category = feedbackCategories.has(req.body.category) ? req.body.category : "other";
  const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
  if (message.length < 5 || message.length > 2000) {
    return fail(res, 400, "VALIDATION_ERROR", "反馈内容需为 5-2000 个字符。");
  }
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO user_feedback (id, user_id, category, message, status, app_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(id, req.user.id, category, message, config.appVersion, now, now);
  res.status(201).json(ok(toFeedback(db.prepare("SELECT * FROM user_feedback WHERE id = ?").get(id))));
});

adminRouter.get("/feedback/mine", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM user_feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").all(req.user.id);
  res.json(ok({ items: rows.map(toFeedback) }));
});

adminRouter.get("/admin/dashboard", requireAdmin, (_req, res) => {
  res.json(ok(adminSnapshot()));
});

adminRouter.get("/admin/stream", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = () => res.write(`event: dashboard\ndata: ${JSON.stringify(adminSnapshot())}\n\n`);
  send();
  const timer = setInterval(send, 5000);
  req.on("close", () => clearInterval(timer));
});

adminRouter.get("/admin/feedback", requireAdmin, (req, res) => {
  const status = feedbackStatuses.has(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare(`
        SELECT f.*, u.nickname, u.grade FROM user_feedback f
        JOIN users u ON u.id = f.user_id WHERE f.status = ? ORDER BY f.created_at DESC
      `).all(status)
    : db.prepare(`
        SELECT f.*, u.nickname, u.grade FROM user_feedback f
        JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 200
      `).all();
  res.json(ok({ items: rows.map(toFeedback) }));
});

adminRouter.patch("/admin/feedback/:feedbackId", requireAdmin, (req, res) => {
  const status = feedbackStatuses.has(req.body.status) ? req.body.status : null;
  if (!status) return fail(res, 400, "VALIDATION_ERROR", "反馈状态不合法。");
  const note = typeof req.body.admin_note === "string" ? req.body.admin_note.trim().slice(0, 500) : null;
  const result = db.prepare("UPDATE user_feedback SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?")
    .run(status, note || null, nowIso(), req.params.feedbackId);
  if (!result.changes) return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这条反馈。");
  const row = db.prepare(`
    SELECT f.*, u.nickname, u.grade FROM user_feedback f
    JOIN users u ON u.id = f.user_id WHERE f.id = ?
  `).get(req.params.feedbackId);
  res.json(ok(toFeedback(row)));
});
