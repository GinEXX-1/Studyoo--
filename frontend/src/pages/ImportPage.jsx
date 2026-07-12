import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { apiRequest } from "../lib/api.js";
import { questionTypeLabel, questionTypes, subjectTags } from "../lib/studyMetadata.js";

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("无法读取 PDF 文件。"));
    reader.readAsDataURL(file);
  });
}

export default function ImportPage() {
  const navigate = useNavigate();
  const [state, setState] = useState("upload");
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("数学");
  const [year, setYear] = useState(new Date().getFullYear());
  const [dragging, setDragging] = useState(false);
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedPageId, setSelectedPageId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [parseProgress, setParseProgress] = useState("");

  const selected = detail?.candidates.find((item) => item.id === selectedId) || null;
  const unsettled = detail?.candidates.filter((item) => !["confirmed", "rejected"].includes(item.review_status)) || [];
  const confirmedCount = detail?.candidates.filter((item) => item.review_status === "confirmed").length || 0;
  const settledCount = (detail?.candidates.length || 0) - unsettled.length;

  const pageById = useMemo(() => new Map((detail?.pages || []).map((page) => [page.id, page])), [detail]);

  function chooseFile(nextFile) {
    if (!nextFile) return;
    if (nextFile.type !== "application/pdf" && !nextFile.name.toLowerCase().endsWith(".pdf")) {
      toast.error("请选择 PDF 文件。");
      return;
    }
    if (nextFile.size > 20 * 1024 * 1024) {
      toast.error("PDF 文件不能超过 20MB。");
      return;
    }
    setFile(nextFile);
    setTitle(nextFile.name.replace(/\.pdf$/i, ""));
  }

  async function refreshTask(taskId, selectFirst = false) {
    const next = await apiRequest(`/import/pipeline/tasks/${taskId}`);
    setDetail(next);
    if (selectFirst && next.candidates.length) selectCandidate(next.candidates[0]);
    return next;
  }

  async function startUpload() {
    if (!file) return toast.error("请先选择一份 PDF。");
    setState("parsing");
    try {
      setParseProgress("正在上传并渲染试卷页面");
      const dataBase64 = await readBase64(file);
      const uploaded = await apiRequest("/import/pipeline/upload", {
        method: "POST",
        body: JSON.stringify({ file_name: file.name, data_base64: dataBase64, title, subject, year })
      });
      setDetail({ task: uploaded.task, pages: uploaded.pages, candidates: [] });
      setParseProgress(`正在逐页识别，共 ${uploaded.task.total_pages} 页`);
      const processed = await apiRequest(`/import/pipeline/tasks/${uploaded.task.id}/process-all`, { method: "POST" });
      const next = await refreshTask(uploaded.task.id, true);
      const failedPages = processed.results?.filter((item) => item.status === "failed").length || 0;
      if (!next.candidates.length) {
        throw new Error(failedPages ? "页面识别失败，请检查 AI 配置后重试。" : "没有识别出独立题目，请尝试更清晰的试卷 PDF。");
      }
      if (failedPages) toast.warning(`${failedPages} 页识别失败，其余页面可以继续校对。`);
      setState("reviewing");
    } catch (error) {
      toast.error(error.message);
      setState("failed");
    }
  }

  function selectCandidate(candidate) {
    setSelectedId(candidate.id);
    setSelectedPageId(candidate.page_id);
    setEditing({
      question_number: candidate.question_number,
      stem_text: candidate.stem_text || "",
      reference_answer_text: candidate.reference_answer_text || "",
      question_type: candidate.question_type || "choice",
      difficulty: candidate.difficulty || "medium",
      knowledge_tags: candidate.knowledge_tags || [],
      options: candidate.options || []
    });
  }

  async function reprocessSelectedPage() {
    if (!selectedPageId || !detail) return;
    const pageCandidates = detail.candidates.filter((item) => item.page_id === selectedPageId);
    if (pageCandidates.some((item) => item.review_status === "confirmed")) {
      return toast.error("这一页已有题目确认入库，不能重新识别。");
    }
    setSaving(true);
    try {
      await apiRequest(`/import/pipeline/pages/${selectedPageId}/process`, { method: "POST" });
      const next = await refreshTask(detail.task.id);
      const nextCandidate = next.candidates.find((item) => item.page_id === selectedPageId);
      if (nextCandidate) selectCandidate(nextCandidate);
      toast.success("本页已重新识别，请复核候选题和题号。");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  function updateField(field, value) {
    setEditing((current) => ({ ...current, [field]: value }));
  }

  async function saveAndConfirm() {
    if (!selected || !editing?.stem_text.trim()) return toast.error("题干不能为空。");
    setSaving(true);
    try {
      await apiRequest(`/import/pipeline/candidates/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...editing, question_number: Number(editing.question_number) })
      });
      await apiRequest(`/import/pipeline/candidates/${selected.id}/confirm`, { method: "POST" });
      const next = await refreshTask(detail.task.id);
      const nextCandidate = next.candidates.find((item) => !["confirmed", "rejected"].includes(item.review_status));
      if (nextCandidate) selectCandidate(nextCandidate);
      else {
        setSelectedId(null);
        setEditing(null);
      }
      toast.success("题目已确认并加入题库");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function rejectCandidate() {
    if (!selected) return;
    setSaving(true);
    try {
      await apiRequest(`/import/pipeline/candidates/${selected.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ review_notes: "人工判定为非独立题目" })
      });
      const next = await refreshTask(detail.task.id);
      const nextCandidate = next.candidates.find((item) => !["confirmed", "rejected"].includes(item.review_status));
      if (nextCandidate) selectCandidate(nextCandidate);
      else {
        setSelectedId(null);
        setEditing(null);
      }
      toast.success("已排除该候选");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmAll() {
    const ready = unsettled.filter((item) => item.stem_text?.trim());
    if (!ready.length) return;
    setSaving(true);
    try {
      const result = await apiRequest("/import/pipeline/candidates/batch-confirm", {
        method: "POST",
        body: JSON.stringify({ candidate_ids: ready.map((item) => item.id) })
      });
      const failures = result.results.filter((item) => item.status === "failed");
      await refreshTask(detail.task.id);
      setSelectedId(null);
      setEditing(null);
      if (failures.length) toast.warning(`${failures.length} 道题确认失败，请逐题检查。`);
      else toast.success("候选题目已全部确认入库");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetImport() {
    if (detail?.task?.id && confirmedCount === 0) {
      try {
        await apiRequest(`/import/pipeline/tasks/${detail.task.id}`, { method: "DELETE" });
      } catch (error) {
        toast.error(error.message);
        return;
      }
    }
    setState("upload");
    setFile(null);
    setDetail(null);
    setSelectedId(null);
    setEditing(null);
  }

  if (state === "upload") {
    return (
      <div className="page-stack"><section className="import-upload">
        <div className="section-heading"><div><p className="eyebrow">PDF Import</p><h1>导入试卷</h1></div><button className="text-button" onClick={() => navigate("/library")}>返回题库</button></div>
        <div className={`pdf-dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]); }}>
          <strong>{file ? file.name : "把 PDF 拖到这里"}</strong>
          <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "AI 将逐页识别并拆分独立题目"}</span>
          <label className="file-button">选择 PDF<input type="file" accept="application/pdf,.pdf" onChange={(event) => chooseFile(event.target.files?.[0])} /></label>
        </div>
        <div className="import-fields">
          <label>题库名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}>{Object.keys(subjectTags).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>年份<input type="number" value={year} onChange={(event) => setYear(Number(event.target.value))} /></label>
        </div>
        <div className="import-actions"><button className="primary" disabled={!file || !title.trim()} onClick={startUpload}>导入并识别题目</button></div>
      </section></div>
    );
  }

  if (state === "parsing") {
    return (
      <div className="page-stack"><section className="import-parsing">
        <div className="parsing-spinner" /><h1>正在解析 PDF</h1><p>{parseProgress}</p>
        <div className="parsing-steps"><div className="parsing-step active"><span>1</span><span>上传文件</span></div><div className="parsing-step active"><span>2</span><span>渲染页面</span></div><div className="parsing-step active"><span>3</span><span>逐题识别</span></div><div className="parsing-step"><span>4</span><span>人工校对</span></div></div>
      </section></div>
    );
  }

  if (state === "failed") {
    return (
      <div className="page-stack"><section className="import-failed">
        <div className="failed-icon">!</div><h1>导入未完成</h1><p>可以检查 PDF 清晰度与 AI 服务配置后重新上传。</p>
        <div className="form-actions"><button className="primary" onClick={resetImport}>重新上传</button><button className="text-button" onClick={() => navigate("/library")}>返回题库</button></div>
      </section></div>
    );
  }

  if (state === "completed") {
    return (
      <div className="page-stack"><section className="import-completed">
        <div className="completed-icon">✓</div><h1>导入完成</h1>
        <p>“{detail?.task.title}”已加入题库，共确认 {confirmedCount} 道独立题目。</p>
        <div className="completed-stats"><div><strong>{detail?.task.total_pages}</strong><span>页</span></div><div><strong>{confirmedCount}</strong><span>题</span></div><div><strong>{detail?.task.subject}</strong><span>学科</span></div></div>
        <div className="form-actions"><button className="primary" onClick={() => navigate("/library")}>查看题库</button><button className="text-button" onClick={resetImport}>继续导入</button></div>
      </section></div>
    );
  }

  return (
    <div className="page-stack">
      <section className="import-review-header">
        <div className="section-heading"><div><p className="eyebrow">Review & Confirm</p><h1>{detail?.task.title}</h1><p>{detail?.task.total_pages} 页 · 识别 {detail?.candidates.length} 题 · {detail?.task.subject}</p></div><button className="text-button" onClick={() => navigate("/library")}>稍后继续</button></div>
        {detail?.integrity?.missing_question_numbers?.length > 0 && <p className="error">检测到可能漏识别的题号：第 {detail.integrity.missing_question_numbers.join("、")} 题。请选择对应页面后重新识别，或在校对时手动补充。</p>}
        <div className="review-progress"><div className="progress-info"><span>已处理 <strong>{settledCount}</strong> 题</span><span>待校对 <strong>{unsettled.length}</strong> 题</span></div><div className="progress-bar"><span style={{ width: `${detail?.candidates.length ? settledCount / detail.candidates.length * 100 : 0}%` }} /></div></div>
      </section>

      <section className="import-review-layout">
        <aside className="review-sidebar">
          <div className="page-thumbnails"><p className="eyebrow">Pages</p><div className="thumbnail-grid">{detail?.pages.map((page) => <button key={page.id} className="page-thumbnail" onClick={() => { setSelectedPageId(page.id); const item = detail.candidates.find((candidate) => candidate.page_id === page.id); if (item) selectCandidate(item); }}><img src={page.image_url} alt={`第 ${page.page_number} 页`} /><span>{page.page_number}</span></button>)}</div>{selectedPageId && <button className="ghost" disabled={saving} onClick={reprocessSelectedPage}>重新识别本页</button>}</div>
          <div className="question-list"><div className="list-header"><span>题目列表</span><button className="text-button" disabled={saving || !unsettled.length} onClick={confirmAll}>全部确认</button></div><div className="list-items">{detail?.candidates.map((candidate) => <button key={candidate.id} className={`question-item ${selectedId === candidate.id ? "active" : ""} ${candidate.review_status === "confirmed" ? "confirmed" : ""}`} onClick={() => selectCandidate(candidate)}><span className="question-num">{String(candidate.question_number || "?").padStart(2, "0")}</span><span className="question-type">{questionTypeLabel(candidate.question_type)}</span><span className={`confidence ${(candidate.recognition_confidence || 0) >= .9 ? "high" : (candidate.recognition_confidence || 0) >= .8 ? "medium" : "low"}`}>{Math.round((candidate.recognition_confidence || 0) * 100)}%</span>{candidate.review_status === "confirmed" && <span className="confirmed-badge">✓</span>}{candidate.review_status === "rejected" && <span className="rejected-badge">排除</span>}</button>)}</div></div>
        </aside>

        <div className="review-main">
          {!selected ? <div className="review-empty-state"><p>{unsettled.length ? "选择一道题目查看并校对" : "所有候选都已处理"}</p><p className="hint">置信度低于 85% 的题目需要重点检查</p></div> : (
            <div className="question-review-card">
              <div className="review-card-header"><div><span className="question-badge">第 {editing?.question_number} 题</span><span className="type-badge">{questionTypeLabel(editing?.question_type)}</span><span className={`confidence-badge ${(selected.recognition_confidence || 0) >= .9 ? "high" : (selected.recognition_confidence || 0) >= .8 ? "medium" : "low"}`}>置信度 {Math.round((selected.recognition_confidence || 0) * 100)}%</span></div><button className="text-button" onClick={() => { setSelectedId(null); setEditing(null); }}>关闭</button></div>
              <div className="review-image-section"><img src={selected.crop_image_url || pageById.get(selected.page_id)?.image_url} alt={`原卷第 ${selected.page_number} 页`} /></div>
              <div className="review-form">
                <label>题目内容<textarea rows="8" value={editing?.stem_text || ""} onChange={(event) => updateField("stem_text", event.target.value)} /></label>
                <div className="review-form-row"><label>题号<input type="number" value={editing?.question_number || ""} onChange={(event) => updateField("question_number", Number(event.target.value))} /></label><label>题型<select value={editing?.question_type || "choice"} onChange={(event) => updateField("question_type", event.target.value)}>{questionTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label></div>
                <label>参考答案<textarea rows="4" value={editing?.reference_answer_text || ""} onChange={(event) => updateField("reference_answer_text", event.target.value)} /></label>
                <label>知识点标签<div className="tag-editor"><div>{editing?.knowledge_tags.map((tag) => <span key={tag} className="tag-item">{tag}<button type="button" onClick={() => updateField("knowledge_tags", editing.knowledge_tags.filter((item) => item !== tag))}>×</button></span>)}</div><div className="tag-suggestions">{subjectTags[subject].filter((tag) => !editing?.knowledge_tags.includes(tag)).slice(0, 8).map((tag) => <button type="button" key={tag} onClick={() => updateField("knowledge_tags", [...editing.knowledge_tags, tag])}>{tag}</button>)}</div></div></label>
              </div>
              <div className="review-actions"><button className="ghost" disabled={saving} onClick={rejectCandidate}>不是独立题目</button><button className="primary" disabled={saving || !editing?.stem_text.trim()} onClick={saveAndConfirm}>{saving ? "正在保存..." : "保存并确认入库"}</button></div>
            </div>
          )}
        </div>

        <div className="review-footer"><button className="text-button" onClick={resetImport}>重新上传</button><button className="primary" disabled={unsettled.length > 0 || confirmedCount === 0} onClick={() => setState("completed")}>完成导入</button></div>
      </section>
    </div>
  );
}
