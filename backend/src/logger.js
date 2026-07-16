import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const requestContext = new AsyncLocalStorage();

function write(level, event, fields = {}) {
  const requestId = requestContext.getStore()?.requestId || fields.request_id || null;
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(requestId ? { request_id: requestId } : {}),
    ...fields
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function requestLogger(req, res, next) {
  const requestId = typeof req.headers["x-request-id"] === "string"
    ? req.headers["x-request-id"].trim().slice(0, 100)
    : randomUUID();
  const startedAt = Date.now();
  res.setHeader("X-Request-Id", requestId);
  requestContext.run({ requestId }, () => {
    res.on("finish", () => {
      if (req.path === "/health" || req.path === "/api/v1/health") return;
      write(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http_request", {
        method: req.method,
        path: req.path,
        status_code: res.statusCode,
        duration_ms: Date.now() - startedAt,
        user_id: req.user?.id || null
      });
    });
    next();
  });
}

export function logInfo(event, fields) {
  write("info", event, fields);
}

export function logError(event, error, fields = {}) {
  write("error", event, {
    ...fields,
    error_name: error?.name || "Error",
    error_message: String(error?.message || error || "Unknown error").slice(0, 1000),
    stack: typeof error?.stack === "string" ? error.stack.slice(0, 4000) : undefined
  });
}
