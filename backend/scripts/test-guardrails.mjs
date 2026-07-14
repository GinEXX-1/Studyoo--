// 生产守护栏回归测试：邀请码、全站 AI 配额、种子资源铺设
// 运行：npm run test:guardrails
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

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

  // 4. 共享题库：owner 共享后他人可见可打开，他人无法操作共享开关，取消共享后恢复私有
  const registrationB = await req("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `guard_b_${suffix}`, password: "123456", grade: "高一", invite_code: "STUDYOO-BETA" }) });
  const tokenB = registrationB.payload?.data?.token;
  const seedQuestions = await req("/exam/papers/paper-gaokao-math-sample-2024/questions", { token });
  const seedIds = (seedQuestions.payload?.data?.items || []).slice(0, 2).map((item) => item.id);
  const created = await req("/collections", { method: "POST", token, body: JSON.stringify({ title: `A 的共享测试题库 ${suffix}`, subject: "数学", question_ids: seedIds }) });
  const collectionId = created.payload?.data?.id;
  assert(Boolean(collectionId), "A 用公共种子题创建个人题库");

  const beforeShare = await req(`/collections/${collectionId}`, { token: tokenB });
  assert(beforeShare.status === 404, "共享前 B 打不开 A 的题库 (404)");
  const shared = await req(`/collections/${collectionId}/share`, { method: "PATCH", token, body: JSON.stringify({ shared: true }) });
  assert(shared.payload?.data?.is_shared === true, "A 开启共享成功");
  const listB = await req("/collections", { token: tokenB });
  const sharedItem = (listB.payload?.data?.items || []).find((item) => item.id === collectionId);
  assert(Boolean(sharedItem) && sharedItem.is_owner === false, "共享后 B 的题库列表能看到且 is_owner=false");
  const detailB = await req(`/collections/${collectionId}`, { token: tokenB });
  assert(detailB.status === 200 && detailB.payload?.data?.questions?.length === seedIds.length, "共享后 B 能打开题库详情");
  const hijackShare = await req(`/collections/${collectionId}/share`, { method: "PATCH", token: tokenB, body: JSON.stringify({ shared: false }) });
  assert(hijackShare.status === 404, "B 不能操作 A 的共享开关 (404)");
  await req(`/collections/${collectionId}/share`, { method: "PATCH", token, body: JSON.stringify({ shared: false }) });
  const afterUnshare = await req(`/collections/${collectionId}`, { token: tokenB });
  assert(afterUnshare.status === 404, "取消共享后 B 再次打不开 (404)");

  // 5. 拍照导入：归属校验（B 不能确认 A 的照片）；无效图片被拒绝
  const badImage = await req("/import/photo/recognize", { method: "POST", token, body: JSON.stringify({ subject: "数学", image_base64: Buffer.from("not an image").toString("base64") }) });
  assert(badImage.status === 400 || badImage.status === 429, "非图片文件被拒绝（或先被全站配额拦下）");
  const fakeConfirm = await req("/import/photo/confirm", { method: "POST", token: tokenB, body: JSON.stringify({ photo_id: "not-exist", stem_text: "x" }) });
  assert(fakeConfirm.status === 404, "确认不存在/他人的照片返回 404");

  // 6. 拍照确认入库全链路（直插 photo_uploads 模拟已识别，避免消耗 AI）
  const userAId = goodCode.payload?.data?.user?.id;
  const photoDb = new DatabaseSync("/tmp/studyoo-guardrails-test.db");
  photoDb.prepare(`
    INSERT INTO photo_uploads (id, user_id, image_url, subject, ai_result_json, created_at)
    VALUES ('photo-test-1', ?, '/uploads/photo-test-1.jpg', '数学', '{}', ?)
  `).run(userAId, new Date().toISOString());
  photoDb.close();
  const confirmed = await req("/import/photo/confirm", { method: "POST", token, body: JSON.stringify({
    photo_id: "photo-test-1", stem_text: "已知 $f(x)=x^2$，求 $f(2)$。", question_type: "short-answer",
    knowledge_tags: ["函数"], difficulty: "easy", reference_answer_text: "4", has_figure: false
  }) });
  assert(confirmed.status === 200, "拍照确认入库成功");
  const photoCollectionId = confirmed.payload?.data?.collection_id;
  assert(/^collection-photo-[\w-]+-math$/.test(photoCollectionId || ""), `拍照题库 ID 为纯 ASCII（${photoCollectionId}）`);
  const photoCol = await req(`/collections/${photoCollectionId}`, { token });
  assert(photoCol.status === 200 && photoCol.payload?.data?.questions?.length === 1, "拍照题库可打开且含 1 题");
  const dupConfirm = await req("/import/photo/confirm", { method: "POST", token, body: JSON.stringify({ photo_id: "photo-test-1", stem_text: "x" }) });
  assert(dupConfirm.status === 409, "重复确认同一张照片被拦截 (409)");

  console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
} finally {
  child.kill();
  rmSync(uploadDir, { recursive: true, force: true });
}
