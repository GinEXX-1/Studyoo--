const BASE = "http://localhost:3000/api/v1";
const SUFFIX = Date.now();

async function req(path, { headers = {}, ...rest } = {}) {
  const resp = await fetch(BASE + path, {
    ...rest,
    headers: { "Content-Type": "application/json", ...headers },
  });
  const body = await resp.json();
  return { status: resp.status, body };
}

function check(name, condition, detail) {
  if (condition) {
    console.log("  ✅", name);
    return true;
  }
  console.log("  ❌", name, "|", detail || "");
  return false;
}

const results = [];
function test(name, fn) {
  return async () => {
    try {
      const ok = await fn();
      results.push({ name, ok });
    } catch (e) {
      console.log("  ❌", name, "| 异常:", e.message);
      results.push({ name, ok: false });
    }
  };
}

async function run() {
  console.log("=== Studyoo 端到端联调测试 ===\n");

  // 1. 环境检查
  await test("GET /system/readiness", async () => {
    const { body } = await req("/system/readiness");
    return (
      check("server=true", body.data.server) &&
      check("database=true", body.data.database) &&
      check("AI configured", body.data.ai.configured)
    );
  })();

  // 2. 注册
  let token;
  await test("POST /auth/register", async () => {
    const { body } = await req("/auth/register", {
      method: "POST",
      body: JSON.stringify({ nickname: `e2e_${SUFFIX}`, password: "123456", grade: "高三" }),
    });
    token = body.data?.token;
    return (
      check("返回 token", !!token) &&
      check("nickname 正确", body.data?.user?.nickname === `e2e_${SUFFIX}`)
    );
  })();

  if (!token) {
    console.log("\n❌ 无法获取 token，终止测试。");
    printSummary();
    return;
  }
  const auth = { headers: { Authorization: "Bearer " + token } };

  // 3. 登录
  await test("POST /auth/login", async () => {
    const { body } = await req("/auth/login", {
      method: "POST",
      body: JSON.stringify({ nickname: `e2e_${SUFFIX}`, password: "123456", grade: "高三" }),
    });
    return check("登录成功", body.success && !!body.data?.token);
  })();

  // 4. 获取当前用户
  await test("GET /users/me", async () => {
    const { body } = await req("/users/me", auth);
    return check("返回用户信息", body.success && body.data?.nickname === `e2e_${SUFFIX}`);
  })();

  // ========== 验收题集 ==========

  // 题1：公式渲染 (solve_from_scratch)
  console.log("\n--- 验收题1: 公式渲染 (solve_from_scratch) ---");
  let q1;
  await test("提交分式题 solve_from_scratch", async () => {
    const { body } = await req("/questions", {
      method: "POST",
      ...auth,
      body: JSON.stringify({
        subject: "数学",
        mode: "solve_from_scratch",
        content_text:
          '求函数 $f(x)=\\frac{x^2-1}{x-1}$ 在 $x \\ne 1$ 时的化简结果，并说明为什么 $x=1$ 不能直接代入。',
      }),
    });
    q1 = body.data;
    let ok = check("返回 question", !!body.data?.question);
    ok = check("status=answered", body.data?.question?.status === "answered") && ok;
    ok = check("有 hint_text", !!body.data?.answer?.hint_text) && ok;
    ok =
      check("full_solution_text 为 null", body.data?.answer?.full_solution_text === null) && ok;
    ok = check("公式含 $ 标记", body.data?.answer?.hint_text?.includes("$")) && ok;
    return ok;
  })();

  if (!q1?.question?.id) {
    console.log("\n❌ 题1失败，跳过后续。");
    printSummary();
    return;
  }

  // 题1：请求完整解答
  await test("POST /reveal-solution (题1)", async () => {
    const { body } = await req(`/questions/${q1.question.id}/reveal-solution`, {
      method: "POST",
      ...auth,
    });
    let ok = check("返回 full_solution_text", !!body.data?.full_solution_text);
    ok = check("revealed_full_solution=true", body.data?.revealed_full_solution === true) && ok;
    return ok;
  })();

  // 题2：深化官方答案
  console.log("\n--- 验收题2: deepen_official_answer ---");
  let q2;
  await test("提交数列题 deepen_official_answer", async () => {
    const { body } = await req("/questions", {
      method: "POST",
      ...auth,
      body: JSON.stringify({
        subject: "数学",
        mode: "deepen_official_answer",
        content_text:
          "已知数列 $\\{a_n\\}$ 满足 $a_1=1$，$a_{n+1}=2a_n+1$，求通项公式。",
        official_answer_text:
          "令 $b_n=a_n+1$，则 $b_{n+1}=2b_n$，所以 $b_n=2^n$，故 $a_n=2^n-1$。",
      }),
    });
    q2 = body.data;
    let ok = check("状态 answered", body.data?.question?.status === "answered");
    ok = check("有 step_breakdown", body.data?.answer?.step_breakdown?.length > 0) && ok;
    ok = check("有 full_solution_text（deepen 直接给）", !!body.data?.answer?.full_solution_text) && ok;
    return ok;
  })();

  // 题3：从零开始问
  console.log("\n--- 验收题3: solve_from_scratch 三角函数 ---");
  let q3;
  await test("提交三角函数 solve_from_scratch", async () => {
    const { body } = await req("/questions", {
      method: "POST",
      ...auth,
      body: JSON.stringify({
        subject: "数学",
        mode: "solve_from_scratch",
        content_text:
          "已知 $\\sin x+\\cos x=\\frac{1}{2}$，求 $\\sin x\\cos x$。",
      }),
    });
    q3 = body.data;
    check("hint_text 不为空", !!body.data?.answer?.hint_text);
    return check("full_solution_text 为 null", body.data?.answer?.full_solution_text === null);
  })();

  // 题4：追问上下文
  console.log("\n--- 验收题4: 追问 ---");
  await test("提交追问", async () => {
    if (!q2?.question?.id) return check("有 q2", false, "题2失败");
    const { body } = await req(`/questions/${q2.question.id}/follow-up`, {
      method: "POST",
      ...auth,
      body: JSON.stringify({ content_text: "为什么不是令 $b_n=a_n-1$？" }),
    });
    return check("返回 reply_text", !!body.data?.reply_text);
  })();

  // ========== 错题本 ==========
  console.log("\n--- 错题本模块 ---");
  await test("GET /mistakes", async () => {
    const { body } = await req("/mistakes", auth);
    return (
      check("返回 items 数组", Array.isArray(body.data?.items)) &&
      check("返回 pagination", !!body.data?.pagination)
    );
  })();

  await test("GET /mistakes/stats", async () => {
    const { body } = await req("/mistakes/stats", auth);
    return check("返回 tags 数组", Array.isArray(body.data?.tags));
  })();

  await test("PATCH /mistakes/:id", async () => {
    const { body: list } = await req("/mistakes", auth);
    if (!list.data?.items?.length) {
      console.log("  ⚠️ 无错题记录，跳过 PATCH 测试");
      return true;
    }
    const id = list.data.items[0].id;
    const { body } = await req(`/mistakes/${id}`, {
      method: "PATCH",
      ...auth,
      body: JSON.stringify({ mastery_status: "reviewing" }),
    });
    return check("mastery_status 更新为 reviewing", body.data?.mastery_status === "reviewing");
  })();

  // ========== 学习路径 ==========
  console.log("\n--- 学习路径模块 ---");
  await test("GET /learning-path", async () => {
    const { body } = await req("/learning-path", auth);
    return check("返回 items 数组", Array.isArray(body.data?.items));
  })();

  // ========== 边界测试 ==========
  console.log("\n--- 边界测试 ---");
  await test("登录错误密码不泄露用户存在", async () => {
    const { body } = await req("/auth/login", {
      method: "POST",
      body: JSON.stringify({ nickname: `e2e_${SUFFIX}`, password: "wrong", grade: "高三" }),
    });
    return check("统一错误消息", !body.success && body.message?.includes("昵称或密码不正确"));
  })();

  await test("无效 token 返回 AUTH_INVALID_TOKEN", async () => {
    const { body } = await req("/users/me", {
      headers: { Authorization: "Bearer invalid_token_here" },
    });
    return check("error_code", body.error_code === "AUTH_INVALID_TOKEN");
  })();

  await test("缺少必填字段返回 VALIDATION_ERROR", async () => {
    const { body } = await req("/questions", {
      method: "POST",
      ...auth,
      body: JSON.stringify({ subject: "", mode: "solve_from_scratch", content_text: "" }),
    });
    return check("校验失败", !body.success && body.error_code === "VALIDATION_ERROR");
  })();

  await test("不合法 mode 返回 VALIDATION_ERROR", async () => {
    const { body } = await req("/questions", {
      method: "POST",
      ...auth,
      body: JSON.stringify({ subject: "数学", mode: "bad_mode", content_text: "test" }),
    });
    return check("校验失败", !body.success && body.error_code === "VALIDATION_ERROR");
  })();

  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.ok !== false).length;
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n========================================`);
  console.log(`  端到端联调结果: ${passed} 通过, ${failed} 失败`);
  console.log(`========================================`);
}

run();
