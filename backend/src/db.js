import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { nationalOne2026 } from "./seed-2026-national-1.js";
import { multiSubjectSeed } from "./seed-multi-subject.js";

const dbPath = resolve(config.databasePath);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  grade TEXT NOT NULL,
  subjects_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  mode TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_image_url TEXT,
  official_answer_text TEXT,
  official_answer_image_url TEXT,
  knowledge_tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL UNIQUE,
  hint_text TEXT,
  step_breakdown_json TEXT NOT NULL DEFAULT '[]',
  full_solution_text TEXT,
  revealed_full_solution INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content_text TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS mistake_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  knowledge_tags_json TEXT NOT NULL DEFAULT '[]',
  mistake_count INTEGER NOT NULL DEFAULT 1,
  mastery_status TEXT NOT NULL DEFAULT 'weak',
  last_reviewed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS learning_path_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  knowledge_tag TEXT NOT NULL,
  reason TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  related_question_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS knowledge_tags (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  canonical_tag TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(subject, normalized_key)
);

CREATE TABLE IF NOT EXISTS knowledge_tag_aliases (
  subject TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  alias_text TEXT NOT NULL,
  PRIMARY KEY (subject, alias_key),
  FOREIGN KEY (tag_id) REFERENCES knowledge_tags(id)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  used_on TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, used_on),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS practice_questions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  content_text TEXT NOT NULL,
  official_answer_text TEXT NOT NULL,
  knowledge_tags_json TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practice_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  practice_question_id TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  is_correct INTEGER NOT NULL,
  score INTEGER NOT NULL,
  feedback_text TEXT NOT NULL,
  step_breakdown_json TEXT NOT NULL DEFAULT '[]',
  next_action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (practice_question_id) REFERENCES practice_questions(id)
);

CREATE TABLE IF NOT EXISTS exam_papers (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  region TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  license_note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_questions (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  question_number TEXT NOT NULL,
  subject TEXT NOT NULL,
  question_type TEXT NOT NULL,
  content_text TEXT NOT NULL,
  official_answer_text TEXT NOT NULL,
  source TEXT NOT NULL,
  knowledge_tags_json TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'needs_profile',
  created_at TEXT NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES exam_papers(id)
);

CREATE TABLE IF NOT EXISTS ai_question_profiles (
  id TEXT PRIMARY KEY,
  exam_question_id TEXT NOT NULL UNIQUE,
  knowledge_tags_json TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  core_idea TEXT NOT NULL,
  common_mistakes_json TEXT NOT NULL DEFAULT '[]',
  exam_intent TEXT NOT NULL,
  prerequisites_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (exam_question_id) REFERENCES exam_questions(id)
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  imported_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_collections (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  subject TEXT NOT NULL,
  creation_mode TEXT NOT NULL DEFAULT 'manual',
  cover_style TEXT NOT NULL DEFAULT 'mint',
  source_paper_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (source_paper_id) REFERENCES exam_papers(id)
);

CREATE TABLE IF NOT EXISTS collection_questions (
  collection_id TEXT NOT NULL,
  exam_question_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (collection_id, exam_question_id),
  FOREIGN KEY (collection_id) REFERENCES question_collections(id),
  FOREIGN KEY (exam_question_id) REFERENCES exam_questions(id)
);

CREATE TABLE IF NOT EXISTS practice_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_position INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (collection_id) REFERENCES question_collections(id)
);

CREATE TABLE IF NOT EXISTS practice_evaluation_cache (
  cache_key TEXT PRIMARY KEY,
  practice_question_id TEXT NOT NULL,
  answer_hash TEXT NOT NULL,
  evaluation_json TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  FOREIGN KEY (practice_question_id) REFERENCES practice_questions(id)
);

CREATE TABLE IF NOT EXISTS practice_follow_ups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  practice_question_id TEXT NOT NULL,
  attempt_id TEXT,
  context_type TEXT NOT NULL DEFAULT 'analysis',
  context_text TEXT,
  content_text TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (practice_question_id) REFERENCES practice_questions(id),
  FOREIGN KEY (attempt_id) REFERENCES practice_attempts(id)
);
`);

// 全站每日 AI 用量（防批量注册绕过按用户配额烧钱）
db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage_global (
  used_on TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
`);

