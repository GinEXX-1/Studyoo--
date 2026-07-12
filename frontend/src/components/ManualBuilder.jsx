import { useState, useEffect } from "react";
import { apiRequest } from "../lib/api.js";
import { toast } from "sonner";

export default function ManualBuilder({ onCreated }) {
  const [papers, setPapers] = useState([]);
  const [paperId, setPaperId] = useState("");
  const [questions, setQuestions] = useState([]);
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState("我的精选练习");

  useEffect(() => {
    apiRequest("/exam/papers").then((data) => {
      setPapers(data.items || []);
      setPaperId(data.items?.[0]?.id || "");
    }).catch((err) => toast.error(err.message));
  }, []);

  useEffect(() => {
    if (!paperId) return;
    apiRequest(`/exam/papers/${paperId}/questions`).then((data) => { setQuestions(data.items || []); setSelected([]); }).catch((err) => toast.error(err.message));
  }, [paperId]);

  async function create() {
    try {
      const collection = await apiRequest("/collections", {
        method: "POST",
        body: JSON.stringify({ title, subject: papers.find((paper) => paper.id === paperId)?.subject || "数学", question_ids: selected })
      });
      toast.success(`“${collection.title}”已创建`);
      onCreated(collection);
    } catch (err) {
      toast.error(err.message);
    }
  }

  function toggle(id) {
    setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  }

  return (
    <section className="tool-surface">
      <div className="section-heading"><div><p className="eyebrow">Manual Mix</p><h2>自己挑题组卷</h2></div><span>{selected.length} 题已选</span></div>
      <div className="builder-form">
        <label>题库名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>从试卷选择<select value={paperId} onChange={(event) => setPaperId(event.target.value)}>{papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}</select></label>
      </div>
      <div className="pick-list">
        {questions.map((question) => (
          <label key={question.id} className={selected.includes(question.id) ? "selected" : ""}>
            <input type="checkbox" checked={selected.includes(question.id)} onChange={() => toggle(question.id)} />
            <span>第 {question.question_number} 题</span><strong>{question.question_type}</strong><small>{question.knowledge_tags.join(" · ") || "待标注"}</small>
          </label>
        ))}
      </div>
      <button className="primary" disabled={!selected.length} onClick={create}>建立题库</button>
    </section>
  );
}