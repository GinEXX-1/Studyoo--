import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { toast } from "sonner";
import MountainMark from "./MountainMark.jsx";

const grades = ["高一", "高二", "高三"];

export default function AuthPanel({ onSignedIn }) {
  const [mode, setMode] = useState("login");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [grade, setGrade] = useState("高一");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = await apiRequest(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify({ nickname, password, grade })
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
        <p className="auth-brand-label">STUDYOO · 学有</p>
        <div className="seal">有</div>
        <div className="auth-brand-copy">
          <h1>真正的学习，<br />不是获得更多答案，<br />而是建立更深的理解。</h1>
          <p>先独立作答，再让 AI 评阅、订正、复盘。每一次练习，都沉淀成属于你的能力地图。</p>
        </div>
        <MountainMark dark />
      </section>
      <section className="auth-card">
        <p className="eyebrow">{mode === "login" ? "欢迎回来" : "创建账号"}</p>
        <h1>让每一套题，都成为你的能力地图</h1>
        <form onSubmit={submit} className="stack">
          <div className="segmented">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>
            <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button>
          </div>
          <label>昵称<input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="请输入昵称" /></label>
          <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /></label>
          {mode === "register" && (
            <label>年级<select value={grade} onChange={(event) => setGrade(event.target.value)}>{grades.map((item) => <option key={item}>{item}</option>)}</select></label>
          )}
          <button className="primary" disabled={loading}>{loading ? "处理中..." : mode === "login" ? "进入 Studyoo" : "创建账号"}</button>
        </form>
      </section>
    </main>
  );
}
