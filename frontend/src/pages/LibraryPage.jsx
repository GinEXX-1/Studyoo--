import { useState, useEffect } from "react";
import { apiRequest } from "../lib/api.js";
import { useNavigate } from "react-router-dom";
import CollectionCover from "../components/CollectionCover.jsx";

import AiBuilder from "../components/AiBuilder.jsx";
import ManualBuilder from "../components/ManualBuilder.jsx";
import { toast } from "sonner";

export default function LibraryPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("library");
  const [collections, setCollections] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);

  async function loadCollections(preferredId = null) {
    try {
      const data = await apiRequest("/collections");
      setCollections(data.items || []);
      const id = preferredId || selectedId || data.items?.[0]?.id;
      if (id) selectCollection(id);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function selectCollection(id) {
    try {
      setSelectedId(id);
      const data = await apiRequest(`/collections/${id}`);
      setDetail(data);
    } catch (err) {
      toast.error(err.message);
    }
  }

  useEffect(() => { loadCollections(); }, []);

  function handleCreated(collection) {
    toast.success(`“${collection.title}”已加入你的题库。`);
    setMode("library");
    loadCollections(collection.id);
  }

  function startCollection(id) {
    navigate(`/practice/${id}`);
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><p className="eyebrow">Question Bank</p><h1>题库</h1><p>像整理播放列表一样，建立真正想做完的试卷。</p></div>
        <div className="library-mode-tabs">
          <button className={mode === "library" ? "active" : ""} onClick={() => setMode("library")}>我的题库</button>
          <button className={mode === "pdf" ? "active" : ""} onClick={() => navigate("/import")}>导入 PDF</button>
          <button className={mode === "ai" ? "active" : ""} onClick={() => setMode("ai")}>AI 组卷</button>
          <button className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}>手动组卷</button>
        </div>
      </section>

      {mode === "ai" && <AiBuilder onCreated={handleCreated} />}
      {mode === "manual" && <ManualBuilder onCreated={handleCreated} />}
      {mode === "library" && (
        <section className="library-layout">
          <div className="collection-grid">
            {collections.map((collection) => (
              <button key={collection.id} className={selectedId === collection.id ? "collection-tile active" : "collection-tile"} onClick={() => selectCollection(collection.id)}>
                <CollectionCover collection={collection} />
                <strong>{collection.title}</strong>
                <span>{collection.question_count} 题 · {collection.creation_mode.startsWith("ai") ? "AI 组卷" : collection.creation_mode === "pdf" ? "PDF" : "手动"}</span>
              </button>
            ))}
          </div>
          {detail && (
            <aside className="collection-detail">
              <CollectionCover collection={detail.collection} size="large" />
              <p className="eyebrow">{detail.collection.subject} · {detail.collection.question_count} 题</p>
              <h2>{detail.collection.title}</h2>
              <p>{detail.collection.description}</p>
              <button className="primary start-button" onClick={() => startCollection(detail.collection.id)}>开始</button>
              <div className="track-list">
                {detail.questions.map((question, index) => (
                  <div key={question.id}><span>{String(index + 1).padStart(2, "0")}</span><strong>第 {question.question_number} 题 · {question.question_type}</strong><small>{question.knowledge_tags.join(" · ") || "待标注"}</small></div>
                ))}
              </div>
            </aside>
          )}
        </section>
      )}
    </div>
  );
}