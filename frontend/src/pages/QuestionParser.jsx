import { useState } from "react";
import { apiRequest } from "../lib/api.js";
import { MathText } from "../components/MathText.jsx";
import { toast } from "sonner";

const subjects = ["数学", "物理", "化学", "历史", "地理", "政治", "语文", "英语"];

export default function QuestionParser() {
  const [subject, setSubject] = useState("数学");
  const [inputMode, setInputMode] = useState("text");
  const [contentText, setContentText] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = inputMode === "image"
        ? await apiRequest("/questions/image", { method: "POST", body: JSON.stringify({ subject, image_data_url: imageDataUrl }) })
        : await apiRequest("/questions", { method: "POST", body: JSON.stringify({ subject, mode: "solve_from_scratch", content_text: contentText }) });
      setResult(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  function chooseImage(file) {
    if (!file) return;
    if (!file.type.match(/^image\/(png|jpeg|webp)$/) || file.size > 8 * 1024 * 1024) {
      toast.error("请选择不超过 8MB 的 PNG、JPEG 或 WebP 图片。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageFile(file);
      setImageDataUrl(String(reader.result));
    };
    reader.onerror = () => toast.error("无法读取这张图片。");
    reader.readAsDataURL(file);
  }

  async function reveal() {
    try {
      const answer = await apiRequest(`/questions/${result.question.id}/reveal-solution`, { method: "POST" });
      setResult((current) => ({ ...current, answer }));
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div className="parser-chat-page">
      <header className="parser-chat-heading"><span className="parser-orbit" aria-hidden="true" /><h1>把不懂的，讲到懂。</h1><p>贴一道题进来，或者直接问。</p></header>

      <section className="parser-conversation" aria-live="polite">
        {!result && !loading && <div className="parser-welcome"><span>AI 学习助手</span><strong>先说说你卡在了哪里？</strong><p>我会先给思路，再由你决定是否展开完整解答。</p></div>}
        {(contentText || imageDataUrl) && result && <div className="parser-message parser-message-user"><strong>{subject}</strong><p>{inputMode === "image" ? "请帮我识别并分析这道题。" : contentText}</p></div>}
        {loading && <div className="parser-typing" aria-label="AI 正在思考"><i /><i /><i /></div>}
        {result && <div className="parser-message parser-message-ai"><span>思路提示</span>{inputMode === "image" && <div className="recognized-question"><strong>识别题目</strong><MathText text={result.question.content_text} /></div>}{result.answer.hint_text && <MathText text={result.answer.hint_text} />}{result.answer.full_solution_text ? <div className="parser-solution"><MathText text={result.answer.full_solution_text} /></div> : <button className="ghost" onClick={reveal}>查看完整解答</button>}</div>}
      </section>

      {!result && <div className="parser-suggestions">
        {["帮我解释这个数学公式", "分析这道题的关键条件", "先给我一个思路提示", "帮我检查解题步骤"].map((text) => <button key={text} onClick={() => { setInputMode("text"); setContentText(text); }}>{text}</button>)}
      </div>}

      <form className="parser-composer" onSubmit={submit}>
        <div className="parser-composer-top">
          <label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}>{subjects.map((item) => <option key={item}>{item}</option>)}</select></label>
          <div className="parser-input-tabs"><button type="button" className={inputMode === "text" ? "active" : ""} onClick={() => setInputMode("text")}>粘贴题目</button><button type="button" className={inputMode === "image" ? "active" : ""} onClick={() => setInputMode("image")}>上传图片</button></div>
        </div>
        {inputMode === "text" ? <textarea rows="3" aria-label="题目或问题" value={contentText} onChange={(event) => setContentText(event.target.value)} placeholder="输入你的问题，或粘贴一道题…" /> : <label className="parser-image-picker" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseImage(event.dataTransfer.files?.[0]); }}>{imageDataUrl ? <img src={imageDataUrl} alt="待识别题目" /> : <strong>拖入题目图片，或点击选择</strong>}<span>{imageFile ? imageFile.name : "PNG、JPEG、WebP · 最大 8MB"}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseImage(event.target.files?.[0])} /></label>}
        <div className="parser-composer-actions"><span>{inputMode === "text" ? "先思考，再提问" : "图片会在本次解析中使用"}</span><button className="primary" disabled={loading || (inputMode === "text" ? !contentText.trim() : !imageDataUrl)}>{loading ? "正在思考…" : "发送"}</button></div>
      </form>
    </div>
  );
}
