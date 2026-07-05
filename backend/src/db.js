import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

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

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  used_on TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, used_on),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

export function nowIso() {
  return new Date().toISOString();
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
    created_at: row.created_at
  };
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