// 最小事件埋点：只为回答"用户在哪一步流失"，不做通用分析平台
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  event_name TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name_time ON events(event_name, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, created_at);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS user_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  admin_note TEXT,
  app_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_status_time ON user_feedback(status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_user_time ON user_feedback(user_id, created_at);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS discovery_ratings (
  user_id TEXT NOT NULL,
  exam_question_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, exam_question_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (exam_question_id) REFERENCES exam_questions(id)
);
CREATE INDEX IF NOT EXISTS idx_discovery_ratings_question ON discovery_ratings(exam_question_id, rating);
`);

// 重做机制：一道做错的练习题从"错"到"会"的订正状态机
// wrong → corrected → redo_pending → redo_passed / redo_failed(回 corrected)
// 注：《重做机制开发计划》原案复用 mistake_records，但该表外键绑定解析题（questions），
// 练习题（practice_questions）不共享 ID 空间，故单独建表。
db.exec(`
CREATE TABLE IF NOT EXISTS practice_corrections (
  user_id TEXT NOT NULL,
  practice_question_id TEXT NOT NULL,
  correction_status TEXT NOT NULL DEFAULT 'wrong',
  note TEXT,
  redo_count INTEGER NOT NULL DEFAULT 0,
  redo_available_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, practice_question_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (practice_question_id) REFERENCES practice_questions(id)
);
`);

/**
 * 添加数据库列（仅接受硬编码字面量，禁止传入用户输入）。
 * 所有调用均使用编译时常量，不存在 SQL 注入风险。
 * @param {string} table - 受信任的表名（硬编码）
 * @param {string} column - 受信任的列名（硬编码）
 * @param {string} definition - 受信任的列定义（硬编码）
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("exam_papers", "owner_user_id", "TEXT");
ensureColumn("exam_papers", "pdf_url", "TEXT");
ensureColumn("exam_papers", "cover_image_url", "TEXT");
ensureColumn("exam_papers", "import_kind", "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn("exam_questions", "content_image_url", "TEXT");
ensureColumn("exam_questions", "page_number", "INTEGER");
ensureColumn("exam_questions", "has_figure", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("practice_questions", "content_image_url", "TEXT");
ensureColumn("practice_questions", "exam_question_id", "TEXT");
ensureColumn("practice_questions", "owner_user_id", "TEXT");
ensureColumn("practice_questions", "has_figure", "INTEGER NOT NULL DEFAULT 0");
// 注：question_candidates.has_figure 在 migrate-v2.js 里补（该表在那里创建）
// 共享题库：owner 勾选共享后对全体用户可见可练；编辑/删除仍仅限 owner
ensureColumn("exam_papers", "is_shared", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("practice_questions", "is_shared", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("question_collections", "is_shared", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("practice_attempts", "from_cache", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("practice_sessions", "grading_mode", "TEXT NOT NULL DEFAULT 'individual'");
ensureColumn("learning_path_items", "source", "TEXT NOT NULL DEFAULT 'ai'");
ensureColumn("learning_path_items", "generated_at", "TEXT");
// 密码找回兜底：注册时可选留联系方式（QQ/微信/手机任一），忘记密码时管理员据此人工核验
ensureColumn("users", "contact", "TEXT");
// 新用户画像：3+1+2 选科、目标与当前学情，作为学习路径的初始先验。
ensureColumn("users", "exam_track", "TEXT");
ensureColumn("users", "electives_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("users", "target_score", "INTEGER");
ensureColumn("users", "current_score_band", "TEXT");
ensureColumn("users", "learning_context", "TEXT");
ensureColumn("users", "onboarding_completed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
// 重做机制：作答轮次链（第几次作答、指向被重做的那次、AI 对比反馈）
ensureColumn("practice_attempts", "attempt_round", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("practice_attempts", "parent_attempt_id", "TEXT");
ensureColumn("practice_attempts", "is_redo", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("practice_attempts", "progress_note", "TEXT");
// 配额从"按次"升级为"按 token 成本"计量（次数护栏保留）
ensureColumn("ai_usage", "tokens", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("ai_usage_global", "tokens", "INTEGER NOT NULL DEFAULT 0");

// 复合索引（v2.1 审计 P1 项）：高频查询路径
db.exec(`
CREATE INDEX IF NOT EXISTS idx_practice_attempts_user_question ON practice_attempts(user_id, practice_question_id, created_at);
CREATE INDEX IF NOT EXISTS idx_practice_attempts_user_time ON practice_attempts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mistake_records_user_status ON mistake_records(user_id, mastery_status);
CREATE INDEX IF NOT EXISTS idx_questions_user_status ON questions(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_learning_path_user_status ON learning_path_items(user_id, status);
CREATE INDEX IF NOT EXISTS idx_practice_questions_subject_owner ON practice_questions(subject, owner_user_id);
`);

for (const nickname of config.adminNicknames) {
  db.prepare("UPDATE users SET is_admin = 1 WHERE nickname = ?").run(nickname);
}

const canonicalTagCatalog = {
  "数学": {
    "函数": ["函数性质", "函数的性质"],
    "二次函数": ["二次函数性质", "二次函数的性质"],
    "三角函数": ["三角函数性质", "三角函数特殊值"],
    "代数恒等变形": ["恒等变形", "三角恒等变形", "三角恒等变换", "代数恒等式"],
    "数列": ["数列基础"],
    "导数": ["函数导数", "导数应用"],
    "概率统计": ["概率", "统计", "统计与概率"],
    "立体几何": ["空间几何"],
    "解析几何": ["圆锥曲线", "坐标几何"]
  },
  "物理": {
    "运动学": ["匀变速运动", "直线运动"],
    "牛顿运动定律": ["牛顿定律", "受力分析"],
    "电路": ["欧姆定律", "直流电路"],
    "电磁学": ["电磁感应"],
    "机械能": ["动能定理", "能量守恒"]
  },
  "化学": {
    "物质的量": ["摩尔", "摩尔质量"],
    "离子反应": ["离子方程式"],
    "氧化还原反应": ["氧化还原"],
    "化学平衡": ["平衡移动"],
    "有机化学": ["有机物"]
  },
  "历史": {
    "中国近代史": ["近代中国"],
    "中国现代史": ["现代中国"],
    "世界近代史": ["近代世界"],
    "工业革命": ["第一次工业革命", "第二次工业革命"],
    "史料实证": ["史料分析"]
  },
  "地理": {
    "大气运动": ["大气环流", "季风环流"],
    "地球运动": ["昼夜长短", "太阳高度"],
    "城市化": ["城镇化"],
    "农业区位": ["农业区位因素"],
    "区域可持续发展": ["可持续发展"]
  },
  "政治": {
    "市场经济": ["市场配置资源", "社会主义市场经济"],
    "依法治国": ["全面依法治国", "法治国家"],
    "民主政治": ["人民民主"],
    "哲学原理": ["生活与哲学"],
    "文化传承": ["文化生活"]
  },
  "语文": {
    "现代文阅读": ["现代文", "阅读理解"],
    "文言文阅读": ["文言文", "古文阅读"],
    "古诗词鉴赏": ["诗歌鉴赏", "古诗鉴赏"],
    "语言文字运用": ["语言运用"],
    "写作": ["作文", "议论文写作"]
  },
  "英语": {
    "阅读理解": ["英语阅读", "阅读推断"],
    "语法": ["英语语法", "语法填空"],
    "词汇": ["英语词汇"],
    "完形填空": ["完形"],
    "书面表达": ["英语写作", "应用文写作"]
  }
};

export function tagKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s·、，,。.!！?？:：;；()（）《》\[\]【】_-]/g, "");
}

function seedKnowledgeTags() {
  const createdAt = nowIso();
  for (const [subject, entries] of Object.entries(canonicalTagCatalog)) {
    for (const [canonicalTag, aliases] of Object.entries(entries)) {
      const normalizedKey = tagKey(canonicalTag);
      const id = `tag-${subject}-${normalizedKey}`;
      db.prepare(`
        INSERT OR IGNORE INTO knowledge_tags (id, subject, canonical_tag, normalized_key, aliases_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, subject, canonicalTag, normalizedKey, JSON.stringify(aliases), createdAt);
      for (const alias of [canonicalTag, ...aliases]) {
        db.prepare(`
          INSERT OR REPLACE INTO knowledge_tag_aliases (subject, alias_key, tag_id, alias_text)
          VALUES (?, ?, ?, ?)
        `).run(subject, tagKey(alias), id, alias);
      }
    }
  }
}

