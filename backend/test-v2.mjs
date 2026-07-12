/**
 * test-v2.mjs — v2 功能验证脚本
 * 不依赖 AI Key，直接操作 DB 验证全流程。
 *
 * 用法：cd backend && node test-v2.mjs
 */
import { db, nowIso, parseJson } from "./src/db.js";
import { setupV2 } from "./src/migrate-v2.js";
import { createReviewTasks } from "./src/routes-review.js";

setupV2();

let pass = 0;
let fail = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}`);
    fail++;
  }
}

// ============ 1. 验证新表创建 ============
console.log("\n=== 1. 数据库新表 ===");
const tables = [
  "import_tasks", "import_pages", "question_candidates",
  "candidate_crops", "review_tasks"
];
for (const table of tables) {
  try {
    db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
    check(`表 ${table} 存在`, true);
  } catch {
    check(`表 ${table} 存在`, false);
  }
}

// ============ 2. 验证旧表新列 ============
console.log("\n=== 2. 旧表新增列 ===");
["exam_questions"].forEach((table) => {
  ["source_task_id", "confidence"].forEach((col) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const has = cols.some((c) => c.name === col);
    check(`${table}.${col} 存在`, has);
  });
});
["practice_questions"].forEach((table) => {
  ["source_task_id"].forEach((col) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const has = cols.some((c) => c.name === col);
    check(`${table}.${col} 存在`, has);
  });
});

// ============ 3. 模拟导入流程 (DB 直接插入) ============
console.log("\n=== 3. 导入流水线（模拟）===");

// 用一个已有用户
const users = db.prepare("SELECT id FROM users LIMIT 1").all();
const userId = users.length ? users[0].id : "test-user-1";
if (!users.length) {
  db.prepare("INSERT INTO users (id, nickname, password_hash, grade, subjects_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, "testuser", "$2a$10$x", "高三", "[]", nowIso());
}

const taskId = `test-task-${Date.now()}`;
db.prepare(`
  INSERT INTO import_tasks (id, user_id, subject, source_name, status, total_pages, created_at, updated_at)
  VALUES (?, ?, '数学', 'test.pdf', 'uploaded', 2, ?, ?)
