// ——— 数据库备份 ———
// 用 SQLite 的 VACUUM INTO 做在线备份（不锁写、输出紧凑），按日期命名，保留最近 N 份。
// 生产环境（Railway 卷）备份落在数据库同目录的 backups/ 下；远程异地备份见《战略审计与方向 2026-07-13.md》。
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, todayLocal } from "./db.js";
import { config } from "./config.js";

const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 14);

export function runBackup() {
  const backupDir = process.env.BACKUP_DIR || join(dirname(config.databasePath), "backups");
  mkdirSync(backupDir, { recursive: true });

  const timestamp = `${todayLocal()}-${new Date().toTimeString().slice(0, 8).replaceAll(":", "")}`;
  const target = join(backupDir, `studyoo-${timestamp}.db`);
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

  // 轮转：只保留最近 BACKUP_KEEP 份
  const backups = readdirSync(backupDir)
    .filter((name) => name.startsWith("studyoo-") && name.endsWith(".db"))
    .map((name) => ({ name, mtime: statSync(join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(BACKUP_KEEP)) {
    unlinkSync(join(backupDir, old.name));
  }

  const size = statSync(target).size;
  console.log(`[backup] ${target} (${(size / 1024).toFixed(0)} KB), 保留 ${Math.min(backups.length, BACKUP_KEEP)} 份`);
  return target;
}

export function scheduleDailyBackup() {
  const run = () => {
    try {
      runBackup();
    } catch (error) {
      console.error("[backup] 备份失败：", error.message);
    }
  };
  // 启动 5 分钟后先备一份（覆盖"部署后马上出事"的窗口），之后每 24 小时一次
  setTimeout(run, 5 * 60 * 1000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
