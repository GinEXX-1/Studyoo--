import { db } from "./db.js";
import { fail } from "./http.js";

const SAFE_UPLOAD_NAME = /^[A-Za-z0-9._-]+$/;

export function authorizeUpload(req, res, next) {
  const fileName = req.path.replace(/^\/+/, "");
  if (!fileName || !SAFE_UPLOAD_NAME.test(fileName)) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个文件。");
  }

  const resourceUrl = `/uploads/${fileName}`;
  const userId = req.user.id;
  const accessible = db.prepare(`
    SELECT 1 FROM import_tasks
    WHERE pdf_filename = ? AND user_id = ?
    UNION ALL
    SELECT 1 FROM import_pages p
    JOIN import_tasks t ON t.id = p.task_id
    WHERE p.image_url = ? AND t.user_id = ?
    UNION ALL
    SELECT 1 FROM question_candidates c
    JOIN import_tasks t ON t.id = c.task_id
    WHERE c.crop_image_url = ? AND t.user_id = ?
    UNION ALL
    SELECT 1 FROM questions
    WHERE (content_image_url = ? OR official_answer_image_url = ?) AND user_id = ?
    UNION ALL
    SELECT 1 FROM exam_questions q
    JOIN exam_papers p ON p.id = q.paper_id
    WHERE q.content_image_url = ? AND (p.owner_user_id IS NULL OR p.owner_user_id = ?)
    UNION ALL
    SELECT 1 FROM practice_questions
    WHERE content_image_url = ? AND (owner_user_id IS NULL OR owner_user_id = ?)
    LIMIT 1
  `).get(
    fileName, userId,
    resourceUrl, userId,
    resourceUrl, userId,
    resourceUrl, resourceUrl, userId,
    resourceUrl, userId,
    resourceUrl, userId
  );

  if (!accessible) {
    return fail(res, 404, "RESOURCE_NOT_FOUND", "没有找到这个文件。");
  }
  next();
}
