import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import CollectionCover from "../components/CollectionCover.jsx";
import Stat from "../components/Stat.jsx";
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

  const collections = collectionsData || [];
  const stats = statsData;
  const featured = collections[0];

  return (
    <div className="page-stack">
      <section className="home-intro">
        <MountainMark />
        <div>
          <p className="eyebrow">Today</p>
          <h1>从一份真正想做完的试卷开始</h1>
          <p>选一套题库，完整作答，再让每次评阅沉淀成你的能力数据。</p>
          <div className="form-actions">
            {featured && <button className="primary" onClick={() => navigate(`/practice/${featured.id}`)}>开始最近题库</button>}
            <button className="ghost" onClick={() => navigate("/library")}>浏览题库</button>
          </div>
        </div>
        <div className="home-stats">
          <Stat value={stats?.summary.total_attempts || 0} label="累计作答" />
          <Stat value={`${stats?.summary.correct_rate || 0}%`} label="正确率" />
          <Stat value={stats?.summary.average_score || 0} label="平均分" />
          <Stat value={stats?.summary.today_pending || 0} label="今日待做" />
        </div>
      </section>

      <section className="shelf-section">
        <div className="section-heading"><div><p className="eyebrow">Your Library</p><h2>继续练习</h2></div><button className="text-button" onClick={() => navigate("/library")}>查看全部</button></div>
        <div className="collection-shelf">
          {collections.map((collection) => (
            <button className="shelf-item" key={collection.id} onClick={() => navigate(`/practice/${collection.id}`)}>
              <CollectionCover collection={collection} />
              <strong>{collection.title}</strong>
              <span>{collection.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
