// 重做机制端到端测试（含 mock AI 服务，不消耗真实额度）
// 覆盖状态机：wrong → corrected(标记订正) → redo_pending → redo_failed → redo_pending → redo_passed
// 以及设计红线：重做遮蔽模式下后端绝不下发参考答案与历史反馈。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const apiPort = "3205";
const aiPort = "3305";
const databasePath = "/tmp/studyoo-redo-test.db";
const base = `http://localhost:${apiPort}/api/v1`;

// ——— mock AI：作答里带"这是错的"就给低分，否则给高分 ———
const aiServer = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    // 只看"本次作答"区块：重做 prompt 会携带上一次（错误的）作答，不能整体扫描
    let answerSection = body;
    try {
      const text = JSON.parse(body).messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
      const match = text.match(/---BEGIN (?:本次重做作答|学生作答)---([\s\S]*?)---END/);
      if (match) answerSection = match[1];
    } catch {
      // 保底用整个 body
    }
    const isBad = answerSection.includes("这是错的");
    const evaluation = {
      is_correct: !isBad,
      score: isBad ? 45 : 88,
      feedback_text: isBad ? "关键一步仍然没有走通。" : "这次把关键一步补上了。",
      progress_note: isBad ? "上次卡在配方，这次仍未完成配方。" : "上次卡在配方，这次已正确完成并得到结论。",
      step_breakdown: [{ step_number: 1, explanation: "先配方，再判断最值。" }],
      next_action: isBad ? "回到解析入口看配方步骤。" : "三天后做一道同类题巩固。",
      knowledge_tags: ["二次函数"]
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(evaluation) } }],
      usage: { total_tokens: 321 }
    }));
  });
});
aiServer.listen(Number(aiPort));

