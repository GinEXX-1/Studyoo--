import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 后端根目录：数据库与上传目录一律相对此处解析，避免因启动位置不同产生多套数据。
const backendRoot = resolve(__dirname, "..");
dotenv.config({ path: resolve(backendRoot, ".env") });

const UNCHANGED_JWT_SECRETS = new Set(["dev-only-change-me", "", "your-jwt-secret-here"]);
if (UNCHANGED_JWT_SECRETS.has(process.env.JWT_SECRET || "")) {
  console.error("FATAL: JWT_SECRET 未设置或仍为默认值。请设置强随机密钥后重启。");
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: resolve(backendRoot, process.env.DATABASE_PATH || "./studyoo.db"),
  jwtSecret: process.env.JWT_SECRET || "dev-only-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  aiProvider: process.env.AI_PROVIDER || "bigmodel",
  aiApiKey: process.env.AI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "glm-4-flash",
  aiVisionModel: process.env.AI_VISION_MODEL || "glm-4.6v-flash",
  aiBaseUrl: process.env.AI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000),
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT || 30),
  aiGlobalDailyLimit: Number(process.env.AI_GLOBAL_DAILY_LIMIT || 200),
  inviteCode: (process.env.INVITE_CODE || "").trim(),
  uploadDir: resolve(backendRoot, process.env.UPLOAD_DIR || "./uploads"),
  pdfRenderCommand: process.env.PDF_RENDER_COMMAND || "pdftoppm",
  pdfTextCommand: process.env.PDF_TEXT_COMMAND || "pdftotext",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:5173,http://localhost:5174").split(","),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  secureCookie: process.env.NODE_ENV === "production"
};
