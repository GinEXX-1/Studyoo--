import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import CollectionCover from "../components/CollectionCover.jsx";
import MountainMark from "../components/MountainMark.jsx";

export default function HomePage() {
  const navigate = useNavigate();

  const { data: collectionsData } = useQuery({
    queryKey: ["collections"],
    queryFn: () => apiRequest("/collections").then((data) => data.items || []),
  });

  const { data: statsData } = useQuery({
    queryKey: ["profile-stats"],
    queryFn: () => apiRequest("/profile/stats"),
  });

  const { data: todayData } = useQuery({
    queryKey: ["recommend-today"],
    queryFn: () => apiRequest("/recommend/today"),
  });

  const collections = collectionsData || [];
  const stats = statsData;
  const featured = collections[0];
  const todayTask = todayData?.recommended?.[0];
  const completedCount = stats?.summary?.total_attempts || 0;
  const accuracy = stats?.summary?.correct_rate || 0;

  return (
    <div className="page-stack home-page">
      <section className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <p className="eyebrow">Studyoo / 学习工作台</p>
          <h1>今天，先把一件事想明白。</h1>
          <p className="hero-lede">Studyoo 不替你完成思考。每一道题，都会变成下一次更清楚的自己。</p>
          <div className="form-actions">
            {featured && <button className="primary" onClick={() => navigate(`/practice/${featured.id}`)}>开始真题练习</button>}
            <button className="hero-link" onClick={() => navigate("/today")}>查看今日计划 <span>→</span></button>
          </div>
        </div>
        <div className="focus-card">
          <div className="focus-card-top"><span>当前最值得做</span><span className="focus-dot" /></div>
          <strong>{todayTask?.knowledge_tag || featured?.title || "建立第一条学习记录"}</strong>
          <p>{todayTask?.question_title || (featured ? "完成一题完整的真题练习，开始积累你的理解轨迹。" : "导入一份试卷，Studyoo 会帮你建立个人题库。")}</p>
          <button className="focus-action" onClick={() => navigate(todayTask ? `/review/${todayTask.review_task_id}` : featured ? `/practice/${featured.id}` : "/library")}>
            {todayTask ? "开始复测" : featured ? "继续练习" : "建立题库"}<span>↗</span>
          </button>
        </div>
        <MountainMark />
      </section>

      <section className="dashboard-metrics" aria-label="学习概览">
        <div><span>累计作答</span><strong>{completedCount}</strong><small>道题</small></div>
        <div><span>平均正确率</span><strong>{accuracy}%</strong><small>持续更新</small></div>
        <div><span>平均得分</span><strong>{stats?.summary?.average_score || 0}</strong><small>最近练习</small></div>
        <div><span>今日待做</span><strong>{stats?.summary?.today_pending || 0}</strong><small>项计划</small></div>
      </section>

      <section className="dashboard-section">
        <div className="section-heading"><div><p className="eyebrow">The learning loop</p><h2>把一次练习，变成长期能力</h2></div><span className="section-note">Practice → Parse → Memory</span></div>
        <div className="capability-grid">
          <button className="capability-card capability-primary" onClick={() => featured && navigate(`/practice/${featured.id}`)}>
            <span className="capability-index">01 / Practice</span><strong>先独立作答</strong><p>完整写下你的思路，再让 AI 评阅你已经掌握和真正卡住的地方。</p><span className="capability-cta">进入练习 <b>↗</b></span>
          </button>
          <button className="capability-card" onClick={() => navigate("/today")}>
            <span className="capability-index">02 / Review</span><strong>回到最该复习的地方</strong><p>根据你的错误和遗忘节奏，今天只做真正值得做的复测。</p><span className="capability-cta">打开计划 <b>↗</b></span>
          </button>
          <button className="capability-card" onClick={() => navigate("/parser")}>
            <span className="capability-index">03 / Parse</span><strong>把卡住的那一步想明白</strong><p>需要帮助时再进入解析，逐步追问，不直接跳到答案。</p><span className="capability-cta">开始解析 <b>↗</b></span>
          </button>
        </div>
      </section>

      <section className="dashboard-section library-preview">
        <div className="section-heading"><div><p className="eyebrow">Your question bank</p><h2>最近的题库</h2></div><button className="text-button" onClick={() => navigate("/library")}>管理题库 →</button></div>
        <div className="collection-shelf">
          {collections.slice(0, 4).map((collection) => (
            <button className="shelf-item" key={collection.id} onClick={() => navigate(`/practice/${collection.id}`)}>
              <CollectionCover collection={collection} /><strong>{collection.title}</strong><span>{collection.question_count} 题 · {collection.description || "继续建立你的理解"}</span>
            </button>
          ))}
          {!collections.length && <p className="empty-copy">还没有题库。去题库页导入一份试卷，开始你的第一轮练习。</p>}
        </div>
      </section>
    </div>
  );
}
