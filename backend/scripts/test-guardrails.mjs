// 生产守护栏回归测试：邀请码、全站 AI 配额、种子资源铺设
// 运行：npm run test:guardrails
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = "3210";
const base = `http://localhost:${port}/api/v1`;
const uploadDir = mkdtempSync(join(tmpdir(), "studyoo-guardrails-uploads-"));

const child = spawn("node", ["--no-warnings", "src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: port,
    DATABASE_PATH: "/tmp/studyoo-guardrails-test.db",
    UPLOAD_DIR: uploadDir,
    JWT_SECRET: "guardrails-test-secret",
    INVITE_CODE: "STUDYOO-BETA",
    AI_GLOBAL_DAILY_LIMIT: "0"
  },
  stdio: "ignore"
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(path, { token, ...options } = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else { console.log("PASS:", msg); } }

try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) break; } catch { await sleep(250); }
  }

  // 1. 种子资源铺设：全新 UPLOAD_DIR 启动后应包含公共卷的 PDF 与封面图
  assert(existsSync(join(uploadDir, "2026-national-1.pdf")), "启动时种子 PDF 铺进了空上传目录");
  assert(existsSync(join(uploadDir, "2026-national-1-page-1.png")), "启动时种子封面图铺进了空上传目录");

  // 2. 邀请码：缺码/错码 403，正确邀请码可注册
  const suffix = Date.now();
  const noCode = await req("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `guard_a_${suffix}`, password: "123456", grade: "高一" }) });
  assert(noCode.status === 403 && noCode.payload?.error_code === "INVITE_REQUIRED", "无邀请码注册被拒绝 (403 INVITE_REQUIRED)");
  const badCode = await req("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `guard_a_${suffix}`, password: "123456", grade: "高一", invite_code: "wrong" }) });
  assert(badCode.status === 403, "错误邀请码注册被拒绝 (403)");
  const goodCode = await req("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `guard_a_${suffix}`, password: "123456", grade: "高一", invite_code: "STUDYOO-BETA" }) });
  assert(goodCode.status === 201, "正确邀请码注册成功 (201)");
  const token = goodCode.payload?.data?.token;

  // 3. 全站 AI 配额：AI_GLOBAL_DAILY_LIMIT=0 时，任何 AI 调用返回 429（个人额度未动也一样）
  const aiCall = await req("/questions", { method: "POST", token, body: JSON.stringify({ subject: "数学", mode: "solve_from_scratch", content_text: "1+1=?" }) });
  assert(aiCall.status === 429 && aiCall.payload?.error_code === "RATE_LIMITED", "全站额度用尽时 AI 调用返回 429");

  console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
} finally {
  child.kill();
  rmSync(uploadDir, { recursive: true, force: true });
}
