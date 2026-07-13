import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const port = "3204";
const databasePath = "/tmp/studyoo-practice-workflow-test.db";
const base = `http://localhost:${port}/api/v1`;
const child = spawn("node", ["--no-warnings", "src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: port, DATABASE_PATH: databasePath, JWT_SECRET: "practice-workflow-test-secret" },
  stdio: "ignore"
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}
function assert(condition, message) {
  if (condition) console.log("PASS:", message);
  else {
    console.error("FAIL:", message);
    process.exitCode = 1;
  }
}

try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) break;
    } catch {
      await sleep(250);
    }
  }

  const suffix = Date.now();
  const registration = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ nickname: `practice_${suffix}`, password: "123456", grade: "高一" })
  });
  const token = registration.payload.data.token;
  const userId = registration.payload.data.user.id;
  const questionId = `practice-flow-question-${suffix}`;

  await request("/exam/ingest/manual", {
    method: "POST",
    token,
    body: JSON.stringify({
      paper: { id: `practice-flow-paper-${suffix}`, year: 2026, region: "全国", subject: "数学", title: "练习流程测试卷", source_name: "test", license_note: "integration test" },
      questions: [{ id: questionId, question_number: "1", content_text: "计算 $1+1$。", official_answer_text: "$2$", knowledge_tags: ["函数"] }]
    })
  });

  const collectionResponse = await request("/collections", {
    method: "POST",
    token,
    body: JSON.stringify({ title: "待完成题库", subject: "数学", question_ids: [questionId] })
  });
  const collectionId = collectionResponse.payload.data.id;
  const edited = await request(`/collections/${collectionId}`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ title: "已编辑题库", description: "保留进度", cover_style: "blue" })
  });
  assert(edited.payload?.data?.title === "已编辑题库" && edited.payload.data.cover_style === "blue", "未完成题库可以编辑");

  const sessionResponse = await request(`/collections/${collectionId}/sessions`, {
    method: "POST",
    token,
    body: JSON.stringify({ grading_mode: "unified" })
  });
  const session = sessionResponse.payload.data;
  assert(session.grading_mode === "unified", "统一批改模式写入练习会话");

  const practiceResponse = await request(`/practice/questions/practice-${questionId}`, { token });
  const practiceQuestion = practiceResponse.payload.data.question;
  const answerText = "2";
  const normalizedAnswer = answerText.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
  const answerHash = createHash("sha256").update(normalizedAnswer).digest("hex");
  const questionVersion = createHash("sha256").update(JSON.stringify({
    content_text: practiceQuestion.content_text,
    official_answer_text: "$2$",
    knowledge_tags: practiceQuestion.knowledge_tags
  })).digest("hex").slice(0, 16);
  const cacheKey = `${practiceQuestion.id}:${questionVersion}:${answerHash}`;
  const now = new Date().toISOString();
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    INSERT INTO practice_evaluation_cache (
      cache_key, practice_question_id, answer_hash, evaluation_json, hit_count, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(cacheKey, practiceQuestion.id, answerHash, JSON.stringify({
    is_correct: true,
    score: 100,
    feedback_text: "缓存评阅",
    step_breakdown: [{ step_number: 1, explanation: "直接相加" }],
    next_action: "继续练习",
    knowledge_tags: ["函数"]
  }), now, now);
  database.close();

  const attemptResponse = await request(`/practice/questions/${practiceQuestion.id}/attempt`, {
    method: "POST",
    token,
    body: JSON.stringify({ answer_text: answerText, session_id: session.id })
  });
  assert(attemptResponse.payload?.data?.cached === true && attemptResponse.payload.data.attempt.from_cache === true, "相同题目版本和答案直接命中 AI 评阅记忆");

  await request(`/practice/sessions/${session.id}/complete`, { method: "PATCH", token });
  const completedDetail = await request(`/collections/${collectionId}`, { token });
  assert(completedDetail.payload?.data?.collection?.is_completed === true, "整套练习完成后题库标记为已完成");
  const protectedDelete = await request(`/collections/${collectionId}`, { method: "DELETE", token });
  assert(protectedDelete.status === 409, "已完成题库受学习历史保护");

  const unfinished = await request("/collections", {
    method: "POST",
    token,
    body: JSON.stringify({ title: "可删除题库", subject: "数学", question_ids: [questionId] })
  });
  const unfinishedId = unfinished.payload.data.id;
  const unfinishedSession = await request(`/collections/${unfinishedId}/sessions`, {
    method: "POST",
    token,
    body: JSON.stringify({ grading_mode: "individual" })
  });
  assert(unfinishedSession.payload?.data?.status === "active", "未完成题库保留活动会话");
  const deleted = await request(`/collections/${unfinishedId}`, { method: "DELETE", token });
  assert(deleted.status === 200, "未完成题库即使已开始也可以删除");

  const list = await request("/collections", { token });
  assert(list.payload.data.items.some((item) => item.id === collectionId && item.is_completed), "题库列表返回完成状态");
  assert(!list.payload.data.items.some((item) => item.id === unfinishedId), "删除后的未完成题库不再出现");

  const databaseCheck = new DatabaseSync(databasePath);
  const cacheHits = databaseCheck.prepare("SELECT hit_count FROM practice_evaluation_cache WHERE cache_key = ?").get(cacheKey)?.hit_count;
  const followUpTable = databaseCheck.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'practice_follow_ups'").get();
  databaseCheck.close();
  assert(cacheHits === 1, "缓存命中次数正确累加");
  assert(Boolean(followUpTable), "逐步追问记录表迁移完成");

  console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
} finally {
  child.kill();
}
