import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import Stat from "../components/Stat.jsx";
import { apiRequest } from "../lib/api.js";

const grades = ["高一", "高二", "高三"];
const subjects = ["数学", "物理", "化学", "历史", "地理", "政治", "语文", "英语"];

function formatDate(value) {
  if (!value) return "";
  return new Date(`${value}T00:00:00`).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function mapToday(item) {
  return {
    id: item.review_task_id,
    knowledgeTag: item.knowledge_tag,
    subject: item.subject,
    reason: item.is_overdue ? `已逾期，建议今天优先完成第 ${item.review_round} 轮复测。` : `今天进行第 ${item.review_round} 轮间隔复测。`,
    recommendedAction: item.question_title || "完成一题同知识点复测",
    estimatedMinutes: item.question_difficulty === "hard" ? 25 : 15,
    questionCount: 1,
    knowledgeTags: item.question_tags || [item.knowledge_tag],
    scheduledDate: item.scheduled_date
  };
}

function mapPending(item) {
  return {
    id: item.id,
    knowledgeTag: item.knowledge_tag,
    subject: item.subject,
    reason: `${formatDate(item.scheduled_date)}进行第 ${item.review_round} 轮复测。`,
    recommendedAction: item.review_question_title || "同知识点复测",
    estimatedMinutes: 15,
    questionCount: 1,
    knowledgeTags: [item.knowledge_tag],
    scheduledDate: item.scheduled_date
  };
}

export default function ProfilePage({ user, onUserUpdated, onLogout }) {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [learningPath, setLearningPath] = useState({ today: [], upcoming: [], completed: [] });
  const [pathLoading, setPathLoading] = useState(false);
  const [grade, setGrade] = useState(user.grade);
  const [selectedSubjects, setSelectedSubjects] = useState(user.subjects || []);
  const [saved, setSaved] = useState(false);

  async function loadPath() {
    setPathLoading(true);
    try {
      const [todayData, pendingData, completedData] = await Promise.all([
        apiRequest("/recommend/today"),
        apiRequest("/review/pending"),
        apiRequest("/review/completed?page_size=10")
      ]);
      const today = (todayData.recommended || []).map(mapToday);
      const todayIds = new Set(today.map((item) => item.id));
      const upcoming = (pendingData.items || []).filter((item) => !todayIds.has(item.id)).slice(0, 8).map(mapPending);
      const completed = (completedData.items || []).map((item) => ({
        id: item.id,
        knowledgeTag: item.knowledge_tag,
        subject: item.subject,
        reason: item.result === "correct" ? "复测通过" : item.result === "partial" ? "部分掌握" : "仍需巩固",
        score: item.score,
        completedAt: item.completed_at
      }));
      setLearningPath({ today, upcoming, completed });
    } catch (error) {
      toast.error(error.message);
      setLearningPath({ today: [], upcoming: [], completed: [] });
    } finally {
      setPathLoading(false);
    }
  }

  useEffect(() => {
    apiRequest("/profile/stats").then(setStats).catch((error) => toast.error(error.message));
    loadPath();
  }, []);

  async function dismissTask(taskId) {
    try {
      await apiRequest(`/review/${taskId}/dismiss`, { method: "POST" });
      await loadPath();
      toast.success("已从本次计划中忽略");
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function saveProfile() {
    try {
      const nextUser = await apiRequest("/users/me", { method: "PATCH", body: JSON.stringify({ grade, subjects: selectedSubjects }) });
      onUserUpdated(nextUser);
      setSaved(true);
      toast.success("设置已保存");
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      toast.error(error.message);
    }
  }

  function toggleSubject(subject) {
    setSelectedSubjects((items) => items.includes(subject) ? items.filter((item) => item !== subject) : [...items, subject]);
  }

  return (
    <div className="page-stack">
      <section className="profile-hero"><div className="avatar">{user.nickname.slice(0, 1).toUpperCase()}</div><div><p className="eyebrow">Personal</p><h1>{user.nickname}</h1><p>{user.grade} · 已加入 Studyoo</p></div></section>
      <section className="profile-stats"><Stat value={stats?.summary.total_attempts || 0} label="累计作答" /><Stat value={`${stats?.summary.correct_rate || 0}%`} label="正确率" /><Stat value={stats?.summary.average_score || 0} label="平均分" /><Stat value={stats?.summary.collection_count || 0} label="个人题库" /></section>
      <section className="profile-grid">
        <div className="ability-panel"><div className="section-heading"><div><p className="eyebrow">Ability</p><h2>知识点能力</h2></div></div>{stats?.abilities.length ? stats.abilities.map((item) => <div className="ability-row" key={item.tag}><div><strong>{item.tag}</strong><span>{item.attempts} 次作答</span></div><div className="ability-track"><span style={{ width: `${item.average_score}%` }} /></div><b>{item.average_score}</b></div>) : <p className="empty-copy">完成几道题后，这里会形成你的能力图谱。</p>}</div>
        <div className="recent-panel"><div className="section-heading"><div><p className="eyebrow">Recent</p><h2>最近练习</h2></div></div>{stats?.recent_attempts.length ? stats.recent_attempts.map((item) => <div className="recent-row" key={item.id}><div><strong>{item.title}</strong><span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span></div><b>{item.score}</b></div>) : <p className="empty-copy">还没有练习记录。</p>}</div>
      </section>

      <section className="learning-path-panel">
        <div className="section-heading"><div><p className="eyebrow">Learning Path</p><h2>个性化学习路径</h2></div><button className="ghost" disabled={pathLoading} onClick={loadPath}>{pathLoading ? "正在计算..." : "刷新计划"}</button></div>
        {learningPath.today.length > 0 && <div className="path-section"><div className="path-section-header"><span className="path-section-label">今日待做</span><span className="path-section-count">{learningPath.today.length} 项</span></div><div className="path-section-items">{learningPath.today.map((item) => <article key={item.id} className="learning-path-item"><div className="path-item-left"><span className="path-icon today">!</span><div className="path-item-content"><strong>{item.knowledgeTag}</strong><p className="path-reason">{item.reason}</p><b>{item.recommendedAction}</b><div className="path-meta"><span className="meta-item">{item.subject}</span><span className="meta-item">{item.questionCount} 题</span><span className="meta-item">约 {item.estimatedMinutes} 分钟</span></div><div className="path-tags">{item.knowledgeTags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div></div></div><div className="path-item-right"><button className="primary small" onClick={() => navigate(`/review/${item.id}`)}>开始复习</button><button className="text-button" onClick={() => dismissTask(item.id)}>忽略本次</button></div></article>)}</div></div>}
        {learningPath.upcoming.length > 0 && <div className="path-section"><div className="path-section-header"><span className="path-section-label">即将复习</span><span className="path-section-count">{learningPath.upcoming.length} 项</span></div><div className="path-section-items">{learningPath.upcoming.map((item) => <article key={item.id} className="learning-path-item upcoming"><div className="path-item-left"><span className="path-icon upcoming">↻</span><div className="path-item-content"><strong>{item.knowledgeTag}</strong><p className="path-reason">{item.reason}</p><div className="path-meta"><span className="meta-item">{item.subject}</span><span className="meta-item">约 {item.estimatedMinutes} 分钟</span></div></div></div></article>)}</div></div>}
        {learningPath.completed.length > 0 && <div className="path-section completed"><div className="path-section-header"><span className="path-section-label">最近完成</span><span className="path-section-count">{learningPath.completed.length} 项</span></div><div className="path-section-items">{learningPath.completed.map((item) => <article key={item.id} className="learning-path-item completed"><div className="path-item-left"><span className="path-icon done">✓</span><div className="path-item-content"><strong>{item.knowledgeTag}</strong><p className="path-reason">{item.reason} · {item.score} 分</p><div className="path-meta"><span className="meta-item">{item.subject}</span><span className="meta-item">{item.completedAt ? new Date(item.completedAt).toLocaleDateString("zh-CN") : ""}</span></div></div></div></article>)}</div></div>}
        {!pathLoading && !learningPath.today.length && !learningPath.upcoming.length && !learningPath.completed.length && <p className="empty-copy">目前没有复习任务。答错一道练习题后，系统会安排当天、3 天、7 天和 14 天复测。</p>}
      </section>

      <section className="settings-panel"><div><p className="eyebrow">Settings</p><h2>学习设置</h2></div><label>年级<select value={grade} onChange={(event) => setGrade(event.target.value)}>{grades.map((item) => <option key={item}>{item}</option>)}</select></label><div className="subject-toggles">{subjects.map((subject) => <button key={subject} className={selectedSubjects.includes(subject) ? "active" : ""} onClick={() => toggleSubject(subject)}>{subject}</button>)}</div><div className="form-actions"><button className="primary" onClick={saveProfile}>保存设置</button>{saved && <span className="success">已保存</span>}</div><button className="logout-button" onClick={onLogout}>退出登录</button></section>
    </div>
  );
}
