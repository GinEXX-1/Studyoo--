import { readFileSync } from "node:fs";
import { db } from "../src/db.js";

const manifest = JSON.parse(readFileSync(new URL("../samples/import-quality/manifest.json", import.meta.url), "utf8"));
const requestedTaskId = process.argv[2];
let failed = false;

for (const sample of manifest.samples) {
  const sourceNames = Array.isArray(sample.source_names) ? sample.source_names : [sample.source_name];
  const sourcePlaceholders = sourceNames.map(() => "?").join(",");
  const task = requestedTaskId
    ? db.prepare("SELECT * FROM import_tasks WHERE id = ?").get(requestedTaskId)
    : db.prepare(`
        SELECT t.*, (SELECT COUNT(*) FROM question_candidates c WHERE c.task_id = t.id) AS candidate_count
        FROM import_tasks t
        WHERE t.source_name IN (${sourcePlaceholders})
        ORDER BY candidate_count DESC, t.created_at DESC
        LIMIT 1
      `).get(...sourceNames);
  if (!task) {
    console.log(`${sample.id}: 尚无匹配的导入任务，导入样本后重新运行。`);
    continue;
  }

  const rows = db.prepare("SELECT question_number FROM question_candidates WHERE task_id = ? AND review_status != 'rejected'").all(task.id);
  const numbers = rows.map((row) => Number(row.question_number)).filter(Number.isInteger);
  const expected = new Set(sample.expected_question_numbers);
  const recognized = new Set(numbers.filter((number) => expected.has(number)));
  const missing = sample.expected_question_numbers.filter((number) => !recognized.has(number));
  const duplicateCount = numbers.length - new Set(numbers).size;
  const coverage = recognized.size / expected.size;
  const duplicateRate = numbers.length ? duplicateCount / numbers.length : 0;
  const passed = task.total_pages === sample.expected_pages
    && coverage >= sample.minimum_coverage
    && duplicateRate <= sample.maximum_duplicate_rate;
  failed ||= !passed;

  console.log(JSON.stringify({
    sample: sample.id,
    task_id: task.id,
    passed,
    pages: { actual: task.total_pages, expected: sample.expected_pages },
    questions: { recognized: recognized.size, expected: expected.size, coverage: Number(coverage.toFixed(3)) },
    missing_question_numbers: missing,
    duplicate_count: duplicateCount
  }, null, 2));
}

if (failed) process.exitCode = 1;
