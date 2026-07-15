import cors from "cors";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { router } from "./routes.js";
import { importRouter } from "./routes-import.js";
import { reviewRouter } from "./routes-review.js";
import { recommendRouter } from "./routes-recommend.js";
import { adminRouter } from "./routes-admin.js";
import { discoveryRouter } from "./routes-discovery.js";
import { setupV2 } from "./migrate-v2.js";
import { AppError, fail } from "./http.js";
import { requireAuth } from "./auth.js";
import { authorizeUpload } from "./upload-access.js";
import { scheduleDailyBackup } from "./backup.js";

const app = express();

const allowedOrigins = Array.isArray(config.corsOrigin) ? config.corsOrigin : [config.corsOrigin];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));
app.use(helmet());
app.use(cookieParser());
const json1mb = express.json({ limit: "1mb" });
const json30mb = express.json({ limit: "30mb" });
app.use((req, res, next) => {
  if (req.path === "/api/v1/exam/ingest/pdf" || req.path === "/api/v1/import/pipeline/upload") {
    return json30mb(req, res, next);
  }
  return json1mb(req, res, next);
});

const uploadDir = resolve(config.uploadDir);
mkdirSync(uploadDir, { recursive: true });

// 种子数据（公共卷）引用的图片/PDF 随代码分发，启动时铺进上传目录。
// 生产环境 UPLOAD_DIR 是独立卷，镜像里的 seed-assets 不铺过去就会 404。
const seedAssetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../seed-assets");
if (existsSync(seedAssetsDir)) {
  for (const name of readdirSync(seedAssetsDir)) {
    const target = join(uploadDir, name);
    if (!existsSync(target)) copyFileSync(join(seedAssetsDir, name), target);
  }
}
// 上传目录包含用户原卷与题目图片，访问时同时校验资源归属。
app.use("/uploads", requireAuth, authorizeUpload, express.static(uploadDir, {
  fallthrough: true,
  maxAge: "1h"
}));
app.use("/uploads", (_req, res) => fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个文件。"));

const healthHandler = (_req, res) => {
  res.json({ success: true, data: { status: "ok" }, message: "ok" });
};

app.get("/health", healthHandler);
app.get("/api/v1/health", healthHandler);

app.get("/", (_req, res) => {
  res.json({
    success: true,
    data: {
      name: "Studyoo API",
      frontend: config.frontendUrl,
      api_base_url: "/api/v1"
    },
    message: "这是后端 API，不是前端页面，请打开前端地址。"
  });
});

app.get("/api/v1", (_req, res) => {
  res.json({
    success: true,
    data: {
      name: "Studyoo API",
      frontend: config.frontendUrl,
      api_base_url: "/api/v1"
    },
    message: "这是后端 API，不是前端页面，请打开前端地址。"
  });
});

// v2 迁移
setupV2();

app.use("/api/v1", router);
app.use("/api/v1", importRouter);
app.use("/api/v1", reviewRouter);
app.use("/api/v1", recommendRouter);
app.use("/api/v1", adminRouter);
app.use("/api/v1", discoveryRouter);

// 兜底：未匹配的路由返回 JSON 错误而非默认 HTML
app.use("/api/v1", (_req, res) => {
  return fail(res, 404, "NOT_FOUND", "API 接口不存在。");
});

app.use((error, _req, res, _next) => {
  if (error instanceof AppError) {
    return fail(res, error.status, error.errorCode, error.message);
  }
  // CORS 白名单拒绝：给出可诊断的 403，而不是误导排查的通用 500
  if (error.message === "Not allowed by CORS") {
    return fail(res, 403, "CORS_ORIGIN_DENIED", "该来源不在后端 CORS 白名单内，请检查 CORS_ORIGIN 配置。");
  }
  // Express 内置错误（如 body 超限）
  if (error.type === "entity.too.large") {
    return fail(res, 413, "PAYLOAD_TOO_LARGE", "请求体过大。");
  }
  console.error(`[${new Date().toISOString()}] Unhandled error:`, error.message || error);
  return fail(res, 500, "SERVER_ERROR", "服务器暂时不可用。");
});

if (process.env.NODE_ENV === "production" || process.env.BACKUP_ENABLED === "true") {
  scheduleDailyBackup();
}

app.listen(config.port, () => {
  console.log(`Studyoo API running at http://localhost:${config.port}/api/v1`);
});
