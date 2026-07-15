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
  // 按 token 成本的配额（0 = 不启用）。次数护栏防滥用频率，token 护栏防成本。
  aiDailyTokenLimit: Number(process.env.AI_DAILY_TOKEN_LIMIT || 0),
  aiGlobalDailyTokenLimit: Number(process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT || 0),
  // 备份异地推送（S3 兼容，如 Cloudflare R2）。四项都配置才启用。
  backupS3: {
    endpoint: (process.env.BACKUP_S3_ENDPOINT || "").trim(),
    bucket: (process.env.BACKUP_S3_BUCKET || "").trim(),
    accessKeyId: (process.env.BACKUP_S3_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (process.env.BACKUP_S3_SECRET_ACCESS_KEY || "").trim(),
    region: (process.env.BACKUP_S3_REGION || "auto").trim()
  },
  inviteCode: (process.env.INVITE_CODE || "").trim(),
  adminNicknames: (process.env.ADMIN_NICKNAMES || "").split(",").map((item) => item.trim()).filter(Boolean),
  adminBootstrapToken: (process.env.ADMIN_BOOTSTRAP_TOKEN || "").trim(),
  appVersion: (process.env.APP_VERSION || "2.4.0").trim(),
  appTimezoneOffsetMinutes: Number(process.env.APP_TIMEZONE_OFFSET_MINUTES || 480),
  discoveryAllowedHosts: (process.env.DISCOVERY_ALLOWED_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
  uploadDir: resolve(backendRoot, process.env.UPLOAD_DIR || "./uploads"),
  pdfRenderCommand: process.env.PDF_RENDER_COMMAND || "pdftoppm",
  pdfTextCommand: process.env.PDF_TEXT_COMMAND || "pdftotext",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:4173,http://localhost:5173,http://localhost:5174,https://studyoo.space,https://www.studyoo.space").split(","),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  secureCookie: process.env.NODE_ENV === "production"
};
