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
const crawlStatusLabels = { queued: "排队中", running: "正在爬取", review: "等待审核", completed: "审核完成", failed: "失败" };

export default function AdminPage() {
  const [dashboard, setDashboard] = useState(null);
  const [feedback, setFeedback] = useState([]);
  const [connected, setConnected] = useState(false);
  const [crawlUrl, setCrawlUrl] = useState("");
  const [crawlSubject, setCrawlSubject] = useState("数学");
  const [maxPages, setMaxPages] = useState("3");
  const [crawlJobs, setCrawlJobs] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [crawlDetail, setCrawlDetail] = useState(null);
  const [collectorBusy, setCollectorBusy] = useState("");

  async function loadFeedback() {
    const data = await apiRequest("/admin/feedback");
    setFeedback(data.items || []);
  }

  async function loadCrawlJobs(preferredId) {
    const data = await apiRequest("/admin/discovery/crawl-jobs");
    const items = data.items || [];
    setCrawlJobs(items);
    const nextId = preferredId || selectedJobId || items[0]?.id;
    if (nextId) {
      setSelectedJobId(nextId);
      const detail = await apiRequest(`/admin/discovery/crawl-jobs/${nextId}`);
      setCrawlDetail(detail);
    }
  }

  useEffect(() => {
    let source;
    let fallback;
    apiRequest("/admin/dashboard").then(setDashboard).catch((error) => toast.error(error.message));
    loadFeedback().catch((error) => toast.error(error.message));
    loadCrawlJobs().catch((error) => toast.error(error.message));
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

  useEffect(() => {
    if (!crawlJobs.some((job) => ["queued", "running"].includes(job.status))) return undefined;
    const timer = setInterval(() => loadCrawlJobs(selectedJobId).catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [crawlJobs, selectedJobId]);

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

  async function startCrawl(event) {
    event.preventDefault();
    setCollectorBusy("crawl");
    try {
      const data = await apiRequest("/admin/discovery/crawl", {
        method: "POST",
        body: JSON.stringify({ url: crawlUrl, subject: crawlSubject, max_pages: Number(maxPages) })
      });
      await loadCrawlJobs(data.job.id);
      setCrawlUrl("");
      toast.success("爬取任务已启动");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCollectorBusy("");
    }
  }

  async function selectCrawlJob(jobId) {
    setSelectedJobId(jobId);
    try {
      setCrawlDetail(await apiRequest(`/admin/discovery/crawl-jobs/${jobId}`));
    } catch (error) {
      toast.error(error.message);
    }
  }

  function editCandidate(candidateId, patch) {
    setCrawlDetail((current) => ({
      ...current,
      candidates: current.candidates.map((item) => item.id === candidateId ? { ...item, ...patch } : item)
    }));
  }

  async function saveCandidate(candidate) {
    setCollectorBusy(candidate.id);
    try {
      const updated = await apiRequest(`/admin/discovery/candidates/${candidate.id}`, {
        method: "PATCH",
        body: JSON.stringify(candidate)
      });
      editCandidate(candidate.id, updated);
      toast.success("候选题已保存");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCollectorBusy("");
    }
  }

  async function reviewCandidate(candidate, action) {
    setCollectorBusy(candidate.id);
    try {
      if (action === "approve") {
        await apiRequest(`/admin/discovery/candidates/${candidate.id}`, {
          method: "PATCH",
          body: JSON.stringify(candidate)
        });
      }
      await apiRequest(`/admin/discovery/candidates/${candidate.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "reject" ? { reason: candidate.review_note } : {})
      });
      await loadCrawlJobs(selectedJobId);
      toast.success(action === "approve" ? "已审核发布到新发现" : "已拒绝候选题");
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
        <div className="section-heading"><div><p className="eyebrow">Question Crawler</p><h2>自动采集与人工审核</h2></div><span>白名单 · 同域 · 最多 5 页</span></div>
        <form className="crawler-form" onSubmit={startCrawl}>
          <label>起始网页<input type="url" value={crawlUrl} onChange={(event) => setCrawlUrl(event.target.value)} placeholder="https://..." required /></label>
          <label>学科<select value={crawlSubject} onChange={(event) => setCrawlSubject(event.target.value)}>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select></label>
          <label>页面数<select value={maxPages} onChange={(event) => setMaxPages(event.target.value)}><option value="1">1 页</option><option value="3">3 页</option><option value="5">5 页</option></select></label>
          <button className="primary" disabled={Boolean(collectorBusy)}>{collectorBusy === "crawl" ? "正在创建..." : "开始爬取"}</button>
        </form>
        <div className="crawler-workspace">
          <aside className="crawl-job-list">
            {crawlJobs.length ? crawlJobs.map((job) => <button key={job.id} className={selectedJobId === job.id ? "active" : ""} onClick={() => selectCrawlJob(job.id)}><strong>{job.subject} · {crawlStatusLabels[job.status] || job.status}</strong><span>{job.pages_crawled}/{job.max_pages} 页 · {job.candidate_counts.pending} 待审</span><small>{new URL(job.seed_url).hostname}</small></button>) : <p className="empty-copy">还没有爬取任务。</p>}
          </aside>
          <div className="crawl-review">
            {crawlDetail ? <>
              <div className="crawl-progress"><div><strong>{crawlStatusLabels[crawlDetail.job.status] || crawlDetail.job.status}</strong><span>{crawlDetail.job.pages_crawled}/{crawlDetail.job.max_pages} 页 · 找到 {crawlDetail.job.candidates_found} 道</span></div><progress value={crawlDetail.job.pages_crawled} max={crawlDetail.job.max_pages} />{crawlDetail.job.error_message && <p>{crawlDetail.job.error_message}</p>}</div>
              <div className="crawl-candidates">
                {crawlDetail.candidates.length ? crawlDetail.candidates.map((candidate) => <article key={candidate.id} className={`crawl-candidate ${candidate.status}`}>
                  <div className="crawl-candidate-meta"><strong>第 {candidate.question_number} 题</strong><span>{Math.round(candidate.confidence * 100)}% 置信度</span><span>{candidate.status === "pending" ? "待审核" : candidate.status === "approved" ? "已发布" : "已拒绝"}</span><a href={candidate.source_url} target="_blank" rel="noreferrer">查看来源</a></div>
                  <div className="crawler-fields"><label>题号<input disabled={candidate.status !== "pending"} value={candidate.question_number} onChange={(event) => editCandidate(candidate.id, { question_number: event.target.value })} /></label><label>题型<input disabled={candidate.status !== "pending"} value={candidate.question_type} onChange={(event) => editCandidate(candidate.id, { question_type: event.target.value })} /></label><label>难度<select disabled={candidate.status !== "pending"} value={candidate.difficulty} onChange={(event) => editCandidate(candidate.id, { difficulty: event.target.value })}><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label></div>
                  <label>题目内容<textarea disabled={candidate.status !== "pending"} value={candidate.content_text} onChange={(event) => editCandidate(candidate.id, { content_text: event.target.value })} /></label>
                  <label>参考答案<textarea disabled={candidate.status !== "pending"} value={candidate.official_answer_text} onChange={(event) => editCandidate(candidate.id, { official_answer_text: event.target.value })} /></label>
                  <label>知识点<input disabled={candidate.status !== "pending"} value={candidate.knowledge_tags.join("、")} onChange={(event) => editCandidate(candidate.id, { knowledge_tags: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>
                  {candidate.status === "pending" && <div className="crawl-review-actions"><button className="ghost" disabled={collectorBusy === candidate.id} onClick={() => saveCandidate(candidate)}>保存修改</button><button className="ghost danger" disabled={collectorBusy === candidate.id} onClick={() => reviewCandidate(candidate, "reject")}>拒绝</button><button className="primary" disabled={collectorBusy === candidate.id} onClick={() => reviewCandidate(candidate, "approve")}>通过并发布</button></div>}
                </article>) : <p className="empty-copy">{["queued", "running"].includes(crawlDetail.job.status) ? "正在抓取并识别题目..." : "这个任务没有识别出候选题。"}</p>}
              </div>
            </> : <p className="empty-copy">选择一个任务查看候选题。</p>}
          </div>
        </div>
      </section>
      <section className="admin-panel"><div className="section-heading"><div><p className="eyebrow">Feedback Inbox</p><h2>反馈收件箱</h2></div><span>{feedback.length} 条</span></div><div className="admin-feedback-list">{feedback.length ? feedback.map((item) => <article key={item.id}><div className="admin-feedback-meta"><strong>{item.user?.nickname}</strong><span>{item.user?.grade}</span><span>v{item.app_version}</span><time>{new Date(item.created_at).toLocaleString("zh-CN")}</time></div><p>{item.message}</p><textarea rows="2" value={item.admin_note || ""} onChange={(event) => setFeedback((items) => items.map((entry) => entry.id === item.id ? { ...entry, admin_note: event.target.value } : entry))} placeholder="给学生的处理回复（选填）" /><div className="admin-feedback-actions"><span className={`feedback-status ${item.status}`}>{feedbackStatuses[item.status]}</span><button className="ghost" onClick={() => updateFeedback(item, "reviewing")}>处理中</button><button className="primary" onClick={() => updateFeedback(item, "resolved")}>标记解决</button></div></article>) : <p className="empty-copy">暂无反馈。</p>}</div></section>
    </div>
  );
}
