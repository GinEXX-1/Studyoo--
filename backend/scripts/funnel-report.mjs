// 漏斗报表：注册 → 导入 → 开做 → 提交 → 订正 → 重做通过 → 回访
// 用法：npm run report:funnel --workspace backend  （可选 DAYS=14 环境变量控制窗口）
import { db } from "../src/db.js";

const days = Number(process.env.DAYS || 14);
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const FUNNEL = [
  ["register", "注册"],
  ["import_started", "导入开始"],
  ["import_succeeded", "导入成功"],
  ["practice_opened", "开始做题"],
  ["attempt_submitted", "提交作答"],
  ["correction_marked", "标记订正"],
  ["redo_submitted", "提交重做"],
  ["redo_passed", "重做通过"],
  ["login", "回访登录"]
];

console.log(`\n=== Studyoo 漏斗报表（最近 ${days} 天）===\n`);
console.log("事件".padEnd(12), "触达用户数".padEnd(10), "事件总数");
for (const [name, label] of FUNNEL) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS total
    FROM events WHERE event_name = ? AND created_at >= ?
  `).get(name, since);
  console.log(label.padEnd(12), String(row.users).padEnd(12), String(row.total));
}

// 次日回访：注册次日有任意事件的用户比例
const retention = db.prepare(`
  SELECT COUNT(*) AS registered,
    SUM(CASE WHEN EXISTS (
      SELECT 1 FROM events e2
      WHERE e2.user_id = e1.user_id
        AND date(e2.created_at) > date(e1.created_at)
    ) THEN 1 ELSE 0 END) AS returned
  FROM events e1
  WHERE e1.event_name = 'register' AND e1.created_at >= ?
`).get(since);
const rate = retention.registered ? Math.round(retention.returned / retention.registered * 100) : 0;
console.log(`\n注册用户 ${retention.registered} 人，其中 ${retention.returned} 人在注册后另一天回来过（${rate}%）。\n`);
