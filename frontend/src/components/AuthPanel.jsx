import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { toast } from "sonner";

const grades = ["高一", "高二", "高三"];
const electiveOptions = ["化学", "生物", "政治", "地理"];
const scoreBands = ["600以上", "500-599", "400-499", "400以下", "暂不清楚"];

export default function AuthPanel({ onSignedIn }) {
  const [mode, setMode] = useState("login");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [grade, setGrade] = useState("高一");
  const [inviteCode, setInviteCode] = useState("");
  const [contact, setContact] = useState("");
  const [examTrack, setExamTrack] = useState("物理");
  const [electives, setElectives] = useState(["化学", "生物"]);
  const [targetScore, setTargetScore] = useState(600);
  const [currentScoreBand, setCurrentScoreBand] = useState("500-599");
  const [learningContext, setLearningContext] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (mode === "register" && electives.length !== 2) {
      toast.error("请从化学、生物、政治、地理中选择两科");
      return;
    }
    setLoading(true);
    try {
      const data = await apiRequest(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify({
          nickname,
          password,
          grade,
          invite_code: inviteCode,
          contact,
          exam_track: examTrack,
          electives,
          target_score: Number(targetScore),
          current_score_band: currentScoreBand,
          learning_context: learningContext
        })
      });
      toast.success(mode === "login" ? "登录成功" : "注册成功");
      onSignedIn(data.user);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleElective(subject) {
    setElectives((items) => {
      if (items.includes(subject)) return items.filter((item) => item !== subject);
      if (items.length >= 2) return [items[1], subject];
      return [...items, subject];
    });
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
      <section className={`auth-card ${mode === "register" ? "auth-register-card" : ""}`}>
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
              <fieldset className="onboarding-fieldset"><legend>首选科目</legend><div className="subject-toggles compact">{["物理", "历史"].map((subject) => <button type="button" key={subject} className={examTrack === subject ? "active" : ""} onClick={() => setExamTrack(subject)}>{subject}</button>)}</div></fieldset>
              <fieldset className="onboarding-fieldset"><legend>再选两科 <span>{electives.length}/2</span></legend><div className="subject-toggles compact">{electiveOptions.map((subject) => <button type="button" key={subject} className={electives.includes(subject) ? "active" : ""} onClick={() => toggleElective(subject)}>{subject}</button>)}</div></fieldset>
              <div className="onboarding-score-grid"><label>目前分数段<select value={currentScoreBand} onChange={(event) => setCurrentScoreBand(event.target.value)}>{scoreBands.map((item) => <option key={item}>{item}</option>)}</select></label><label>目标总分<input type="number" min="0" max="750" value={targetScore} onChange={(event) => setTargetScore(event.target.value)} /></label></div>
              <label>目前最困扰你的学习问题（选填）<textarea rows="3" value={learningContext} onChange={(event) => setLearningContext(event.target.value)} placeholder="例：数学选择题耗时长，物理大题经常不知道从哪里开始" /></label>
              <label>邀请码<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="内测邀请码（未开启可留空）" /></label>
              <label>联系方式（选填）<input value={contact} onChange={(event) => setContact(event.target.value)} placeholder="微信 / QQ / 手机号，忘记密码时用于找回" /></label>
            </>
          )}
          <button className="primary" disabled={loading}>{loading ? "处理中..." : mode === "login" ? "进入 Studyoo" : "创建账号"}</button>
          {mode === "login" && <p className="auth-forgot-hint">忘记密码？联系发你邀请码的管理员，人工核验后重置。</p>}
        </form>
      </section>
    </main>
  );
}
