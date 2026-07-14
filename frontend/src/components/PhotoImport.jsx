import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "../lib/api.js";
import { subjectTags, questionTypes, questionTypeLabel } from "../lib/studyMetadata.js";

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取这张图片。"));
    reader.readAsDataURL(file);
  });
}

// 拍照导入：拍照/选图 → AI 识别 → 校对草稿 → 确认入库
export default function PhotoImport({ onDone }) {
  const [subject, setSubject] = useState("数学");
  const [phase, setPhase] = useState("pick"); // pick | recognizing | review | saving
  const [preview, setPreview] = useState(null);
  const [photoId, setPhotoId] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [draft, setDraft] = useState(null);

  async function choosePhoto(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("请选择题目照片。");
    if (file.size > 10 * 1024 * 1024) return toast.error("照片不能超过 10MB。");
    setPhase("recognizing");
    try {
      const dataUrl = await readDataUrl(file);
      setPreview(dataUrl);
      const result = await apiRequest("/import/photo/recognize", {
        method: "POST",
        body: JSON.stringify({ subject, image_base64: dataUrl })
      });
      setPhotoId(result.photo_id);
      setImageUrl(result.image_url);
      setDraft(result.draft);
      setPhase("review");
      if (result.draft.confidence < 0.7) toast.warning("照片识别置信度较低，请仔细核对题干。");
    } catch (error) {
      toast.error(error.message);
      setPhase("pick");
      setPreview(null);
    }
  }

  function updateField(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function confirm() {
    if (!draft?.stem_text?.trim()) return toast.error("题目内容不能为空。");
    setPhase("saving");
    try {
      const result = await apiRequest("/import/photo/confirm", {
        method: "POST",
        body: JSON.stringify({ photo_id: photoId, ...draft })
      });
      toast.success("题目已加入「拍照导入」题库");
      setPhase("pick");
      setPreview(null);
      setDraft(null);
      setPhotoId(null);
      onDone?.(result.collection_id);
    } catch (error) {
      toast.error(error.message);
      setPhase("review");
    }
  }

  if (phase === "pick" || phase === "recognizing") {
    return (
      <section className="photo-import">
        <label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}>{Object.keys(subjectTags).map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className={`photo-dropzone ${phase === "recognizing" ? "busy" : ""}`}>
          {phase === "recognizing"
            ? <><div className="parsing-spinner" /><strong>正在识别题目...</strong><span>视觉 AI 转写题干与选项，约需 30 秒</span></>
            : <><strong>拍下或选择一道题</strong><span>对准单道题目，光线充足、字迹清晰识别最准</span></>}
          <input type="file" accept="image/*" capture="environment" disabled={phase === "recognizing"} onChange={(event) => { choosePhoto(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <p className="hint">识别一张照片消耗 1 次 AI 额度。入库前可以修改识别结果。</p>
      </section>
    );
  }

  return (
    <section className="photo-import">
      <div className="photo-review-image"><img src={preview || imageUrl} alt="题目照片" /></div>
      <div className="review-form">
        <label>题目内容<textarea rows="6" value={draft?.stem_text || ""} onChange={(event) => updateField("stem_text", event.target.value)} /></label>
        <div className="review-form-row">
          <label>题型<select value={draft?.question_type || "choice"} onChange={(event) => updateField("question_type", event.target.value)}>{questionTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
          <label>难度<select value={draft?.difficulty || "medium"} onChange={(event) => updateField("difficulty", event.target.value)}><option value="easy">基础</option><option value="medium">中等</option><option value="hard">困难</option></select></label>
        </div>
        <label>参考答案（可留空）<textarea rows="3" value={draft?.reference_answer_text || ""} onChange={(event) => updateField("reference_answer_text", event.target.value)} /></label>
        <label>知识点标签<div className="tag-editor"><div>{(draft?.knowledge_tags || []).map((tag) => <span key={tag} className="tag-item">{tag}<button type="button" onClick={() => updateField("knowledge_tags", draft.knowledge_tags.filter((item) => item !== tag))}>×</button></span>)}</div><div className="tag-suggestions">{subjectTags[subject].filter((tag) => !(draft?.knowledge_tags || []).includes(tag)).slice(0, 8).map((tag) => <button type="button" key={tag} onClick={() => updateField("knowledge_tags", [...(draft.knowledge_tags || []), tag])}>{tag}</button>)}</div></div></label>
        <label className="figure-toggle"><input type="checkbox" checked={draft?.has_figure !== false} onChange={(event) => updateField("has_figure", event.target.checked)} /><span>做题时展示原照片（题目含图形时必选）</span></label>
      </div>
      <div className="review-actions">
        <button className="ghost" disabled={phase === "saving"} onClick={() => { setPhase("pick"); setPreview(null); setDraft(null); }}>重拍</button>
        <button className="primary" disabled={phase === "saving" || !draft?.stem_text?.trim()} onClick={confirm}>{phase === "saving" ? "正在入库..." : "确认入库"}</button>
      </div>
      <p className="hint">题型：{questionTypeLabel(draft?.question_type)} · 识别置信度 {Math.round((draft?.confidence || 0) * 100)}%</p>
    </section>
  );
}
