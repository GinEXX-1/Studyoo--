// 手动触发一次数据库备份：npm run backup:db
// 生产（Railway）：railway run npm run backup:db --workspace backend
// 配置了 BACKUP_S3_* 时会同步推送异地（S3 兼容对象存储）。
import { offsiteBackupConfigured, pushBackupOffsite, runBackup } from "../src/backup.js";

const target = runBackup();
if (offsiteBackupConfigured()) {
  await pushBackupOffsite(target);
} else {
  console.log("[backup] 未配置 BACKUP_S3_*，跳过异地推送（仅本地备份）。");
}
