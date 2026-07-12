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
    <div className="page-stack">
      <section className="page-heading"><div><p className="eyebrow">Question Parser</p><h1>题目解析</h1><p>卡住时先获得思路提示，完整解答由你主动展开。</p></div></section>
      <section className="parser-layout">
        <form className="tool-surface stack" onSubmit={submit}>
          <div className="segmented parser-mode">
            <button type="button" className={inputMode === "text" ? "active" : ""} onClick={() => setInputMode("text")}>粘贴题目</button>
            <button type="button" className={inputMode === "image" ? "active" : ""} onClick={() => setInputMode("image")}>上传图片</button>
          </div>
          <label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}>{subjects.map((item) => <option key={item}>{item}</option>)}</select></label>
          {inputMode === "text" ? (
            <label>题目<textarea rows="10" value={contentText} onChange={(event) => setContentText(event.target.value)} placeholder="粘贴一道题目..." /></label>
          ) : (
            <label
              className="image-dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); chooseImage(event.dataTransfer.files?.[0]); }}
            >
              {imageDataUrl ? <img src={imageDataUrl} alt="待识别题目" /> : <strong>拖入题目图片</strong>}
              <span>{imageFile ? imageFile.name : "支持 PNG、JPEG、WebP，最大 8MB"}</span>
              <span className="file-button">选择图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseImage(event.target.files?.[0])} /></span>
            </label>
          )}
          <button className="primary" disabled={loading || (inputMode === "text" ? !contentText.trim() : !imageDataUrl)}>{loading ? inputMode === "image" ? "正在识别图片..." : "解析中..." : "获取思路"}</button>
        </form>
        <section className="parser-result">
          {result ? (
            <>
              <p className="eyebrow">思路提示</p>
              {inputMode === "image" && <div className="recognized-question"><strong>识别题目</strong><MathText text={result.question.content_text} /></div>}
              {result.answer.hint_text && <div className="content-block"><MathText text={result.answer.hint_text} /></div>}
              {result.answer.full_solution_text ? <div className="content-block solution"><MathText text={result.answer.full_solution_text} /></div> : <button className="ghost" onClick={reveal}>查看完整解答</button>}
            </>
          ) : <div className="review-empty"><strong>解析会出现在这里</strong><p>先自己思考，再把真正卡住的题交给 AI。</p></div>}
        </section>
      </section>
    </div>
  );
}