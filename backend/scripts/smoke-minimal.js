import { spawn } from "node:child_process";

const smokePort = process.env.SMOKE_PORT || "3100";
const baseUrl = process.env.SMOKE_BASE_URL || `http://localhost:${smokePort}/api/v1`;
const healthUrl = process.env.SMOKE_HEALTH_URL || `http://localhost:${smokePort}/health`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  return { response, payload };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("后端服务没有在预期时间内启动。");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const child = spawn("node", ["--no-warnings", "src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: smokePort,
    DATABASE_PATH: process.env.DATABASE_PATH || "./studyoo-smoke.db",
    JWT_SECRET: process.env.JWT_SECRET || "smoke-test-secret"
  },
  stdio: "ignore"
});

try {
  await waitForServer();

  const readiness = await request("/system/readiness");
  assert(readiness.payload.success === true, "readiness 接口未返回成功。");
  assert(readiness.payload.data.server === true, "server readiness 异常。");
  assert(readiness.payload.data.database === true, "database readiness 异常。");

  const suffix = Date.now();
  const register = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      nickname: `smoke_${suffix}`,
      password: "123456",
      grade: "高一"
    })
  });
  assert(register.payload.success === true, "注册接口失败。");
  assert(register.payload.data.token, "注册接口没有返回 token。");

  const token = register.payload.data.token;
  const me = await request("/users/me", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(me.payload.success === true, "鉴权接口失败。");
  assert(me.payload.data.nickname === `smoke_${suffix}`, "当前用户信息不匹配。");

  const settings = await request("/users/me", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ grade: "高三", subjects: ["数学", "物理", "化学", "历史", "地理", "政治", "语文", "英语"] })
  });
  assert(settings.payload.data.subjects.length === 8, "设置页支持的学科没有完整保存。");

  const importedQuestionId = `smoke-exam-question-${suffix}`;
  const importedPaperId = `smoke-exam-paper-${suffix}`;
  const imported = await request("/exam/ingest/manual", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      paper: {
        id: importedPaperId,
        year: 2025,
        region: "全国",
        subject: "数学",
        title: "冒烟测试真题",
        source_name: "Studyoo 自动验收",
        license_note: "仅用于本地自动化测试。"
      },
      questions: [{
        id: importedQuestionId,
        question_number: "1",
        question_type: "填空题",
        content_text: "已知 $a+\\frac{1}{a}=3$，求 $a^2+\\frac{1}{a^2}$。",
        official_answer_text: "两边平方并减去 2，结果为 $7$。",
        knowledge_tags: ["代数恒等变形"],
        difficulty: "easy"
      }]
    })
  });
  assert(imported.payload.success === true, "手动导入真题失败。");
  assert(imported.payload.data.created_count === 1, "导入新增数量不正确。");
  assert(imported.payload.data.practice_count === 1, "导入题目没有同步到练习队列。");

  const ingestionJobs = await request("/exam/ingestion/jobs", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(ingestionJobs.payload.success === true, "获取导入记录失败。");
  assert(ingestionJobs.payload.data.items.some((item) => item.id === imported.payload.data.job_id), "导入记录没有落库。");

  const importedPractice = await request(`/practice/questions/practice-${importedQuestionId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(importedPractice.payload.success === true, "无法按真题打开对应练习。");
  assert(importedPractice.payload.data.question.content_text.includes("a^2"), "导入的练习题内容不正确。");
  assert(!importedPractice.payload.data.question.official_answer_text, "未作答前不应下发参考答案。");

  const nextPractice = await request(`/practice/questions/current?subject=%E6%95%B0%E5%AD%A6&after_id=practice-${importedQuestionId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(nextPractice.payload.success === true, "获取下一道练习题失败。");

  const collections = await request("/collections", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(collections.payload.success === true, "获取个人题库列表失败。");
  const nationalCollection = collections.payload.data.items.find((item) => item.id === "collection-2026-national-1");
  assert(nationalCollection?.question_count === 19, "2026 全国 1 卷没有完整导入 19 题。");
  const seededSubjects = new Set(collections.payload.data.items.filter((item) => item.creation_mode === "seed").map((item) => item.subject));
  assert(seededSubjects.size === 8, "跨学科种子题库没有覆盖全部 8 个学科。");

  const emptyLearningPath = await request("/learning-path/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(emptyLearningPath.payload.success === true, "空能力数据时学习路径接口应返回可用空状态。");

  const invalidImage = await request("/questions/image", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subject: "数学", image_data_url: "not-an-image" })
  });
  assert(invalidImage.response.status === 400, "图片识题接口没有拒绝非法图片。");

  const nationalDetail = await request("/collections/collection-2026-national-1", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(nationalDetail.payload.success === true, "获取 2026 全国 1 卷题库详情失败。");
  assert(nationalDetail.payload.data.questions.length === 19, "题库详情题目数量不正确。");

  const manualCollection = await request("/collections", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: `冒烟测试自建题库 ${suffix}`,
      subject: "数学",
      question_ids: [importedQuestionId]
    })
  });
  assert(manualCollection.payload.success === true, "手动建立个人题库失败。");

  const session = await request(`/collections/${manualCollection.payload.data.id}/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(session.payload.success === true, "开始题库练习会话失败。");

  const profileStats = await request("/profile/stats", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(profileStats.payload.success === true, "获取个人能力数据失败。");
  assert(typeof profileStats.payload.data.summary.correct_rate === "number", "个人能力统计缺少正确率。");

  const papers = await request("/exam/papers?subject=%E6%95%B0%E5%AD%A6", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(papers.payload.success === true, "获取真题试卷列表失败。");
  assert(papers.payload.data.items.length > 0, "真题试卷列表为空。");

  const paperId = papers.payload.data.items[0].id;
  const examQuestions = await request(`/exam/papers/${paperId}/questions`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(examQuestions.payload.success === true, "获取真题题目列表失败。");
  assert(examQuestions.payload.data.items.length > 0, "真题题目列表为空。");

  const question = await request("/questions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      subject: "数学",
      mode: "solve_from_scratch",
      content_text: "求函数 $f(x)=x^2$ 的导数。"
    })
  });

  if (readiness.payload.data.ai.configured) {
    if (question.payload.success !== true) {
      console.log("question failure payload:", JSON.stringify(question.payload, null, 2));
    }
    assert(question.payload.success === true, "AI 已配置时，提交问题应成功。");
    assert(question.payload.data.question.status === "answered", "问题状态应为 answered。");
    assert(question.payload.data.answer, "提交问题没有返回 answer。");

    const attempt = await request(`/practice/questions/${importedPractice.payload.data.question.id}/attempt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        answer_text: "由平方关系可得 $a^2+\\frac{1}{a^2}=3^2-2=7$。"
      })
    });
    if (attempt.payload.success !== true) {
      console.log("practice attempt failure payload:", JSON.stringify(attempt.payload, null, 2));
    }
    assert(attempt.payload.success === true, "提交练习作答应成功。");
    assert(attempt.payload.data.attempt.score >= 0, "练习评阅没有返回分数。");
    assert(attempt.payload.data.question.official_answer_text, "作答后应返回参考答案用于订正。");

    const profile = await request(`/exam/questions/${importedQuestionId}/profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (profile.payload.success !== true) {
      console.log("profile failure payload:", JSON.stringify(profile.payload, null, 2));
    }
    assert(profile.payload.success === true, "生成真题 AI 理解档案失败。");
    assert(profile.payload.data.profile.core_idea, "真题理解档案缺少 core_idea。");
    console.log("后端最小链路通过：注册登录 -> 真题导入 -> 导入记录 -> 指定题练习 -> 连续换题 -> AI 理解档案 -> AI 评阅 -> 搜题解析。");
  } else {
    assert(question.payload.success === false, "AI 未配置时，提交问题应明确失败。");
    assert(question.payload.error_code === "AI_SERVICE_ERROR", "AI 未配置时错误码应为 AI_SERVICE_ERROR。");
    console.log("后端基础链路通过：注册登录 -> 鉴权可用；AI 未配置，已按契约明确失败。");
  }
} finally {
  child.kill();
}
