import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { toast } from "sonner";

export default function AiBuilder({ onCreated }) {
  const [strategy, setStrategy] = useState("knowledge");
  const [subject, setSubject] = useState("数学");
  const [knowledgeTag, setKnowledgeTag] = useState("函数");
  const [questionCount, setQuestionCount] = useState(8);
  const [loading, setLoading] = useState(false);

  const subjects = ["数学", "物理", "化学", "历史", "地理", "政治", "语文", "英语"];

  async function build() {
    setLoading(true);
    try {
      const collection = await apiRequest("/collections/ai", {
        method: "POST",
        body: JSON.stringify({ strategy, subject, knowledge_tag: knowledgeTag, question_count: questionCount })
      });
      toast.success(`“${collection.title}”已生成`);
      onCreated(collection);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="tool-surface">
      <div className="section-heading"><div><p className="eyebrow">AI Builder</p><h2>让 AI 帮你组一份卷</h2></div></div>
      <div className="segmented build-mode">
        <button className={strategy === "knowledge" ? "active" : ""} onClick={() => setStrategy("knowledge")}>按知识点</button>
        <button className={strategy === "weakness" ? "active" : ""} onClick={() => setStrategy("weakness")}>按薄弱项</button>
      </div>
      <div className="builder-form ai-builder-fields">
        <label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}>{subjects.map((item) => <option key={item}>{item}</option>)}</select></label>
        {strategy === "knowledge" ? (
          <label>目标知识点<input value={knowledgeTag} onChange={(event) => setKnowledgeTag(event.target.value)} placeholder="例如：函数、数列、概率" /></label>
        ) : (
          <div className="builder-note"><strong>根据个人能力数据组卷</strong><span>AI 会优先选择得分偏低、反复出错的知识点，并安排难度梯度。</span></div>
        )}
        <label>题目数量<input type="number" min="3" max="20" value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))} /></label>
      </div>
      <button className="primary" disabled={loading} onClick={build}>{loading ? "AI 正在组卷..." : "生成题库"}</button>
    </section>
  );
}