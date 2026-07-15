import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import CollectionCover from "../components/CollectionCover.jsx";

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
          <h1>今天，先把一件事想明白。</h1>
          <p className="hero-lede">每一道题，都会变成更清楚的自己。</p>
          <div className="form-actions">
            <button className="primary" onClick={() => navigate(featured ? `/practice/${featured.id}` : "/library")}>{featured ? "开始学习" : "建立题库"}</button>
            <button className="ghost" onClick={() => navigate("/library")}>探索题库</button>
          </div>
          <div className="hero-proof" aria-label="Studyoo 学习数据">
            <span><strong>{collections.length || 9}</strong> 个题库</span>
            <span><strong>{completedCount}</strong> 次作答</span>
            <span><strong>{accuracy}%</strong> 正确率</span>
          </div>
        </div>
        <div className="hero-scene" aria-label="学习进度概览">
          <span className="scene-decor scene-decor-ring" aria-hidden="true" />
          <span className="scene-decor scene-decor-diamond" aria-hidden="true" />
          <span className="scene-decor scene-decor-dots" aria-hidden="true" />
          <button className="scene-card scene-ai" onClick={() => navigate("/parser")}>
            <span className="scene-label"><i /> AI 学习助手</span>
            <p>{todayTask?.question_title || "这道题的关键，是先看清条件。要我一步步拆给你看吗？"}</p>
          </button>
          <button className="scene-card scene-course" onClick={() => navigate(featured ? `/practice/${featured.id}` : "/library")}>
            <small>{featured?.subject || "数学"} · 今日重点</small>
            <strong>{featured?.title || "函数与导数"}</strong>
            <span>{featured?.question_count || 0} 题 · 继续建立理解</span>
            <b><i style={{ width: `${Math.max(18, accuracy)}%` }} /></b>
          </button>
          <button className="scene-card scene-path" onClick={() => navigate("/today")}>
            <small>今日学习路径</small>
            <strong>{todayTask?.knowledge_tag || "先完成一轮专注练习"}</strong>
            <span>{stats?.summary?.today_pending || 0} 项待完成</span>
          </button>
          <span className="scene-streak">连续学习 · 保持清醒</span>
        </div>
      </section>

      <section className="dashboard-metrics" aria-label="学习概览">
        <div><span>累计作答</span><strong>{completedCount}</strong><small>道题</small></div>
        <div><span>平均正确率</span><strong>{accuracy}%</strong><small>持续更新</small></div>
        <div><span>平均得分</span><strong>{stats?.summary?.average_score || 0}</strong><small>最近练习</small></div>
        <div><span>今日待做</span><strong>{stats?.summary?.today_pending || 0}</strong><small>项计划</small></div>
      </section>

      <section className="dashboard-section">
        <div className="section-heading"><div><p className="eyebrow">学习闭环</p><h2>把一次练习，变成长期能力</h2></div><span className="section-note">练习 · 解析 · 复测</span></div>
        <div className="capability-grid">
          <button className="capability-card capability-primary" onClick={() => featured && navigate(`/practice/${featured.id}`)}>
            <span className="capability-index">01 · 练习</span><strong>先独立作答</strong><p>完整写下你的思路，再让 AI 评阅你已经掌握和真正卡住的地方。</p><span className="capability-cta">进入练习</span>
          </button>
          <button className="capability-card" onClick={() => navigate("/today")}>
            <span className="capability-index">02 · 复测</span><strong>回到最该复习的地方</strong><p>根据你的错误和遗忘节奏，今天只做真正值得做的复测。</p><span className="capability-cta">打开计划</span>
          </button>
          <button className="capability-card" onClick={() => navigate("/parser")}>
            <span className="capability-index">03 · 解析</span><strong>把卡住的那一步想明白</strong><p>需要帮助时再进入解析，逐步追问，不直接跳到答案。</p><span className="capability-cta">开始解析</span>
          </button>
        </div>
      </section>

      <section className="dashboard-section library-preview">
        <div className="section-heading"><div><p className="eyebrow">你的题库</p><h2>最近学习</h2></div><button className="text-button" onClick={() => navigate("/library")}>管理题库</button></div>
        <div className="collection-shelf">
          {collections.slice(0, 4).map((collection, index) => (
            <button className="shelf-item" key={collection.id} onClick={() => navigate(`/practice/${collection.id}`)}>
              <CollectionCover collection={collection} variant={index} /><strong>{collection.title}</strong><span>{collection.question_count} 题 · {collection.description || "继续建立你的理解"}</span>
            </button>
          ))}
          {!collections.length && <p className="empty-copy">还没有题库。去题库页导入一份试卷，开始你的第一轮练习。</p>}
        </div>
      </section>
    </div>
  );
}
