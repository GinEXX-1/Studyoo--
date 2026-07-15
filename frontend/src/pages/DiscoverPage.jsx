import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MathText } from "../components/MathText.jsx";
import { apiRequest } from "../lib/api.js";

const subjects = ["全部", "数学", "物理", "化学", "生物", "历史", "地理", "政治", "语文", "英语"];
const sourceLabels = { official: "真题精选", community: "同学共享", web: "网络采集" };

export default function DiscoverPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [subject, setSubject] = useState("全部");
  const [source, setSource] = useState("all");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (subject !== "全部") query.set("subject", subject);
      if (source !== "all") query.set("source", source);
      const data = await apiRequest(`/discover?${query.toString()}`);
      setItems(data.items || []);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [subject, source]);

  const featured = useMemo(() => items.slice(0, 3), [items]);

  async function save(item) {
    try {
      const result = await apiRequest(`/discover/${item.id}/save`, { method: "POST" });
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, is_saved: true } : entry));
      toast.success("已加入你的新发现题库", { action: { label: "查看", onClick: () => navigate(`/library?collection=${result.collection_id}`) } });
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function rate(item, rating) {
    try {
      const updated = await apiRequest(`/discover/${item.id}/rating`, { method: "POST", body: JSON.stringify({ rating }) });
      setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry));
    } catch (error) {
      toast.error(error.message);
    }
  }

  return (
    <div className="page-stack discover-page">
      <section className="discover-heading"><div><p className="eyebrow">Fresh Questions</p><h1>新发现</h1><p>来自公开真题、实时采集与同学共享的题目。先判断价值，再加入自己的练习库。</p></div><div className="discover-source-tabs"><button className={source === "all" ? "active" : ""} onClick={() => setSource("all")}>全部</button><button className={source === "official" ? "active" : ""} onClick={() => setSource("official")}>真题</button><button className={source === "web" ? "active" : ""} onClick={() => setSource("web")}>新采集</button><button className={source === "community" ? "active" : ""} onClick={() => setSource("community")}>同学共享</button></div></section>
      <div className="discover-subjects" aria-label="筛选学科">{subjects.map((item) => <button key={item} className={subject === item ? "active" : ""} onClick={() => setSubject(item)}>{item}</button>)}</div>
      {!loading && featured.length > 0 && <section className="discover-featured"><div className="section-heading"><div><p className="eyebrow">Just In</p><h2>刚刚加入</h2></div><span>{items.length} 道可选</span></div><div className="featured-question-grid">{featured.map((item, index) => <article key={item.id} className={`featured-question feature-${index + 1}`}><div className="discovery-card-meta"><span>{sourceLabels[item.source_type]}</span><b>{item.subject}</b></div><h3>{item.paper_title}</h3><div className="question-preview"><MathText text={item.content_text} /></div><div className="discovery-card-footer"><span>{item.knowledge_tags.slice(0, 2).join(" · ") || item.question_type}</span><button className={item.is_saved ? "ghost saved" : "primary"} disabled={item.is_saved} onClick={() => save(item)}>{item.is_saved ? "已收藏" : "加入题库"}</button></div></article>)}</div></section>}
      <section className="discover-catalog"><div className="section-heading"><div><p className="eyebrow">Browse</p><h2>浏览题目</h2></div></div>{loading ? <p className="empty-copy">正在载入新发现...</p> : items.length ? <div className="discovery-grid">{items.map((item) => <article className="discovery-card" key={item.id}><div className="discovery-card-meta"><span>{sourceLabels[item.source_type]}</span><b>{item.subject}</b>{item.contributor && <em>by {item.contributor}</em>}</div><h3>{item.paper_title} · 第 {item.question_number} 题</h3><div className="question-preview"><MathText text={item.content_text} /></div><div className="discovery-tags">{item.knowledge_tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div><div className="rating-row"><div aria-label="题目评分">{[1, 2, 3, 4, 5].map((rating) => <button key={rating} title={`${rating} 分`} className={rating <= item.my_rating ? "active" : ""} onClick={() => rate(item, rating)}>★</button>)}</div><span>{item.average_rating ? `${item.average_rating} · ${item.rating_count} 人` : "暂无评价"}</span></div><button className={item.is_saved ? "ghost saved" : "primary"} disabled={item.is_saved} onClick={() => save(item)}>{item.is_saved ? "已在题库" : "添加到我的题库"}</button></article>)}</div> : <p className="empty-copy">这个筛选下还没有题目。</p>}</section>
    </div>
  );
}
