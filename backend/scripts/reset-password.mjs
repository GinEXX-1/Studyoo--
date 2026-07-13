// 管理员重置用户密码（用户忘记密码时的唯一恢复途径）。
// 本地：  npm run admin:reset-password -- <昵称> [新密码]
// 生产：  railway run npm run admin:reset-password --workspace backend -- <昵称>
// 不传新密码时自动生成随机密码并打印。
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "../src/db.js";

const [nickname, providedPassword] = process.argv.slice(2);
if (!nickname) {
  console.error("用法: node scripts/reset-password.mjs <昵称> [新密码]");
  process.exit(1);
}

const user = db.prepare("SELECT id, nickname FROM users WHERE nickname = ?").get(nickname);
if (!user) {
  console.error(`未找到昵称为「${nickname}」的用户。`);
  process.exit(1);
}

const newPassword = providedPassword || randomBytes(6).toString("base64url");
if (newPassword.length < 6) {
  console.error("新密码至少 6 位。");
  process.exit(1);
}

db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), user.id);
console.log(`已重置「${user.nickname}」的密码为: ${newPassword}`);
console.log("请通过安全渠道告知用户，并提醒登录后无需其它操作（旧登录态 7 天内自然过期）。");
