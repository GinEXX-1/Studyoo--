import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { toast } from "sonner";

const grades = ["高一", "高二", "高三"];

export default function AuthPanel({ onSignedIn }) {
  const [mode, setMode] = useState("login");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [grade, setGrade] = useState("高一");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = await apiRequest(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify({ nickname, password, grade, invite_code: inviteCode })
      });
      toast.success(mode === "login" ? "登录成功" : "注册成功");
      onSignedIn(data.user);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-brand" aria-label="Studyoo 产品理念">
        <img className="auth-brand-logo" src="/brand/studyoo-black.png" alt="Studyoo" />
        <div className="auth-brand-copy">
          <h1>今天，先把<br />一件事想明白。</h1>
          <p>每一道题，都会变成更清楚的自己。</p>
        </div>
        <div className="auth-learning-scene" aria-label="Studyoo 学习体验预览">
          <div className="auth-scene-card auth-scene-ai"><span>AI 学习助手</span><p>先看清条件，再一步步拆开。</p></div>
          <div className="auth-scene-card auth-scene-course"><small>今日重点</small><strong>函数与导数</strong><span>理解进度 64%</span></div>
          <div className="auth-scene-card auth-scene-path"><small>个性化路径</small><strong>下一站 · 导数应用</strong></div>
        </div>
      </section>
      <section className="auth-card">
        <p className="eyebrow">{mode === "login" ? "欢迎回来" : "开始使用"}</p>
        <h1>{mode === "login" ? "继续今天的学习。" : "建立你的学习路径。"}</h1>
        <p className="auth-card-lede">不追求更多答案，只追求真正想明白。</p>
        <form onSubmit={submit} className="stack">
          <div className="segmented">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>
            <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button>
          </div>
          <label>昵称<input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="请输入昵称" /></label>
          <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /></label>
          {mode === "register" && (
            <>
              <label>年级<select value={grade} onChange={(event) => setGrade(event.target.value)}>{grades.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label>邀请码<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="内测邀请码（未开启可留空）" /></label>
            </>
          )}
          <button className="primary" disabled={loading}>{loading ? "处理中..." : mode === "login" ? "进入 Studyoo" : "创建账号"}</button>
        </form>
      </section>
    </main>
  );
}
