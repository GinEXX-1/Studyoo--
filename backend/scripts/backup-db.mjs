// 手动触发一次数据库备份：npm run backup:db
// 生产（Railway）：railway run npm run backup:db --workspace backend
import { runBackup } from "../src/backup.js";

runBackup();
