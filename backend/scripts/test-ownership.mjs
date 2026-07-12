import { spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const port = "3200";
const base = `http://localhost:${port}/api/v1`;

const child = spawn("node", ["--no-warnings", "src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: port, DATABASE_PATH: "/tmp/studyoo-ownership-test.db", JWT_SECRET: "ownership-test-secret" },
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

  const suffix = Date.now();
  const registrationA = (await req("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `owner_a_${suffix}`, password: "123456", grade: "高一" }) })).payload.data;
  const registrationB = (await req("/auth/register", { method: "POST", body: JSON.stringify({ nickname: `owner_b_${suffix}`, password: "123456", grade: "高一" }) })).payload.data;
  const a = registrationA.token;
  const b = registrationB.token;

  // A 导入私有试卷
  const paperId = `paper-a-${suffix}`;
  const qId = `q-a-${suffix}`;
  const imp = await req("/exam/ingest/manual", { method: "POST", token: a, body: JSON.stringify({
    paper: { id: paperId, year: 2025, region: "全国", subject: "数学", title: "A 的私有卷", source_name: "test", license_note: "test" },
    questions: [{ id: qId, question_number: "1", content_text: "1+1=?", official_answer_text: "2", knowledge_tags: ["函数"] }]
  }) });
  assert(imp.payload?.success === true, "A 导入自己的试卷成功");

  // B 看不到 A 的试卷
  const papersB = await req("/exam/papers", { token: b });
  assert(!papersB.payload.data.items.some((p) => p.id === paperId), "B 的试卷列表中看不到 A 的私有卷");
  const papersA = await req("/exam/papers", { token: a });
  assert(papersA.payload.data.items.some((p) => p.id === paperId), "A 自己能看到自己的卷");
  assert(papersA.payload.data.items.some((p) => p.id === "paper-gaokao-math-sample-2024"), "公共种子卷对 A 可见");

  // B 拿不到 A 的题目详情/练习题
  const qB = await req(`/exam/questions/${qId}`, { token: b });
  assert(qB.status === 404, "B 访问 A 的真题详情返回 404");
  const pqB = await req(`/practice/questions/practice-${qId}`, { token: b });
  assert(pqB.status === 404, "B 访问 A 的练习题返回 404");
  const pqA = await req(`/practice/questions/practice-${qId}`, { token: a });
  assert(pqA.payload?.success === true, "A 自己能访问自己的练习题");

  // B 不能覆盖 A 的试卷 / 公共种子卷 / A 的题目
  const hijack1 = await req("/exam/ingest/manual", { method: "POST", token: b, body: JSON.stringify({
    paper: { id: paperId, year: 2025, region: "全国", subject: "数学", title: "被 B 篡改", source_name: "evil", license_note: "x" },
    questions: [{ question_number: "1", content_text: "hacked", official_answer_text: "hacked" }]
  }) });
  assert(hijack1.status === 403, "B 覆盖 A 的试卷被拒绝 (403)");
  const hijack2 = await req("/exam/ingest/manual", { method: "POST", token: b, body: JSON.stringify({
    paper: { id: "paper-gaokao-math-sample-2024", year: 2024, region: "全国", subject: "数学", title: "被 B 篡改的公共卷", source_name: "evil", license_note: "x" },
    questions: [{ question_number: "1", content_text: "hacked", official_answer_text: "hacked" }]
  }) });
  assert(hijack2.status === 403, "B 覆盖公共种子卷被拒绝 (403)");
  const hijack3 = await req("/exam/ingest/manual", { method: "POST", token: b, body: JSON.stringify({
    paper: { year: 2025, region: "全国", subject: "数学", title: "B 自己的卷", source_name: "test", license_note: "x" },
    questions: [{ id: qId, question_number: "1", content_text: "hacked", official_answer_text: "hacked" }]
  }) });
  assert(hijack3.status === 403, "B 用 A 的题目 ID 导入被拒绝 (403)");

  // B 不能把 A 的题加进自己的题库
  const colB = await req("/collections", { method: "POST", token: b, body: JSON.stringify({ title: "B 的题库", subject: "数学", question_ids: [qId] }) });
  assert(colB.status === 400, "B 引用 A 的题目建题库被拒绝");

  // uploads 需要登录
  const uploadNoAuth = await fetch(`http://localhost:${port}/uploads/2026-national-1-page-1.png`);
  assert(uploadNoAuth.status === 401, "未登录访问 /uploads 返回 401");
  const uploadAuth = await fetch(`http://localhost:${port}/uploads/2026-national-1-page-1.png`, { headers: { Authorization: `Bearer ${a}` } });
  assert(uploadAuth.status === 200, "登录后访问 /uploads 正常");

  // 私有上传文件必须校验所有者，不能只检查是否登录
  const privateFileName = `ownership-private-${suffix}.txt`;
  const privateFilePath = new URL(`../uploads/${privateFileName}`, import.meta.url);
  writeFileSync(privateFilePath, "private");
  const testDb = new DatabaseSync("/tmp/studyoo-ownership-test.db");
  testDb.prepare(`
    INSERT INTO questions (id, user_id, subject, mode, content_text, content_image_url, knowledge_tags_json, status, created_at)
    VALUES (?, ?, '数学', 'solve_from_scratch', '私有图片题', ?, '[]', 'answered', ?)
  `).run(`private-question-${suffix}`, registrationA.user.id, `/uploads/${privateFileName}`, new Date().toISOString());
  testDb.close();
  try {
    const privateA = await fetch(`http://localhost:${port}/uploads/${privateFileName}`, { headers: { Authorization: `Bearer ${a}` } });
    const privateB = await fetch(`http://localhost:${port}/uploads/${privateFileName}`, { headers: { Authorization: `Bearer ${b}` } });
    assert(privateA.status === 200, "A 能访问自己的私有上传文件");
    assert(privateB.status === 404, "B 不能访问 A 的私有上传文件");
  } finally {
    try { unlinkSync(privateFilePath); } catch {}
  }

  // 放弃未确认的导入任务时，同时清理数据库记录和磁盘文件
  const disposableTaskId = `disposable-${suffix}`;
  const disposableFileName = `import-${disposableTaskId}.pdf`;
  const disposableFilePath = new URL(`../uploads/${disposableFileName}`, import.meta.url);
  writeFileSync(disposableFilePath, "%PDF-1.4\n");
  const cleanupDb = new DatabaseSync("/tmp/studyoo-ownership-test.db");
  cleanupDb.prepare(`
    INSERT INTO import_tasks (id, user_id, subject, source_name, pdf_filename, status, total_pages, created_at, updated_at)
    VALUES (?, ?, '数学', 'discard.pdf', ?, 'uploaded', 0, ?, ?)
  `).run(disposableTaskId, registrationA.user.id, disposableFileName, new Date().toISOString(), new Date().toISOString());
  cleanupDb.close();
  const deleteByB = await req(`/import/pipeline/tasks/${disposableTaskId}`, { method: "DELETE", token: b });
  const deleteByA = await req(`/import/pipeline/tasks/${disposableTaskId}`, { method: "DELETE", token: a });
  assert(deleteByB.status === 404, "B 不能删除 A 的导入任务");
  assert(deleteByA.status === 200, "A 能放弃自己的未确认导入任务");
  assert(!existsSync(disposableFilePath), "放弃导入后磁盘 PDF 已清理");

  // PATCH 不存在的记录返回 404
  const patchMiss = await req("/mistakes/not-exist", { method: "PATCH", token: a, body: JSON.stringify({ mastery_status: "reviewing" }) });
  assert(patchMiss.status === 404, "PATCH 不存在的错题记录返回 404");

  console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
} finally {
  child.kill();
}
