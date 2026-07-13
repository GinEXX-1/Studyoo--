import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { apiRequest } from "../lib/api.js";

function formatDate(value) {
  if (!value) return "";
  return new Date(`${value}T00:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function mapToday(item) {
  return {
    id: item.review_task_id,
    knowledgeTag: item.knowledge_tag,
    subject: item.subject,
    reason: item.is_overdue ? `已逾期，建议今天优先完成第 ${item.review_round} 轮复测。` : `今天进行第 ${item.review_round} 轮间隔复测。`,
    action: item.question_title || "完成一题同知识点复测",
    minutes: item.question_difficulty === "hard" ? 25 : 15,
  };
}

export default function TodayPage() {
  const navigate = useNavigate();
  const [path, setPath] = useState({ today: [], upcoming: [], completed: [] });
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [todayData, pendingData, completedData] = await Promise.all([
        apiRequest("/recommend/today"),
        apiRequest("/review/pending"),
        apiRequest("/review/completed?page_size=10")
      ]);
      const today = (todayData.recommended || []).map(mapToday);
      const todayIds = new Set(today.map((item) => item.id));
      const upcoming = (pendingData.items || []).filter((item) => !todayIds.has(item.id)).slice(0, 8);
      const completed = completedData.items || [];
      setPath({ today, upcoming, completed });
    } catch (error) {
      toast.error(error.message);
      setPath({ today: [], upcoming: [], completed: [] });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function dismiss(taskId) {
    try {
      await apiRequest(`/review/${taskId}/dismiss`, { method: "POST" });
      await load();
      toast.success("已从本次计划中忽略");
    } catch (error) {
      toast.error(error.message);
    }
  }

  return (
    <div className="page-stack today-page sy-stag">
      <section className="page-heading today-heading">
        <div><p className="eyebrow">Learning Path</p><h1>今日计划</h1><p>今天先完成最该做的，剩下的交给间隔复测。</p></div>
        <button className="ghost" disabled={loading} onClick={load}>{loading ? "正在刷新..." : "刷新计划"}</button>
      </section>

      <section className="today-section">
        <div className="today-section-heading"><h2>今日待做</h2><span>{path.today.length} 项</span></div>
        <div className="today-list">
          {path.today.map((item) => (
            <article className="today-item" key={item.id}>
              <span className="today-icon">!</span>
              <div className="today-item-body"><strong>{item.knowledgeTag}</strong><p>{item.reason}</p><b>{item.action}</b><small>{item.subject} · 1 题 · 约 {item.minutes} 分钟</small></div>
              <div className="today-item-actions"><button className="primary" onClick={() => navigate(`/review/${item.id}`)}>开始复习</button><button className="text-button" onClick={() => dismiss(item.id)}>忽略本次</button></div>
            </article>
          ))}
        </div>
        {!loading && !path.today.length && <p className="empty-copy">今天没有待复习任务。完成练习后，系统会自动安排下一次复测。</p>}
      </section>

      <section className="today-section muted-section">
        <div className="today-section-heading"><h2>即将复习</h2><span>{path.upcoming.length} 项</span></div>
        <div className="today-list">
          {path.upcoming.map((item) => <article className="today-item compact" key={item.id}><span className="today-icon upcoming">↻</span><div className="today-item-body"><strong>{item.knowledge_tag}</strong><p>{item.subject} · 第 {item.review_round} 轮复测</p></div><time>{formatDate(item.scheduled_date)}</time></article>)}
        </div>
      </section>

      <section className="today-section completed-section">
        <div className="today-section-heading"><h2>最近完成</h2><span>{path.completed.length} 项</span></div>
        <div className="today-list">
          {path.completed.map((item) => <article className="today-item compact" key={item.id}><span className="today-icon done">✓</span><div className="today-item-body"><strong>{item.knowledge_tag}</strong><p>{item.subject} · {item.result === "correct" ? "复测通过" : "继续巩固"}</p></div><b className="completed-score">{item.score} 分</b></article>)}
        </div>
      </section>
    </div>
  );
}
