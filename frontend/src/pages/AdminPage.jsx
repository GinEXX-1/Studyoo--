import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import Stat from "../components/Stat.jsx";
import { apiRequest, apiUrl } from "../lib/api.js";

const eventLabels = {
  register: "注册",
  login: "登录",
  app_opened: "打开应用",
  practice_opened: "进入做题",
  attempt_submitted: "提交作答",
  correction_marked: "完成订正",
  redo_submitted: "提交重做",
  redo_passed: "重做通过",
  import_started: "开始导入",
  import_succeeded: "导入成功",
  discovery_imported: "采集题目",
  discovery_rated: "评价题目",
  discovery_saved: "收藏题目"
};

const feedbackStatuses = { open: "待处理", reviewing: "处理中", resolved: "已解决" };
const subjects = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"];
const questionTemplate = JSON.stringify([
  {
    question_number: "1",
    question_type: "单选题",
    content_text: "",
    official_answer_text: "",
    knowledge_tags: [],
    difficulty: "medium"
  }
], null, 2);

export default function AdminPage() {
  const [dashboard, setDashboard] = useState(null);
  const [feedback, setFeedback] = useState([]);
  const [connected, setConnected] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [preview, setPreview] = useState(null);
  const [importTitle, setImportTitle] = useState("");
  const [importSubject, setImportSubject] = useState("数学");
  const [questionsJson, setQuestionsJson] = useState(questionTemplate);
  const [collectorBusy, setCollectorBusy] = useState("");

  async function loadFeedback() {
    const data = await apiRequest("/admin/feedback");
    setFeedback(data.items || []);
  }

  useEffect(() => {
    let source;
    let fallback;
    apiRequest("/admin/dashboard").then(setDashboard).catch((error) => toast.error(error.message));
    loadFeedback().catch((error) => toast.error(error.message));
    try {
      source = new EventSource(apiUrl("/admin/stream"), { withCredentials: true });
      source.addEventListener("dashboard", (event) => {
        setDashboard(JSON.parse(event.data));
        setConnected(true);
      });
      source.onerror = () => {
        setConnected(false);
        source.close();
        fallback = setInterval(() => apiRequest("/admin/dashboard").then(setDashboard).catch(() => {}), 10000);
      };
    } catch {
      fallback = setInterval(() => apiRequest("/admin/dashboard").then(setDashboard).catch(() => {}), 10000);
    }
    return () => {
      source?.close();
      clearInterval(fallback);
    };
  }, []);

  async function updateFeedback(item, status) {
    try {
      await apiRequest(`/admin/feedback/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, admin_note: item.admin_note || "" })
      });
      await loadFeedback();
      toast.success("反馈状态已更新");
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function fetchPreview(event) {
    event.preventDefault();
    setCollectorBusy("fetch");
    try {
      const data = await apiRequest("/admin/discovery/fetch-preview", {
        method: "POST",
        body: JSON.stringify({ url: sourceUrl })
      });
      setPreview(data);
      setImportTitle((current) => current || data.title || "");
      toast.success("网页正文已抓取");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCollectorBusy("");
    }
  }

  async function importQuestions(event) {
    event.preventDefault();
    let questions;
    try {
      questions = JSON.parse(questionsJson);
    } catch {
      toast.error("题目 JSON 格式不正确");
      return;
    }
    if (!Array.isArray(questions) || !questions.length) {
      toast.error("至少需要一条题目数据");
      return;
    }
    setCollectorBusy("import");
    try {
      const data = await apiRequest("/admin/discovery/import", {
        method: "POST",
        body: JSON.stringify({
          source_url: preview?.url || sourceUrl,
          title: importTitle,
          subject: importSubject,
          questions
        })
      });
      toast.success(`${data.imported_count} 道题已进入新发现`);
      setQuestionsJson(questionTemplate);
      setPreview(null);
      setSourceUrl("");
      setImportTitle("");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCollectorBusy("");
    }
  }

  const maxActivity = useMemo(() => Math.max(1, ...(dashboard?.hourly_activity || []).map((item) => item.events)), [dashboard]);
  const summary = dashboard?.summary || {};

  return (
    <div className="page-stack admin-page">
      <section className="page-heading admin-heading"><div><p className="eyebrow">Live Operations</p><h1>数据台</h1><p>学生行为、内容导入和 AI 成本的实时运行视图。</p></div><span className={`live-indicator ${connected ? "online" : "polling"}`}><i />{connected ? "实时连接" : "定时刷新"}</span></section>
      <section className="admin-stat-grid">
        <Stat value={summary.users || 0} label={`用户 · 今日 +${summary.new_users_today || 0}`} />
        <Stat value={summary.active_users_24h || 0} label="24h 活跃用户" />
        <Stat value={summary.attempts_today || 0} label={`今日作答 · ${summary.correct_rate_today || 0}% 正确`} />
        <Stat value={summary.imports_today || 0} label="今日导入" />
        <Stat value={summary.ai_calls_today || 0} label={`AI 调用 · ${summary.ai_tokens_today || 0} tokens`} />
        <Stat value={summary.open_feedback || 0} label="待处理反馈" />
      </section>
      <section className="admin-grid">
        <div className="admin-panel"><div className="section-heading"><div><p className="eyebrow">Activity</p><h2>24 小时活动</h2></div><span>{dashboard?.generated_at ? new Date(dashboard.generated_at).toLocaleTimeString("zh-CN") : ""}</span></div><div className="activity-chart">{dashboard?.hourly_activity?.length ? dashboard.hourly_activity.map((item) => <div className="activity-column" key={item.hour} title={`${item.hour} · ${item.events} 次事件`}><span style={{ height: `${Math.max(8, item.events / maxActivity * 100)}%` }} /><small>{item.hour.slice(11, 13)}</small></div>) : <p className="empty-copy">过去 24 小时还没有事件。</p>}</div><div className="event-counts">{dashboard?.event_counts?.map((item) => <div key={item.name}><span>{eventLabels[item.name] || item.name}</span><strong>{item.count}</strong></div>)}</div></div>
        <div className="admin-panel"><div className="section-heading"><div><p className="eyebrow">Event Stream</p><h2>最近操作</h2></div></div><div className="event-stream">{dashboard?.recent_events?.slice(0, 18).map((item) => <div key={item.id}><i /><span><strong>{item.nickname}</strong>{eventLabels[item.event_name] || item.event_name}</span><time>{new Date(item.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>)}</div></div>
      </section>
      <section className="admin-panel collector-panel">
        <div className="section-heading"><div><p className="eyebrow">Content Collector</p><h2>网页采集</h2></div><span>{preview?.fetched_at ? `抓取于 ${new Date(preview.fetched_at).toLocaleTimeString("zh-CN")}` : "HTTPS 白名单"}</span></div>
        <div className="collector-layout">
          <form className="collector-source" onSubmit={fetchPreview}>
            <label>来源网页<input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://..." required /></label>
            <button className="ghost" disabled={Boolean(collectorBusy)}>{collectorBusy === "fetch" ? "正在抓取..." : "抓取正文"}</button>
            <div className="collector-preview" aria-live="polite">
              {preview ? <><strong>{preview.title}</strong><p>{preview.text}</p></> : <p className="empty-copy">等待抓取。</p>}
            </div>
          </form>
          <form className="collector-import" onSubmit={importQuestions}>
            <div className="collector-fields">
              <label>题集标题<input value={importTitle} onChange={(event) => setImportTitle(event.target.value)} required /></label>
              <label>学科<select value={importSubject} onChange={(event) => setImportSubject(event.target.value)}>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select></label>
            </div>
            <label>结构化题目 JSON<textarea className="collector-json" value={questionsJson} onChange={(event) => setQuestionsJson(event.target.value)} spellCheck="false" required /></label>
            <button className="primary" disabled={Boolean(collectorBusy) || !sourceUrl}>{collectorBusy === "import" ? "正在导入..." : "导入新发现"}</button>
          </form>
        </div>
      </section>
      <section className="admin-panel"><div className="section-heading"><div><p className="eyebrow">Feedback Inbox</p><h2>反馈收件箱</h2></div><span>{feedback.length} 条</span></div><div className="admin-feedback-list">{feedback.length ? feedback.map((item) => <article key={item.id}><div className="admin-feedback-meta"><strong>{item.user?.nickname}</strong><span>{item.user?.grade}</span><span>v{item.app_version}</span><time>{new Date(item.created_at).toLocaleString("zh-CN")}</time></div><p>{item.message}</p><textarea rows="2" value={item.admin_note || ""} onChange={(event) => setFeedback((items) => items.map((entry) => entry.id === item.id ? { ...entry, admin_note: event.target.value } : entry))} placeholder="给学生的处理回复（选填）" /><div className="admin-feedback-actions"><span className={`feedback-status ${item.status}`}>{feedbackStatuses[item.status]}</span><button className="ghost" onClick={() => updateFeedback(item, "reviewing")}>处理中</button><button className="primary" onClick={() => updateFeedback(item, "resolved")}>标记解决</button></div></article>) : <p className="empty-copy">暂无反馈。</p>}</div></section>
    </div>
  );
}