const child = spawn("node", ["--no-warnings", "src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: apiPort,
    DATABASE_PATH: databasePath,
    JWT_SECRET: "redo-test-secret",
    AI_API_KEY: "mock-key",
    AI_BASE_URL: `http://localhost:${aiPort}/v4/chat/completions`
  },
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
      const response = await fetch(`http://localhost:${apiPort}/health`);
      if (response.ok) break;
    } catch {
      await sleep(250);
    }
  }

  const suffix = Date.now();
  const registration = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ nickname: `redo_${suffix}`, password: "123456", grade: "高二", contact: "wx: redo-test" })
  });
  const token = registration.payload.data.token;
  const userId = registration.payload.data.user.id;
  assert(registration.status === 201 && registration.payload.data.user.contact === "wx: redo-test", "注册可选联系方式已保存");

  const questionId = `redo-question-${suffix}`;
  await request("/exam/ingest/manual", {
    method: "POST",
    token,
    body: JSON.stringify({
      paper: { id: `redo-paper-${suffix}`, year: 2026, region: "全国", subject: "数学", title: "重做测试卷", source_name: "test", license_note: "integration test" },
      questions: [{ id: questionId, question_number: "1", content_text: "求 $x^2-2x+3$ 的最小值。", official_answer_text: "配方得 $(x-1)^2+2$，最小值 $2$。", knowledge_tags: ["二次函数"] }]
    })
  });
  const practiceId = `practice-${questionId}`;

  // 1) 首答做错 → 状态机进入 wrong
  const first = await request(`/practice/questions/${practiceId}/attempt`, {
    method: "POST",
    token,
    body: JSON.stringify({ answer_text: "最小值是 3。这是错的" })
  });
  assert(first.status === 200 && first.payload.data.attempt.is_correct === false, "首答未通过，正常评阅");
  assert(first.payload.data.attempt.attempt_round === 1 && first.payload.data.attempt.is_redo === false, "首答 round=1 且非重做");
  assert(first.payload.data.correction?.correction_status === "wrong", "首答错误后 correction_status=wrong");
  const firstAttemptId = first.payload.data.attempt.id;

  // 2) 未标记订正前，重做遮蔽模式不可用
  const premature = await request(`/practice/questions/${practiceId}?mode=redo`, { token });
  assert(premature.status === 400, "未标记订正时重做模式返回 400");

  // 3) 标记已订正 → redo_pending
  const correction = await request(`/practice/questions/${practiceId}/corrections`, {
    method: "POST",
    token,
    body: JSON.stringify({ note: "我理解了：应先配方" })
  });
  assert(correction.status === 200 && correction.payload.data.correction_status === "redo_pending", "标记订正后进入 redo_pending");
  assert(Boolean(correction.payload.data.redo_available_at), "订正返回建议重做时间（间隔效应）");

  // 4) 遮蔽模式：绝不下发参考答案与历史作答（设计红线）
  const redoView = await request(`/practice/questions/${practiceId}?mode=redo`, { token });
  assert(redoView.status === 200 && redoView.payload.data.redo_mode === true, "重做模式题面可获取");
  assert(redoView.payload.data.question.official_answer_text === undefined, "重做模式不下发参考答案");
  assert(redoView.payload.data.latest_attempt === null, "重做模式不下发历史作答与反馈");

  // 5) 重做仍错 → redo_count+1，回 corrected
  const redoFail = await request(`/practice/questions/${practiceId}/attempt`, {
    method: "POST",
    token,
    body: JSON.stringify({ answer_text: "最小值是 1。这是错的", redo_of_attempt_id: firstAttemptId })
  });
  assert(redoFail.status === 200 && redoFail.payload.data.attempt.is_redo === true && redoFail.payload.data.attempt.attempt_round === 2, "重做提交 round=2 且标记 is_redo");
  assert(Boolean(redoFail.payload.data.attempt.progress_note), "重做评阅返回 progress_note 对比反馈");
  assert(redoFail.payload.data.correction.correction_status === "corrected" && redoFail.payload.data.correction.redo_count === 1, "重做失败回到 corrected 且 redo_count=1");
  assert(redoFail.payload.data.previous_attempt?.id === firstAttemptId, "响应携带上一次作答用于对比展示");
  const failAttemptId = redoFail.payload.data.attempt.id;

  // 6) 再订正 → 重做通过 → redo_passed + 触发间隔复习链
  await request(`/practice/questions/${practiceId}/corrections`, {
    method: "POST", token, body: JSON.stringify({ note: "配方符号错了，已改正" })
  });
  const redoPass = await request(`/practice/questions/${practiceId}/attempt`, {
    method: "POST",
    token,
    body: JSON.stringify({ answer_text: "配方 $(x-1)^2+2$，最小值 2。", redo_of_attempt_id: failAttemptId })
  });
  assert(redoPass.status === 200 && redoPass.payload.data.attempt.is_correct === true && redoPass.payload.data.attempt.attempt_round === 3, "重做通过 round=3");
  assert(redoPass.payload.data.correction.correction_status === "redo_passed", "重做通过后 correction_status=redo_passed");

  const pendingReviews = await request("/review/pending", { token });
  assert((pendingReviews.payload.data.items || []).length > 0, "重做通过后存在间隔复习任务链");

  // 7) 订正历史按轮次排列
  const history = await request(`/practice/questions/${practiceId}/attempts`, { token });
  const rounds = history.payload.data.items.map((item) => item.attempt_round);
  assert(JSON.stringify(rounds) === JSON.stringify([1, 2, 3]), "订正历史返回完整 round 序列 1→2→3");

  // 8) 越权：他人的 attempt 不能被当作重做父级
  const other = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ nickname: `redo_b_${suffix}`, password: "123456", grade: "高二" })
  });
  const crossRedo = await request(`/practice/questions/${practiceId}/attempt`, {
    method: "POST",
    token: other.payload.data.token,
    body: JSON.stringify({ answer_text: "任意作答", redo_of_attempt_id: firstAttemptId })
  });
  assert(crossRedo.status === 404, "他人 attempt 不能作为重做父级 (404)");

  // 9) 个人页统计：订正率与重做通过率
  const stats = await request("/profile/stats", { token });
  assert(stats.payload.data.corrections?.correction_rate === 100, "个人页返回订正率");
  assert(stats.payload.data.corrections?.redo_total === 2 && stats.payload.data.corrections?.redo_pass_rate === 50, "个人页返回重做通过率");

  // 10) token 用量与事件埋点已入库
  const databaseCheck = new DatabaseSync(databasePath);
  const usage = databaseCheck.prepare("SELECT SUM(tokens) AS tokens FROM ai_usage WHERE user_id = ?").get(userId);
  assert(Number(usage.tokens) > 0, "AI token 用量已按用户记账");
  const eventNames = databaseCheck.prepare("SELECT DISTINCT event_name FROM events WHERE user_id = ?").all(userId).map((row) => row.event_name);
  for (const expected of ["register", "attempt_submitted", "correction_marked", "redo_submitted", "redo_passed"]) {
    assert(eventNames.includes(expected), `事件埋点已记录：${expected}`);
  }
  databaseCheck.close();

  console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
} finally {
  child.kill();
  aiServer.close();
}