seedKnowledgeTags();

export function canonicalTagsForSubject(subject) {
  return db.prepare("SELECT canonical_tag FROM knowledge_tags WHERE subject = ? ORDER BY canonical_tag")
    .all(subject)
    .map((row) => row.canonical_tag);
}

export function normalizeKnowledgeTags(subject, values) {
  const result = [];
  for (const rawValue of Array.isArray(values) ? values : []) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) continue;
    const key = tagKey(value);
    let row = db.prepare(`
      SELECT kt.canonical_tag
      FROM knowledge_tag_aliases kta
      JOIN knowledge_tags kt ON kt.id = kta.tag_id
      WHERE kta.subject = ? AND kta.alias_key = ?
    `).get(subject, key);
    if (!row) {
      const id = randomTagId(subject, key);
      db.prepare(`
        INSERT OR IGNORE INTO knowledge_tags (id, subject, canonical_tag, normalized_key, aliases_json, created_at)
        VALUES (?, ?, ?, ?, '[]', ?)
      `).run(id, subject, value, key, nowIso());
      const stored = db.prepare("SELECT id, canonical_tag FROM knowledge_tags WHERE subject = ? AND normalized_key = ?").get(subject, key);
      db.prepare(`
        INSERT OR IGNORE INTO knowledge_tag_aliases (subject, alias_key, tag_id, alias_text)
        VALUES (?, ?, ?, ?)
      `).run(subject, key, stored.id, value);
      row = stored;
    }
    if (!result.includes(row.canonical_tag)) result.push(row.canonical_tag);
  }
  return result;
}

