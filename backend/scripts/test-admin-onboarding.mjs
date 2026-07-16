import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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

  const retiredDirectImport = await request("/admin/discovery/import", {
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
  assert(retiredDirectImport.status === 404, "旧直发接口已移除，采集题不能绕过人工审核");
  const retiredPreview = await request("/admin/discovery/fetch-preview", {
    method: "POST", token: adminToken, body: JSON.stringify({ url: "https://example.com/questions" })
  });
  assert(retiredPreview.status === 404, "旧网页预览接口已移除，统一由爬虫任务采集");
  const deniedCrawlJobs = await request("/admin/discovery/crawl-jobs", { token: studentToken });
  assert(deniedCrawlJobs.status === 403, "普通学生不能查看爬虫任务和候选题");
  const crawlJobs = await request("/admin/discovery/crawl-jobs", { token: adminToken });
  assert(crawlJobs.status === 200 && Array.isArray(crawlJobs.payload.data.items), "管理员可读取爬虫任务队列");
  const blockedCrawl = await request("/admin/discovery/crawl", {
    method: "POST", token: adminToken, body: JSON.stringify({ url: "https://example.com/questions", subject: "数学", max_pages: 3 })
  });
  assert(blockedCrawl.status === 403 && blockedCrawl.payload.error_code === "SOURCE_NOT_ALLOWED", "爬虫启动前校验来源域名白名单");

  const crawlJobId = randomUUID();
  const candidateId = randomUUID();
  const createdAt = new Date().toISOString();
  const testDb = new DatabaseSync(databasePath);
  testDb.prepare(`
    INSERT INTO discovery_crawl_jobs (
      id, user_id, seed_url, subject, max_pages, status, pages_crawled, candidates_found, created_at, completed_at
    ) VALUES (?, ?, ?, '数学', 1, 'review', 1, 1, ?, ?)
  `).run(crawlJobId, admin.payload.data.user.id, "https://example.com/questions", createdAt, createdAt);
  testDb.prepare(`
    INSERT INTO discovery_candidates (
      id, job_id, source_url, page_title, content_hash, question_number, question_type,
      content_text, official_answer_text, knowledge_tags_json, difficulty, confidence, status, created_at
    ) VALUES (?, ?, ?, ?, ?, '1', '解答题', ?, ?, '["函数"]', 'easy', 0.95, 'pending', ?)
  `).run(candidateId, crawlJobId, "https://example.com/questions/1", "人工审核样本",
    `manual-review-${candidateId}`, "已知函数 f(x)=x^2，求 f(2)。", "4", createdAt);
  testDb.close();

  const beforeApproval = await request("/discover?source=web&subject=数学", { token: studentToken });
  assert(beforeApproval.payload.data.items.length === 0, "待审核候选题不会出现在学生题库");
  const approved = await request(`/admin/discovery/candidates/${candidateId}/approve`, {
    method: "POST", token: adminToken
  });
  assert(approved.status === 201 && approved.payload.data.status === "approved", "只有管理员人工通过才能发布候选题");
  const afterApproval = await request("/discover?source=web&subject=数学", { token: studentToken });
  assert(afterApproval.payload.data.items.length === 1, "人工审核通过后题目才进入学生题库");

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
