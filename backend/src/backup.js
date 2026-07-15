// ——— 数据库备份 ———
// 用 SQLite 的 VACUUM INTO 做在线备份（不锁写、输出紧凑），按日期命名，保留最近 N 份。
// 配置了 BACKUP_S3_*（S3 兼容对象存储，如 Cloudflare R2）时，备份同时推送异地——
// 本地备份防应用层误删，异地备份防卷级故障；两者缺一不可。
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { db, todayLocal } from "./db.js";
import { config } from "./config.js";

const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 14);

export function offsiteBackupConfigured() {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config.backupS3;
  return Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
}

// 手写 AWS Signature V4 的 PUT Object：只用到一个请求，不值得为此引入 SDK 依赖。
export async function pushBackupOffsite(filePath) {
  if (!offsiteBackupConfigured()) return false;
  const { endpoint, bucket, accessKeyId, secretAccessKey, region } = config.backupS3;
  const body = readFileSync(filePath);
  const key = `backups/${basename(filePath)}`;
  const url = new URL(`${endpoint.replace(/\/+$/, "")}/${bucket}/${key}`);

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const hmac = (secret, data) => createHmac("sha256", secret).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    },
    body
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`异地备份上传失败：HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  console.log(`[backup] 异地备份已上传：${bucket}/${key}`);
  return true;
}

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
      const target = runBackup();
      // 异地推送失败只记录，不影响本地备份已成功的事实
      pushBackupOffsite(target).catch((error) => console.error("[backup] 异地备份失败：", error.message));
    } catch (error) {
      console.error("[backup] 备份失败：", error.message);
    }
  };
  // 启动 5 分钟后先备一份（覆盖"部署后马上出事"的窗口），之后每 24 小时一次
  setTimeout(run, 5 * 60 * 1000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
