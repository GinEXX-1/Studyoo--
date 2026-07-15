import { spawn } from "node:child_process";

const port = "3132";
const baseUrl = `http://127.0.0.1:${port}/api/v1`;
const databasePath = "/tmp/studyoo-admin-onboarding-test.db";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, payload: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("测试服务未启动");
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const child = spawn("node", ["--no-warnings", "src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: port,
    DATABASE_PATH: databasePath,
    UPLOAD_DIR: "/tmp/studyoo-admin-onboarding-uploads",
    JWT_SECRET: "admin-onboarding-test-secret",
    ADMIN_NICKNAMES: "opsadmin",
    ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-test-secret",
    APP_VERSION: "2.4.0-test"
  },
  stdio: "ignore"
});

try {
  await waitForServer();
  const suffix = Date.now();
  const student = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      nickname: `student_${suffix}`,
      password: "123456",
      grade: "高二",
      exam_track: "物理",
      electives: ["化学", "生物"],
      target_score: 620,
      current_score_band: "500-599",
      learning_context: "数学函数与压轴题时间不够"
    })
  });
  const studentToken = student.payload.data.token;
  assert(student.status === 201, "学生注册成功");
  assert(student.payload.data.user.onboarding_completed === true, "新用户画像完整入库");
  assert(student.payload.data.user.subjects.includes("生物"), "3+1+2 自动形成六科学科组合");
  assert(student.payload.data.user.target_score === 620, "目标分数已保存");

  const deniedAdminBootstrap = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ nickname: "opsadmin", password: "123456", grade: "高三" })
  });
  assert(deniedAdminBootstrap.status === 403 && deniedAdminBootstrap.payload.error_code === "ADMIN_BOOTSTRAP_REQUIRED", "保留管理员昵称不能被普通注册抢占");

  const admin = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ nickname: "opsadmin", password: "123456", grade: "高三", admin_bootstrap_token: "admin-bootstrap-test-secret" })
  });
  const adminToken = admin.payload.data.token;
  assert(admin.payload.data.user.is_admin === true, "ADMIN_NICKNAMES 授予管理员权限");

  const feedback = await request("/feedback", {
    method: "POST",
    token: studentToken,
    body: JSON.stringify({ category: "idea", message: "希望学习路径能解释知识点之间的依赖关系。" })
  });
  assert(feedback.status === 201 && feedback.payload.data.status === "open", "学生反馈写入后端");
  assert(feedback.payload.data.app_version === "2.4.0-test", "反馈记录携带应用版本");

  const denied = await request("/admin/dashboard", { token: studentToken });
  assert(denied.status === 403 && denied.payload.error_code === "ADMIN_REQUIRED", "普通学生不能访问 Admin 数据");

  const dashboard = await request("/admin/dashboard", { token: adminToken });
  assert(dashboard.status === 200 && dashboard.payload.data.summary.users >= 2, "管理员可读取实时指标快照");
  assert(dashboard.payload.data.summary.new_users_today >= 2, "今日新增按应用时区统计");
  assert(dashboard.payload.data.summary.open_feedback === 1, "Admin 指标包含待处理反馈");

  const inbox = await request("/admin/feedback", { token: adminToken });
  assert(inbox.payload.data.items[0].user.nickname.startsWith("student_"), "管理员反馈箱包含提交用户");
  const resolved = await request(`/admin/feedback/${feedback.payload.data.id}`, {
    method: "PATCH",
    token: adminToken,
    body: JSON.stringify({ status: "resolved", admin_note: "已纳入知识图谱升级计划。" })
  });
  assert(resolved.payload.data.status === "resolved", "管理员可更新反馈状态与回复");

  const mine = await request("/feedback/mine", { token: studentToken });
  assert(mine.payload.data.items[0].admin_note.includes("知识图谱"), "学生账户页可看到处理回复");

  const webImport = await request("/admin/discovery/import", {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({
      title: "公开题目采集样本",
      subject: "数学",
      source_url: "https://example.com/math-questions",
      questions: [
        { question_number: "1", content_text: "已知函数 $f(x)=x^2$，求 $f(2)$。", official_answer_text: "$4$", knowledge_tags: ["函数"], difficulty: "easy" },
        { question_number: "2", content_text: "求数列 $1,3,5,\u2026$ 的第十项。", official_answer_text: "$19$", knowledge_tags: ["数列"] }
      ]
    })
  });
  assert(webImport.status === 201 && webImport.payload.data.imported_count === 2, "Admin/Codex 可结构化导入网页题目");
  const dashboardAfterImport = await request("/admin/dashboard", { token: adminToken });
  assert(dashboardAfterImport.payload.data.summary.imports_today >= 1, "网页采集计入今日导入指标");

  const discover = await request("/discover?source=web&subject=数学", { token: studentToken });
  assert(discover.payload.data.items.length === 2, "网页采集题实时进入新发现");
  assert(discover.payload.data.items.every((item) => item.source_type === "web" && item.contributor === null), "网页采集与同学共享来源正确区分");
  const communityAfterWebImport = await request("/discover?source=community&subject=数学", { token: studentToken });
  assert(communityAfterWebImport.payload.data.items.length === 0, "网页采集题不混入同学共享筛选");
  const discoveredQuestion = discover.payload.data.items[0];
  const rating = await request(`/discover/${discoveredQuestion.id}/rating`, {
    method: "POST", token: studentToken, body: JSON.stringify({ rating: 5 })
  });
  assert(rating.payload.data.average_rating === 5, "学生可评价新发现题目");
  const saved = await request(`/discover/${discoveredQuestion.id}/save`, { method: "POST", token: studentToken });
  assert(saved.status === 200 && saved.payload.data.collection_id, "学生可将单题加入个人题库");
  const collection = await request(`/collections/${saved.payload.data.collection_id}`, { token: studentToken });
  assert(collection.payload.data.questions.length === 1, "收藏题目出现在个人新发现题库");

  const blockedFetch = await request("/admin/discovery/fetch-preview", {
    method: "POST", token: adminToken, body: JSON.stringify({ url: "https://example.com/questions" })
  });
  assert(blockedFetch.status === 403, "网页抓取默认关闭并受域名白名单保护");

  const graph = await request("/recommend/graph?subject=物理", { token: studentToken });
  assert(graph.status === 200 && graph.payload.data.nodes.length >= 5, "学习路径返回结构化知识节点");
  assert(graph.payload.data.edges.every((edge) => edge.type === "prerequisite"), "学习路径返回明确的前置依赖边");
  assert(graph.payload.data.goal.target_score === 620 && graph.payload.data.goal.estimated_gap === 70, "目标分数与当前分数段参与路径计算");
  assert(graph.payload.data.nodes.some((node) => node.status === "locked"), "未完成前置知识的节点保持锁定");

  const mathGraph = await request("/recommend/graph?subject=数学", { token: studentToken });
  assert(mathGraph.payload.data.goal.context_matches.includes("函数") && mathGraph.payload.data.goal.context_matches.includes("综合应用"), "学情描述归入对应知识节点");
  assert(mathGraph.payload.data.nodes.find((node) => node.tag === "函数").context_matched === true, "学情命中会提高对应节点优先级");
  assert(mathGraph.payload.data.nodes.find((node) => node.tag === "基础运算").context_route === true, "推荐会沿学情重点向前追溯必要前置节点");

  console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
} finally {
  child.kill();
}
