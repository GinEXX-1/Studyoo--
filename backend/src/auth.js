import jwt from "jsonwebtoken";
import { db, toUser } from "./db.js";
import { config } from "./config.js";
import { fail } from "./http.js";

export function signToken(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn
  });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return fail(res, 401, "AUTH_INVALID_TOKEN", "请先登录后再继续。");
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub);
    if (!row) {
      return fail(res, 401, "AUTH_USER_NOT_FOUND", "用户不存在，请重新登录。");
    }
    req.user = toUser(row);
    next();
  } catch {
    return fail(res, 401, "AUTH_INVALID_TOKEN", "登录已过期，请重新登录。");
  }
}
