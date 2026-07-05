import { useEffect, useState } from "react";
import { apiRequest, getToken, setToken } from "./lib/api.js";
import { MathText } from "./components/MathText.jsx";
import "./styles.css";

const grades = ["高一", "高二", "高三"];

function AuthPanel({ onSignedIn }) {
  const [mode, setMode] = useState("login");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [grade, setGrade] = useState("高一");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await apiRequest(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify({ nickname, password, grade })
      });
      setToken(data.token);
      onSignedIn(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">Studyoo</p>
        <h1>把模糊的答案讲清楚</h1>
        <form onSubmit={submit} className="stack">
          <div className="segmented">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
              登录
            </button>
            <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
              注册
            </button>
          </div>
          <label>
            昵称
            <input value={nickname} onChange={(event) => setNickname(event.target.value)} />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {mode === "register" && (
            <label>
              年级
              <select value={grade} onChange={(event) => setGrade(event.target.value)}>
                {grades.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={loading}>
            {loading ? "处理中..." : mode === "login" ? "进入 Studyoo" : "创建账号"}
          </button>
        </form>
      </section>
    </main>
  );
}

function QuestionForm({ onAnswer }) {
  const [mode, setMode] = useState("deepen_official_answer");
  const [subject, setSubject] = useState("数学");
  const [contentText, setContentText] = useState("");
  const [officialAnswerText, setOfficialAnswerText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await apiRequest("/questions", {
        method: "POST",
        body: JSON.stringify({
          subject,
          mode,
          content_text: contentText,
          official_answer_text: mode === "deepen_official_answer" ? officialAnswerText : undefined
        })
      });
      onAnswer(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="question-panel">
      <form onSubmit={submit} className="stack">
        <div className="top-row">
          <label>
            学科
            <select value={subject} onChange={(event) => setSubject(event.target.value)}>
              <option>数学</option>
              <option>物理</option>
              <option>化学</option>
            </select>
          </label>
          <div className="segmented wide">
            <button type="button" className={mode === "solve_from_scratch" ? "active" : ""} onClick={() => setMode("solve_from_scratch")}>
              从零开始问
            </button>
            <button type="button" className={mode === "deepen_official_answer" ? "active" : ""} onClick={() => setMode("deepen_official_answer")}>
              深化官方答案
            </button>
          </div>
        </div>
        <label>
          题目
          <textarea value={contentText} onChange={(event) => setContentText(event.target.value)} rows={7} />
        </label>
        {mode === "deepen_official_answer" && (
          <label>
            官方答案
            <textarea value={officialAnswerText} onChange={(event) => setOfficialAnswerText(event.target.value)} rows={5} />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={loading}>
          {loading ? "解析中..." : "提交解析"}
        </button>
      </form>
    </section>
  );
}

function AnswerPanel({ result, onAnswerUpdated }) {
  const [followText, setFollowText] = useState("");
  const [followUps, setFollowUps] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");

  if (!result) return null;
  const { question, answer } = result;

  async function reveal() {
    setError("");
    setLoading("reveal");
    try {
      const nextAnswer = await apiRequest(`/questions/${question.id}/reveal-solution`, { method: "POST" });
      onAnswerUpdated({ question, answer: nextAnswer });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function followUp(event) {
    event.preventDefault();
    setError("");
    setLoading("follow");
    try {
      const data = await apiRequest(`/questions/${question.id}/follow-up`, {
        method: "POST",
        body: JSON.stringify({ content_text: followText })
      });
      setFollowUps((items) => [...items, { question: followText, reply: data.reply_text }]);
      setFollowText("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  return (
    <section className="answer-panel">
      <div className="answer-heading">
        <p className="eyebrow">{question.subject}</p>
        <h2>{question.mode === "deepen_official_answer" ? "官方答案拆解" : "先看思路"}</h2>
      </div>
      {answer.hint_text && (
        <article className="content-block">
          <MathText text={answer.hint_text} />
        </article>
      )}
      {answer.step_breakdown?.length > 0 && (
        <div className="steps">
          {answer.step_breakdown.map((step) => (
            <article className="step" key={step.step_number}>
              <span>{step.step_number}</span>
              <MathText text={step.explanation} />
            </article>
          ))}
        </div>
      )}
      {answer.full_solution_text ? (
        <article className="content-block solution">
          <MathText text={answer.full_solution_text} />
        </article>
      ) : (
        <button className="secondary" onClick={reveal} disabled={loading === "reveal"}>
          {loading === "reveal" ? "加载完整答案..." : "看完整答案"}
        </button>
      )}
      <form onSubmit={followUp} className="follow-form">
        <input value={followText} onChange={(event) => setFollowText(event.target.value)} placeholder="继续追问这一步..." />
        <button disabled={loading === "follow"}>追问</button>
      </form>
      {followUps.map((item, index) => (
        <article className="follow-item" key={index}>
          <strong>{item.question}</strong>
          <MathText text={item.reply} />
        </article>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function SidePanel() {
  const [mistakes, setMistakes] = useState([]);
  const [stats, setStats] = useState([]);
  const [pathItems, setPathItems] = useState([]);

  useEffect(() => {
    if (!getToken()) return;
    Promise.all([
      apiRequest("/mistakes").then((data) => setMistakes(data.items)).catch(() => setMistakes([])),
      apiRequest("/mistakes/stats").then((data) => setStats(data.tags)).catch(() => setStats([])),
      apiRequest("/learning-path").then((data) => setPathItems(data.items)).catch(() => setPathItems([]))
    ]);
  }, []);

  return (
    <aside className="side-panel">
      <section>
        <h3>错题</h3>
        <p>{mistakes.length ? `${mistakes.length} 条记录` : "暂无记录"}</p>
      </section>
      <section>
        <h3>薄弱点</h3>
        {stats.length ? stats.map((item) => <p key={item.knowledge_tag}>{item.knowledge_tag}: {item.error_rate}</p>) : <p>暂无统计</p>}
      </section>
      <section>
        <h3>学习路径</h3>
        {pathItems.length ? pathItems.map((item) => <p key={item.id}>{item.knowledge_tag}</p>) : <p>暂无推荐</p>}
      </section>
    </aside>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!getToken()) return;
    apiRequest("/users/me").then(setUser).catch(() => setToken(""));
  }, []);

  if (!user) {
    return <AuthPanel onSignedIn={setUser} />;
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Studyoo</p>
          <h1>遇到不会的题，来问问看</h1>
        </div>
        <button className="ghost" onClick={() => { setToken(""); setUser(null); }}>
          退出
        </button>
      </header>
      <div className="workspace">
        <div className="main-column">
          <QuestionForm onAnswer={setResult} />
          <AnswerPanel result={result} onAnswerUpdated={setResult} />
        </div>
        <SidePanel />
      </div>
    </main>
  );
}
