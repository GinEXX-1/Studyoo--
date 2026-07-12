/**
 * Studyoo v2 数据库迁移
 * 新增：PDF 结构化导入流水线 + 间隔复习调度
 * 幂等，可重复运行。
 */
import { db, nowIso } from "./db.js";

// ——— 按需添加旧表缺失列（幂等）———
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("exam_questions", "source_task_id", "TEXT");
ensureColumn("exam_questions", "confidence", "REAL");
ensureColumn("practice_questions", "source_task_id", "TEXT");

// ——— 新建表 ———
db.exec(`
/* 导入任务（每次 PDF 上传一个任务） */
CREATE TABLE IF NOT EXISTS import_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  source_name TEXT NOT NULL,
  pdf_filename TEXT,
  pdf_data_base64 TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_pages INTEGER DEFAULT 0,
  processed_pages INTEGER DEFAULT 0,
  question_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

/* 导入页面（PDF 每一页） */
CREATE TABLE IF NOT EXISTS import_pages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  image_url TEXT,
  render_status TEXT NOT NULL DEFAULT 'pending',
  ocr_status TEXT NOT NULL DEFAULT 'pending',
  ocr_raw_text TEXT,
  ocr_result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES import_tasks(id),
  UNIQUE(task_id, page_number)
);

/* 题目候选（每页识别出的题目） */
CREATE TABLE IF NOT EXISTS question_candidates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  question_number INTEGER,
  crop_image_url TEXT,
  crop_bbox_json TEXT,
  subject TEXT NOT NULL,
  stem_text TEXT,
  options_json TEXT,
  reference_answer_text TEXT,
  knowledge_tags_json TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  question_type TEXT DEFAULT 'choice',
  recognition_confidence REAL,
  requires_manual_review INTEGER NOT NULL DEFAULT 1,
  review_status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  confirmed_question_id TEXT,
  confirmed_question_type TEXT,
  recognition_attempts INTEGER NOT NULL DEFAULT 0,
  last_recognition_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES import_tasks(id),
  FOREIGN KEY (page_id) REFERENCES import_pages(id)
);

/* 候选裁切图（每题多张裁切图：完整/题干/选项区/答案区） */
CREATE TABLE IF NOT EXISTS candidate_crops (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  crop_type TEXT NOT NULL,
  image_url TEXT NOT NULL,
  bbox_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES question_candidates(id)
);

/* 间隔复习任务 */
CREATE TABLE IF NOT EXISTS review_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  knowledge_tag TEXT NOT NULL,
  subject TEXT NOT NULL,
  source_question_id TEXT,
  source_question_type TEXT,
  review_question_id TEXT,
  review_question_type TEXT,
  scheduled_date TEXT NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 0,
  review_round INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  score REAL,
  mastery_level_before TEXT DEFAULT 'weak',
  mastery_level_after TEXT,
  feedback_text TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_review_tasks_user ON review_tasks(user_id, status, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_import_tasks_user ON import_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_question_candidates_task ON question_candidates(task_id, review_status);
`);

ensureColumn("import_tasks", "title", "TEXT");
ensureColumn("import_tasks", "year", "INTEGER");

// v2.1：PDF 原文不再存数据库（uploads 目录已有原始文件），清空历史遗留的 base64 副本。
db.exec("UPDATE import_tasks SET pdf_data_base64 = NULL WHERE pdf_data_base64 IS NOT NULL");

export function setupV2() {
  console.log("v2 migration: tables verified.");
  return true;
}
