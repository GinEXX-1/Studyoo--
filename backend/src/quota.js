// ——— AI 配额（原子化：先扣后调，失败回滚）———
// 所有触达 AI 服务的路由（含导入流水线）都必须经过 withAiQuota。
import { db, todayLocal } from "./db.js";
import { config } from "./config.js";
import { AppError } from "./http.js";

export function checkAndConsumeAiQuota(userId) {
  const today = todayLocal();
  // 全站护栏：防止批量注册账号绕过按用户配额，无上限消耗 AI 余额
  const globalRow = db.prepare("SELECT count FROM ai_usage_global WHERE used_on = ?").get(today);
  if ((globalRow?.count ?? 0) >= config.aiGlobalDailyLimit) {
    throw new AppError(429, "RATE_LIMITED", "今天全站的 AI 额度已用完，请明天再试。");
  }
  const row = db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND used_on = ?").get(userId, today);
  if (row && row.count >= config.aiDailyLimit) {
    throw new AppError(429, "RATE_LIMITED", "今天的 AI 使用次数已达上限，请明天再试。");
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

export async function withAiQuota(userId, fn) {
  checkAndConsumeAiQuota(userId);
  try {
    return await fn();
  } catch (error) {
    rollbackAiQuota(userId);
    throw error;
  }
}