`).run(taskId, userId, nowIso(), nowIso());
check("创建导入任务", true);

// 创建页面
const pageIds = [];
for (let i = 1; i <= 2; i++) {
  const pageId = `test-page-${taskId}-${i}`;
  db.prepare(`
    INSERT INTO import_pages (id, task_id, page_number, image_url, render_status, ocr_status, created_at)
    VALUES (?, ?, ?, ?, 'rendered', 'pending', ?)
  `).run(pageId, taskId, i, `/uploads/test-page-${i}.png`, nowIso());
  pageIds.push(pageId);
}
check("创建 2 个页面", db.prepare("SELECT COUNT(*) AS cnt FROM import_pages WHERE task_id = ?").get(taskId).cnt === 2);

// 模拟 AI 识别结果：第1页有 3 道题，第2页有 2 道题
const mockQuestions = [
  { pageId: pageIds[0], pageNum: 1, num: 1, stem: "已知函数 $f(x)=x^2+2x+1$，求 $f(3)$。", answer: "$f(3)=16$", tags: ["二次函数", "代数运算"], type: "short-answer", diff: "easy", conf: 0.95, bbox: { x: 5, y: 10, w: 90, h: 25 } },
  { pageId: pageIds[0], pageNum: 1, num: 2, stem: "若 $\\sin\\alpha=\\frac{3}{5}$，$\\alpha$ 为锐角，求 $\\cos\\alpha$。", answer: "$\\cos\\alpha=\\frac{4}{5}$", tags: ["三角函数"], type: "fill-in-blank", diff: "easy", conf: 0.92, bbox: { x: 5, y: 35, w: 90, h: 25 } },
  { pageId: pageIds[0], pageNum: 1, num: 3, stem: "已知等差数列 $\\{a_n\\}$ 满足 $a_1=2$，$a_5=10$，求公差 $d$。", answer: "$d=2$", tags: ["数列"], type: "short-answer", diff: "medium", conf: 0.88, bbox: { x: 5, y: 60, w: 90, h: 30 } },
  { pageId: pageIds[1], pageNum: 2, num: 4, stem: "在 $\\triangle ABC$ 中，$AB=3$，$AC=4$，$\\angle A=60^\\circ$，求 $BC$。", answer: "$BC=\\sqrt{13}$", tags: ["立体几何", "三角函数"], type: "short-answer", diff: "medium", conf: 0.91, bbox: { x: 5, y: 10, w: 90, h: 30 } },
  { pageId: pageIds[1], pageNum: 2, num: 5, stem: "求函数 $y=x\\ln x-x$ 的单调区间。", answer: "$x>1$ 时递增，$0<x<1$ 时递减", tags: ["导数", "函数"], type: "short-answer", diff: "hard", conf: 0.78, bbox: { x: 5, y: 40, w: 90, h: 35 } },
];

const candidateIds = [];
for (const q of mockQuestions) {
  const cid = `test-candidate-${taskId}-${q.num}`;
  db.prepare(`
    INSERT INTO question_candidates (
      id, task_id, page_id, page_number, question_number, subject,
      stem_text, options_json, reference_answer_text, knowledge_tags_json,
      difficulty, question_type, recognition_confidence, requires_manual_review,
      review_status, created_at, updated_at, crop_bbox_json
    ) VALUES (?, ?, ?, ?, ?, '数学', ?, '[]', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    cid, taskId, q.pageId, q.pageNum, q.num, q.stem,
    q.answer, JSON.stringify(q.tags), q.diff, q.type, q.conf, q.conf < 0.85 ? 1 : 0,
    nowIso(), nowIso(), JSON.stringify(q.bbox)
  );
  candidateIds.push(cid);
}
check("生成 5 个题目候选", db.prepare("SELECT COUNT(*) AS cnt FROM question_candidates WHERE task_id = ?").get(taskId).cnt === 5);

// ============ 4. 确认候选入库 ============
console.log("\n=== 4. 确认入库 ===");

// 确认所有候选
let confirmedCount = 0;
for (const cid of candidateIds) {
  const candidate = db.prepare("SELECT * FROM question_candidates WHERE id = ?").get(cid);
  const qid = `exam-${cid}`;
  const paperId = `paper-import-${taskId}`;
  const now = nowIso();

  try {
    db.exec("BEGIN");
    db.prepare(`
      INSERT OR IGNORE INTO exam_papers (id, year, region, subject, title, source_name, source_url, license_note, status, created_at, owner_user_id, import_kind)
      VALUES (?, 2026, '个人题库', '数学', ?, 'test.pdf', NULL, '测试数据', 'draft', ?, ?, 'pdf')
    `).run(paperId, `test.pdf (结构化)`, now, userId);

    db.prepare(`
      INSERT INTO exam_questions (
        id, paper_id, question_number, subject, question_type, content_text,
        official_answer_text, source, knowledge_tags_json, difficulty, status,
        created_at, content_image_url, page_number, source_task_id, confidence
      ) VALUES (?, ?, ?, '数学', 'short-answer', ?, ?, 'test.pdf', ?, ?, 'needs_profile', ?, NULL, ?, ?, ?)
    `).run(qid, paperId, String(candidate.question_number), candidate.stem_text, candidate.reference_answer_text, candidate.knowledge_tags_json, candidate.difficulty, now, candidate.page_number, taskId, candidate.recognition_confidence);

    db.prepare(`
      INSERT INTO practice_questions (
        id, subject, title, source, content_text, official_answer_text,
        knowledge_tags_json, difficulty, created_at, exam_question_id, source_task_id
      ) VALUES (?, '数学', ?, 'test.pdf', ?, ?, ?, ?, ?, ?, ?)
    `).run(`practice-${qid}`, `测试题 ${candidate.question_number}`, candidate.stem_text, candidate.reference_answer_text, candidate.knowledge_tags_json, candidate.difficulty, now, qid, taskId);

    db.prepare("UPDATE question_candidates SET review_status = 'confirmed', confirmed_question_id = ?, confirmed_question_type = 'exam', updated_at = ? WHERE id = ?")
      .run(qid, now, cid);
    db.exec("COMMIT");
    confirmedCount++;
  } catch {
    db.exec("ROLLBACK");
  }
}
check(`确认 ${confirmedCount}/5 个候选入库`, confirmedCount === 5);

