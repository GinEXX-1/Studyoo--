// 简单内存级速率限制，保护认证接口
const records = new Map();

// 定期清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of records) {
    if (now > entry.resetAt) records.delete(key);
  }
}, 60_000).unref();

export function authRateLimiter(windowMs = 60_000, maxAttempts = 5) {
  return (req, _res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const key = `auth:${ip}`;

    let entry = records.get(key);
    if (!entry || now > entry.resetAt) {
      records.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > maxAttempts) {
      return _res.status(429).json({
        success: false,
        data: null,
        message: "请求过于频繁，请 1 分钟后再试。",
        error_code: "RATE_LIMITED"
      });
    }
    next();
  };
}
