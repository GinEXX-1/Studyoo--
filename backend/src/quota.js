// ——— AI 配额（原子化：先扣后调，失败回滚）———
// 所有触达 AI 服务的路由（含导入流水线）都必须经过 withAiQuota。
// v3：在"按次"护栏之上增加"按 token 成本"计量——次数防滥用，token 防单次大成本。
import { AsyncLocalStorage } from "node:async_hooks";
import { db, todayLocal } from "./db.js";
import { config } from "./config.js";
import { AppError } from "./http.js";

const quotaContext = new AsyncLocalStorage();

export function checkAndConsumeAiQuota(userId) {
  const today = todayLocal();
  // 全站护栏：防止批量注册账号绕过按用户配额，无上限消耗 AI 余额
  const globalRow = db.prepare("SELECT count, tokens FROM ai_usage_global WHERE used_on = ?").get(today);
  if ((globalRow?.count ?? 0) >= config.aiGlobalDailyLimit) {
    throw new AppError(429, "RATE_LIMITED", "今天全站的 AI 额度已用完，请明天再试。");
  }
  if (config.aiGlobalDailyTokenLimit > 0 && (globalRow?.tokens ?? 0) >= config.aiGlobalDailyTokenLimit) {
    throw new AppError(429, "RATE_LIMITED", "今天全站的 AI 成本预算已用完，请明天再试。");
  }
  const row = db.prepare("SELECT count, tokens FROM ai_usage WHERE user_id = ? AND used_on = ?").get(userId, today);
  if (row && row.count >= config.aiDailyLimit) {
    throw new AppError(429, "RATE_LIMITED", "今天的 AI 使用次数已达上限，请明天再试。");
  }
  if (config.aiDailyTokenLimit > 0 && row && row.tokens >= config.aiDailyTokenLimit) {
    throw new AppError(429, "RATE_LIMITED", "今天的 AI 用量（token）已达上限，请明天再试。");
  }
  if (row) {
    db.prepare("UPDATE ai_usage SET count = count + 1 WHERE user_id = ? AND used_on = ?").run(userId, today);
  } else {
    db.prepare("INSERT INTO ai_usage (user_id, used_on, count) VALUES (?, ?, 1)").run(userId, today);
  }
  db.prepare(`
    INSERT INTO ai_usage_global (used_on, count) VALUES (?, 1)
    ON CONFLICT(used_on) DO UPDATE SET count = count + 1
  `).run(today);
}

export function rollbackAiQuota(userId) {
  const today = todayLocal();
  const row = db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND used_on = ?").get(userId, today);
  if (row && row.count > 0) {
    if (row.count === 1) {
      db.prepare("DELETE FROM ai_usage WHERE user_id = ? AND used_on = ?").run(userId, today);
    } else {
      db.prepare("UPDATE ai_usage SET count = count - 1 WHERE user_id = ? AND used_on = ?").run(userId, today);
    }
    db.prepare("UPDATE ai_usage_global SET count = count - 1 WHERE used_on = ? AND count > 0").run(today);
  }
}

// 由 ai.js 在每次拿到服务商响应后调用；token 是事后计量（已产生的成本），不回滚。
export function recordAiTokens(totalTokens) {
  const tokens = Number(totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const today = todayLocal();
  db.prepare(`
    INSERT INTO ai_usage_global (used_on, count, tokens) VALUES (?, 0, ?)
    ON CONFLICT(used_on) DO UPDATE SET tokens = tokens + excluded.tokens
  `).run(today, tokens);
  const userId = quotaContext.getStore()?.userId;
  if (userId) {
    db.prepare(`
      INSERT INTO ai_usage (user_id, used_on, count, tokens) VALUES (?, ?, 0, ?)
      ON CONFLICT(user_id, used_on) DO UPDATE SET tokens = tokens + excluded.tokens
    `).run(userId, today, tokens);
  }
}

export async function withAiQuota(userId, fn) {
  checkAndConsumeAiQuota(userId);
  try {
    return await quotaContext.run({ userId }, fn);
  } catch (error) {
    rollbackAiQuota(userId);
    throw error;
  }
}