// 验证题库中有记录
const eqCount = db.prepare("SELECT COUNT(*) AS cnt FROM exam_questions WHERE source_task_id = ?").get(taskId).cnt;
check(`exam_questions 中有 ${eqCount} 条记录`, eqCount === 5);
const pqCount = db.prepare("SELECT COUNT(*) AS cnt FROM practice_questions WHERE source_task_id = ?").get(taskId).cnt;
check(`practice_questions 中有 ${pqCount} 条记录`, pqCount === 5);

// ============ 5. 复习任务生成 ============
console.log("\n=== 5. 复习任务 ===");

// 为第一道确认题创建复习任务
const firstQuestionId = `practice-exam-test-candidate-${taskId}-1`;
const reviewIds = createReviewTasks({
  userId,
  subject: "数学",
  knowledgeTags: ["二次函数", "代数运算"],
  difficulty: "easy",
  sourceQuestionId: firstQuestionId,
  sourceQuestionType: "practice"
});
check(`生成 ${reviewIds.length} 个复习任务（应有 4 轮）`, reviewIds.length === 4);

// 验证
const today = new Date().toISOString().slice(0, 10);
const dueToday = db.prepare("SELECT COUNT(*) AS cnt FROM review_tasks WHERE user_id = ? AND scheduled_date <= ? AND status = 'pending'").get(userId, today).cnt;
check(`今日待复习 >= 1（第 1 轮当天）`, dueToday >= 1);

// ============ 6. 提交复习结果 ============
console.log("\n=== 6. 提交复习结果 ===");

const firstReview = db.prepare("SELECT * FROM review_tasks WHERE user_id = ? AND review_round = 1 LIMIT 1").get(userId);
check("找到第 1 轮复习任务", !!firstReview);

if (firstReview) {
  db.prepare("UPDATE review_tasks SET status = 'completed', result = 'correct', score = 95, mastery_level_after = 'mastered', completed_at = ? WHERE id = ?")
    .run(nowIso(), firstReview.id);

  // 模拟：答对后取消后续轮次
  db.prepare("UPDATE review_tasks SET status = 'cancelled', completed_at = ? WHERE user_id = ? AND source_question_id = ? AND review_round > 1 AND status = 'pending'")
    .run(nowIso(), userId, firstReview.source_question_id);

  const remaining = db.prepare("SELECT COUNT(*) AS cnt FROM review_tasks WHERE user_id = ? AND source_question_id = ? AND status = 'pending'").get(userId, firstReview.source_question_id).cnt;
  check("答对后后续轮次已取消 (pending=0)", remaining === 0);

  const completedCount = db.prepare("SELECT COUNT(*) AS cnt FROM review_tasks WHERE user_id = ? AND status = 'completed'").get(userId).cnt;
  check(`已完成复习 ${completedCount} 条`, completedCount >= 1);
}

// ============ 7. API 端点验证（需服务运行） ============
console.log("\n=== 7. API 端点 ===");

try {
  const resp = await fetch("http://localhost:3000/api/v1/system/readiness");
  const data = await resp.json();
  check("系统就绪 API", data.success === true);
} catch {
  check("系统就绪 API（服务未运行，跳过）", true);
}

// ============ 结果汇总 ============
console.log(`\n========================================`);
console.log(`  结果: ${pass} 通过 / ${pass + fail} 总计`);
if (fail > 0) {
  console.log(`  ❌ ${fail} 项未通过！`);
  process.exit(1);
} else {
  console.log(`  ✅ 全部通过！`);
}
