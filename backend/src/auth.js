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
  const tokenFromHeader = header.startsWith("Bearer ") ? header.slice(7) : "";
  const token = req.cookies.token || tokenFromHeader;

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

export function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (!req.user.is_admin) {
      return fail(res, 403, "ADMIN_REQUIRED", "仅管理员可以访问这个页面。");
    }
    next();
  });
}
