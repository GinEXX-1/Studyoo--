import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: process.env.DATABASE_PATH || "./studyoo.db",
  jwtSecret: process.env.JWT_SECRET || "dev-only-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  aiProvider: process.env.AI_PROVIDER || "openai",
  aiApiKey: process.env.AI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "gpt-4o-mini",
  aiBaseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1/chat/completions",
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000),
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT || 30),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173"
};