function randomTagId(subject, key) {
  return `tag-${Buffer.from(`${subject}:${key}`).toString("base64url").slice(0, 32)}`;
}

const createdAt = nowIso();
db.prepare(`
  INSERT OR IGNORE INTO exam_papers (
    id, year, region, subject, title, source_name, source_url, license_note, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "paper-gaokao-math-sample-2024",
  2024,
  "全国",
  "数学",
  "高考数学真题样例库",
  "Studyoo 内置样例",
  null,
  "样例题用于开发验证；正式题库需记录题目来源和使用边界。",
  "published",
  createdAt
);

const seedQuestions = [
  {
    id: "exam-math-sequence-001",
    number: "1",
    type: "解答题",
    title: "数列递推通项",
    content: "已知数列 $\\{a_n\\}$ 满足 $a_1=1$，$a_{n+1}=2a_n+1$，求数列 $\\{a_n\\}$ 的通项公式。",
    answer: "令 $b_n=a_n+1$，则 $b_{n+1}=a_{n+1}+1=2a_n+2=2(a_n+1)=2b_n$。又 $b_1=2$，所以 $b_n=2^n$，故 $a_n=2^n-1$。",
    tags: ["数列", "递推关系", "构造法"],
    difficulty: "medium"
  },
  {
    id: "exam-math-trig-001",
    number: "2",
    type: "填空题",
    title: "三角恒等变形",
    content: "已知 $\\sin x+\\cos x=\\frac{1}{2}$，求 $\\sin x\\cos x$。",
    answer: "两边平方得 $(\\sin x+\\cos x)^2=\\frac{1}{4}$，即 $1+2\\sin x\\cos x=\\frac{1}{4}$，所以 $\\sin x\\cos x=-\\frac{3}{8}$。",
    tags: ["三角函数", "恒等变形"],
    difficulty: "easy"
  },
  {
    id: "exam-math-function-001",
    number: "3",
    type: "解答题",
    title: "函数化简与定义域",
    content: "求函数 $f(x)=\\frac{x^2-1}{x-1}$ 在 $x\\ne 1$ 时的化简结果，并说明为什么 $x=1$ 不能直接代入。",
    answer: "$x^2-1=(x-1)(x+1)$，当 $x\\ne 1$ 时，$f(x)=x+1$。但原式分母为 $x-1$，当 $x=1$ 时分母为 0，原函数无定义，所以不能直接代入。",
    tags: ["函数", "因式分解", "定义域"],
    difficulty: "easy"
  }
];

for (const item of seedQuestions) {
  db.prepare(`
    INSERT OR IGNORE INTO exam_questions (
      id, paper_id, question_number, subject, question_type, content_text,
      official_answer_text, source, knowledge_tags_json, difficulty, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    "paper-gaokao-math-sample-2024",
    item.number,
    "数学",
    item.type,
    item.content,
    item.answer,
    "Studyoo 内置样例",
    JSON.stringify(item.tags),
    item.difficulty,
    "needs_profile",
    createdAt
  );

  db.prepare(`
    INSERT OR IGNORE INTO practice_questions (
      id, subject, title, source, content_text, official_answer_text,
      knowledge_tags_json, difficulty, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `practice-${item.id}`,
    "数学",
    item.title,
    "真题样例",
    item.content,
    item.answer,
    JSON.stringify(item.tags),
    item.difficulty,
    createdAt
  );
}

db.prepare(`
  INSERT OR IGNORE INTO exam_papers (
    id, year, region, subject, title, source_name, source_url, license_note,
    status, created_at, owner_user_id, pdf_url, cover_image_url, import_kind
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, NULL, ?, ?, 'pdf')
`).run(
  nationalOne2026.paper.id,
  nationalOne2026.paper.year,
  nationalOne2026.paper.region,
  nationalOne2026.paper.subject,
  nationalOne2026.paper.title,
  nationalOne2026.paper.sourceName,
  nationalOne2026.paper.sourceUrl,
  nationalOne2026.paper.licenseNote,
  createdAt,
  nationalOne2026.paper.sourceUrl,
  nationalOne2026.paper.coverImageUrl
);

for (const item of nationalOne2026.questions) {
  const questionId = `exam-2026-national-1-${item.number.padStart(2, "0")}`;
  const imageUrl = `/uploads/2026-national-1-page-${item.page}.png`;
  const answer = item.answer || "原 PDF 未附参考答案。提交作答后，AI 将独立推导并给出评阅意见。";
  db.prepare(`
    INSERT OR IGNORE INTO exam_questions (
      id, paper_id, question_number, subject, question_type, content_text,
      official_answer_text, source, knowledge_tags_json, difficulty, status,
      created_at, content_image_url, page_number
    ) VALUES (?, ?, ?, '数学', ?, ?, ?, ?, ?, ?, 'needs_profile', ?, ?, ?)
  `).run(
    questionId,
    nationalOne2026.paper.id,
    item.number,
    item.type,
    item.content,
    answer,
    nationalOne2026.paper.sourceName,
    JSON.stringify(item.tags),
    item.difficulty,
    createdAt,
    imageUrl,
    item.page
  );
  db.prepare(`
    INSERT OR IGNORE INTO practice_questions (
      id, subject, title, source, content_text, official_answer_text,
      knowledge_tags_json, difficulty, created_at, content_image_url, exam_question_id
    ) VALUES (?, '数学', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `practice-${questionId}`,
    `${nationalOne2026.paper.title} · 第 ${item.number} 题`,
    nationalOne2026.paper.sourceName,
    item.content,
    answer,
    JSON.stringify(item.tags),
    item.difficulty,
    createdAt,
    imageUrl,
    questionId
  );
}

const nationalCollectionId = "collection-2026-national-1";
db.prepare(`
  INSERT OR IGNORE INTO question_collections (
    id, user_id, title, description, subject, creation_mode, cover_style, source_paper_id, created_at
  ) VALUES (?, NULL, ?, ?, '数学', 'pdf', 'clay', ?, ?)
`).run(
  nationalCollectionId,
  nationalOne2026.paper.title,
  "19 道题 · 单选、多选、填空与解答题 · 原卷 PDF 完整保留",
  nationalOne2026.paper.id,
  createdAt
);

for (const item of nationalOne2026.questions) {
  const questionId = `exam-2026-national-1-${item.number.padStart(2, "0")}`;
  db.prepare(`
    INSERT OR IGNORE INTO collection_questions (collection_id, exam_question_id, position)
    VALUES (?, ?, ?)
  `).run(nationalCollectionId, questionId, Number(item.number));
}

const subjectSlugs = {
  "数学": "math", "物理": "physics", "化学": "chemistry", "历史": "history",
  "地理": "geography", "政治": "politics", "语文": "chinese", "英语": "english"
};
for (const group of multiSubjectSeed) {
  const slug = subjectSlugs[group.subject];
  const paperId = `paper-studyoo-${slug}-foundation`;
  const collectionId = `collection-studyoo-${slug}-foundation`;
  db.prepare(`
    INSERT OR IGNORE INTO exam_papers (
      id, year, region, subject, title, source_name, source_url, license_note, status, created_at, import_kind
    ) VALUES (?, 2026, '全国', ?, ?, 'Studyoo 原创种子库', NULL, '原创练习题，用于产品功能验证与基础训练。', 'published', ?, 'seed')
  `).run(paperId, group.subject, `${group.subject}基础精选`, createdAt);
  db.prepare(`
    INSERT OR IGNORE INTO question_collections (
      id, user_id, title, description, subject, creation_mode, cover_style, source_paper_id, created_at
    ) VALUES (?, NULL, ?, '2 道原创基础题 · 用于跨学科学习链路验证', ?, 'seed', ?, ?, ?)
  `).run(collectionId, `${group.subject}基础精选`, group.subject, ["mint", "blue", "clay", "ink"][multiSubjectSeed.indexOf(group) % 4], paperId, createdAt);

  group.questions.forEach(([title, content, answer, tags, difficulty], index) => {
    const questionId = `exam-studyoo-${slug}-${String(index + 1).padStart(2, "0")}`;
    const normalizedTags = normalizeKnowledgeTags(group.subject, tags);
    db.prepare(`
      INSERT OR IGNORE INTO exam_questions (
        id, paper_id, question_number, subject, question_type, content_text, official_answer_text,
        source, knowledge_tags_json, difficulty, status, created_at
      ) VALUES (?, ?, ?, ?, '解答题', ?, ?, 'Studyoo 原创种子库', ?, ?, 'profiled', ?)
    `).run(questionId, paperId, String(index + 1), group.subject, content, answer, JSON.stringify(normalizedTags), difficulty, createdAt);
    db.prepare(`
      INSERT OR IGNORE INTO practice_questions (
        id, subject, title, source, content_text, official_answer_text, knowledge_tags_json,
        difficulty, created_at, exam_question_id
      ) VALUES (?, ?, ?, 'Studyoo 原创种子库', ?, ?, ?, ?, ?, ?)
    `).run(`practice-${questionId}`, group.subject, title, content, answer, JSON.stringify(normalizedTags), difficulty, createdAt, questionId);
    db.prepare(`
      INSERT OR IGNORE INTO collection_questions (collection_id, exam_question_id, position)
      VALUES (?, ?, ?)
    `).run(collectionId, questionId, index + 1);
  });
}

const nationalOneQuestionId = "exam-2026-national-1-01";
const nationalOnePracticeId = `practice-${nationalOneQuestionId}`;
const nationalOneAnswer = nationalOne2026.questions[0].answer;
db.prepare("UPDATE exam_questions SET official_answer_text = ? WHERE id = ?")
  .run(nationalOneAnswer, nationalOneQuestionId);
db.prepare("UPDATE practice_questions SET official_answer_text = ? WHERE id = ?")
  .run(nationalOneAnswer, nationalOnePracticeId);
db.prepare(`
  UPDATE practice_attempts
  SET is_correct = 0,
      score = 75,
      feedback_text = ?,
      step_breakdown_json = ?,
      next_action = ?
  WHERE practice_question_id = ? AND answer_text LIKE ?
`).run(
  "你选择的 B 是正确选项。排序也正确，但最终把中位数写成了 2；本题有 5 个数据，应取中间第 3 个数 6。请让最后的文字结论与所选选项保持一致。",
  JSON.stringify([
    { step_number: 1, explanation: "排序 $4,5,6,8,12$ 是正确的。" },
    { step_number: 2, explanation: "共有 5 个数据，应取中间第 3 个数，而不是取两个数的平均值。" },
    { step_number: 3, explanation: "第 3 个数是 $6$，所以选项 B 正确；请把答案文字改为 $6$。" }
  ]),
  "复核“数据个数”和“中间位置”的关系，再写出与选项一致的最终结论。",
  nationalOnePracticeId,
  "%中间的是 2%"
);

function backfillNormalizedTags() {
  const targets = [
    ["questions", "id", "subject", "knowledge_tags_json"],
    ["practice_questions", "id", "subject", "knowledge_tags_json"],
    ["exam_questions", "id", "subject", "knowledge_tags_json"]
  ];
  for (const [table, idColumn, subjectColumn, tagsColumn] of targets) {
    const rows = db.prepare(`SELECT ${idColumn} AS id, ${subjectColumn} AS subject, ${tagsColumn} AS tags FROM ${table}`).all();
    const update = db.prepare(`UPDATE ${table} SET ${tagsColumn} = ? WHERE ${idColumn} = ?`);
    for (const row of rows) {
      update.run(JSON.stringify(normalizeKnowledgeTags(row.subject, parseJson(row.tags, []))), row.id);
    }
  }

  const profiles = db.prepare(`
    SELECT p.id, p.knowledge_tags_json AS tags, q.subject
    FROM ai_question_profiles p
    JOIN exam_questions q ON q.id = p.exam_question_id
  `).all();
  const updateProfile = db.prepare("UPDATE ai_question_profiles SET knowledge_tags_json = ? WHERE id = ?");
  for (const row of profiles) {
    updateProfile.run(JSON.stringify(normalizeKnowledgeTags(row.subject, parseJson(row.tags, []))), row.id);
  }

  const mistakes = db.prepare(`
    SELECT m.id, m.knowledge_tags_json AS tags, q.subject
    FROM mistake_records m
    JOIN questions q ON q.id = m.question_id
  `).all();
  const updateMistake = db.prepare("UPDATE mistake_records SET knowledge_tags_json = ? WHERE id = ?");
  for (const row of mistakes) {
    updateMistake.run(JSON.stringify(normalizeKnowledgeTags(row.subject, parseJson(row.tags, []))), row.id);
  }
}

backfillNormalizedTags();

// 用户导入的练习题继承其真题所属试卷的归属；种子题（试卷无归属）保持公共。
db.exec(`
  UPDATE practice_questions SET owner_user_id = (
    SELECT p.owner_user_id
    FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    WHERE q.id = COALESCE(practice_questions.exam_question_id, REPLACE(practice_questions.id, 'practice-', ''))
  )
  WHERE owner_user_id IS NULL
`);

export function nowIso() {
  return new Date().toISOString();
}

// 本地时区的 YYYY-MM-DD。配额重置、复习调度一律使用本地日期，避免 UTC 造成 8 小时错位。
export function todayLocal(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toUser(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    grade: row.grade,
    subjects: parseJson(row.subjects_json, []),
    contact: row.contact || null,
    exam_track: row.exam_track || null,
    electives: parseJson(row.electives_json, []),
    target_score: row.target_score === null || row.target_score === undefined ? null : Number(row.target_score),
    current_score_band: row.current_score_band || null,
    learning_context: row.learning_context || null,
    onboarding_completed: Boolean(row.onboarding_completed),
    is_admin: Boolean(row.is_admin),
    created_at: row.created_at
  };
}

// 埋点写入。失败绝不影响主流程——埋点是观测手段，不是业务。
export function recordEvent(userId, eventName, payload = {}) {
  try {
    db.prepare(`
      INSERT INTO events (id, user_id, event_name, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), userId || null, eventName, JSON.stringify(payload), nowIso());
  } catch (error) {
    console.error("[events] 埋点写入失败：", error.message);
  }
}

export function toQuestion(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    subject: row.subject,
    mode: row.mode,
    content_text: row.content_text,
    content_image_url: row.content_image_url,
    official_answer_text: row.official_answer_text,
    official_answer_image_url: row.official_answer_image_url,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    status: row.status,
    created_at: row.created_at
  };
}

export function toAnswer(row) {
  if (!row) return null;
  return {
    id: row.id,
    question_id: row.question_id,
    hint_text: row.hint_text,
    step_breakdown: parseJson(row.step_breakdown_json, []),
    full_solution_text: row.full_solution_text,
    revealed_full_solution: Boolean(row.revealed_full_solution),
    created_at: row.created_at
  };
}

export function toPracticeQuestion(row, { includeAnswer = false } = {}) {
  const question = {
    id: row.id,
    subject: row.subject,
    title: row.title,
    source: row.source,
    content_text: row.content_text,
    content_image_url: row.content_image_url || null,
    has_figure: Boolean(row.has_figure),
    is_shared: Boolean(row.is_shared),
    exam_question_id: row.exam_question_id || null,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    difficulty: row.difficulty,
    created_at: row.created_at
  };
  if (includeAnswer) question.official_answer_text = row.official_answer_text;
  return question;
}

export function toPracticeAttempt(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    practice_question_id: row.practice_question_id,
    answer_text: row.answer_text,
    is_correct: Boolean(row.is_correct),
    score: row.score,
    feedback_text: row.feedback_text,
    step_breakdown: parseJson(row.step_breakdown_json, []),
    next_action: row.next_action,
    from_cache: Boolean(row.from_cache),
    attempt_round: Number(row.attempt_round || 1),
    is_redo: Boolean(row.is_redo),
    parent_attempt_id: row.parent_attempt_id || null,
    progress_note: row.progress_note || null,
    created_at: row.created_at
  };
}

export function toPracticeCorrection(row) {
  if (!row) return null;
  return {
    practice_question_id: row.practice_question_id,
    correction_status: row.correction_status,
    note: row.note || null,
    redo_count: Number(row.redo_count || 0),
    redo_available_at: row.redo_available_at || null,
    updated_at: row.updated_at
  };
}

export function toExamPaper(row) {
  return {
    id: row.id,
    year: row.year,
    region: row.region,
    subject: row.subject,
    title: row.title,
    source_name: row.source_name,
    source_url: row.source_url,
    license_note: row.license_note,
    status: row.status,
    owner_user_id: row.owner_user_id || null,
    pdf_url: row.pdf_url || null,
    cover_image_url: row.cover_image_url || null,
    import_kind: row.import_kind || "manual",
    created_at: row.created_at
  };
}

export function toExamQuestion(row, { includeAnswer = false } = {}) {
  const question = {
    id: row.id,
    paper_id: row.paper_id,
    question_number: row.question_number,
    subject: row.subject,
    question_type: row.question_type,
    content_text: row.content_text,
    content_image_url: row.content_image_url || null,
    page_number: row.page_number || null,
    source: row.source,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    difficulty: row.difficulty,
    status: row.status,
    created_at: row.created_at
  };
  if (includeAnswer) question.official_answer_text = row.official_answer_text;
  return question;
}

export function toQuestionCollection(row) {
  return {
    id: row.id,
    user_id: row.user_id || null,
    title: row.title,
    description: row.description,
    subject: row.subject,
    creation_mode: row.creation_mode,
    cover_style: row.cover_style,
    source_paper_id: row.source_paper_id || null,
    question_count: Number(row.question_count || 0),
    is_completed: Boolean(row.is_completed),
    is_shared: Boolean(row.is_shared),
    is_owner: row.is_owner === undefined ? undefined : Boolean(row.is_owner),
    created_at: row.created_at
  };
}

export function toIngestionJob(row) {
  return {
    id: row.id,
    source_name: row.source_name,
    source_url: row.source_url,
    status: row.status,
    message: row.message,
    imported_count: row.imported_count,
    created_at: row.created_at
  };
}

export function toQuestionProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    exam_question_id: row.exam_question_id,
    knowledge_tags: parseJson(row.knowledge_tags_json, []),
    difficulty: row.difficulty,
    core_idea: row.core_idea,
    common_mistakes: parseJson(row.common_mistakes_json, []),
    exam_intent: row.exam_intent,
    prerequisites: parseJson(row.prerequisites_json, []),
    generated_at: row.generated_at
  };
}
