import { useMemo, useRef, useState } from "react";
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
  const [parsePercent, setParsePercent] = useState(0);
  const [creating, setCreating] = useState(false);
  const [splitParts, setSplitParts] = useState(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [selection, setSelection] = useState(null);
  const [selectionStart, setSelectionStart] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const imageRef = useRef(null);

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
      setParsePercent(5);
      setParseProgress("正在上传并渲染试卷页面");
      const dataBase64 = await readBase64(file);
      setParsePercent(12);
      const uploaded = await apiRequest("/import/pipeline/upload", {
        method: "POST",
        body: JSON.stringify({ file_name: file.name, data_base64: dataBase64, title, subject, year })
      });
      setDetail({ task: uploaded.task, pages: uploaded.pages, candidates: [] });
      setParsePercent(20);
      setParseProgress("正在检查 PDF 文字层");
      let processed = await apiRequest(`/import/pipeline/tasks/${uploaded.task.id}/process-all?prefer_text_only=1`, { method: "POST" });

      if (processed.mode === "vision_required") {
        const results = [];
        const pages = [...uploaded.pages].sort((left, right) => left.page_number - right.page_number);
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
          const page = pages[pageIndex];
          setParseProgress(`正在识别第 ${pageIndex + 1} / ${pages.length} 页`);
          try {
            const result = await apiRequest(`/import/pipeline/pages/${page.id}/process`, { method: "POST" });
            results.push({ page_number: page.page_number, status: "processed", question_count: result.candidates?.length || 0 });
          } catch (error) {
            results.push({ page_number: page.page_number, status: "failed", error: error.message });
          }
          setParsePercent(20 + Math.round((pageIndex + 1) / pages.length * 75));
        }
        processed = { mode: "vision", results, processed: results.filter((item) => item.status === "processed").length, total: pages.length };
      } else {
        setParsePercent(95);
        setParseProgress(`已快速拆分 ${processed.processed || uploaded.task.total_pages} 页`);
      }

      const next = await refreshTask(uploaded.task.id, true);
      setParsePercent(100);
      const failedPages = processed.results?.filter((item) => item.status === "failed").length || 0;
      if (!next.candidates.length) {
        throw new Error(failedPages ? "页面识别失败，请检查 AI 配置后重试。" : "没有识别出独立题目，请尝试更清晰的试卷 PDF。");
      }
      if (failedPages) toast.warning(`${failedPages} 页识别失败，其余页面可以继续校对。`);
      else if (processed.mode === "pdf_text") toast.success("已完成题号切分和答案关联");
      setState("reviewing");
    } catch (error) {
      toast.error(error.message);
      setState("failed");
    }
  }

  function selectCandidate(candidate) {
    setCreating(false);
    setSplitParts(null);
    setMergeTargetId("");
    setSelection(null);
    setSelectedId(candidate.id);
    setSelectedPageId(candidate.page_id);
    setEditing({
      question_number: candidate.question_number,
      stem_text: candidate.stem_text || "",
      reference_answer_text: candidate.reference_answer_text || "",
      question_type: candidate.question_type || "choice",
      difficulty: candidate.difficulty || "medium",
      knowledge_tags: candidate.knowledge_tags || [],
      options: candidate.options || [],
      has_figure: Boolean(candidate.has_figure)
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

  function beginAddCandidate() {
    const pageId = selectedPageId || detail?.pages?.[0]?.id;
    if (!pageId) return toast.error("请先选择题目所在页面。");
    const suggestedNumber = detail?.integrity?.missing_question_numbers?.[0]
      || Math.max(0, ...detail.candidates.map((item) => Number(item.question_number) || 0)) + 1;
    setSelectedPageId(pageId);
    setSelectedId(null);
    setCreating(true);
    setSplitParts(null);
    setSelection(null);
    setEditing({ question_number: suggestedNumber, stem_text: "", reference_answer_text: "", question_type: "choice", difficulty: "medium", knowledge_tags: [], options: [], has_figure: false });
  }

  async function saveNewCandidate() {
    if (!selectedPageId || !editing?.stem_text.trim()) return toast.error("请填写题目内容。");
    setSaving(true);
    try {
      const created = await apiRequest(`/import/pipeline/pages/${selectedPageId}/candidates`, {
        method: "POST",
        body: JSON.stringify({ ...editing, crop_bbox_json: selection })
      });
      const next = await refreshTask(detail.task.id);
      const nextCandidate = next.candidates.find((item) => item.id === created.id);
      if (nextCandidate) selectCandidate(nextCandidate);
      toast.success("漏题已补入校对列表");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  function imagePoint(event) {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image?.naturalHeight) return null;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    const x = Math.max(0, Math.min(renderedWidth, event.clientX - left));
    const y = Math.max(0, Math.min(renderedHeight, event.clientY - top));
    return { x: x / renderedWidth * 100, y: y / renderedHeight * 100 };
  }

  function startSelection(event) {
    if (!creating) return;
    const point = imagePoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectionStart(point);
    setSelection({ ...point, width: 0, height: 0 });
  }

  function moveSelection(event) {
    if (!creating || !selectionStart) return;
    const point = imagePoint(event);
    if (!point) return;
    setSelection({
      x: Math.min(selectionStart.x, point.x),
      y: Math.min(selectionStart.y, point.y),
      width: Math.abs(point.x - selectionStart.x),
      height: Math.abs(point.y - selectionStart.y)
    });
  }

  function finishSelection() {
    setSelectionStart(null);
    setSelection((current) => current && current.width >= 2 && current.height >= 2 ? current : null);
  }

  function selectionStyle() {
    const image = imageRef.current;
    const container = image?.parentElement;
    if (!selection || !image?.naturalWidth || !image?.naturalHeight || !container) return {};
    const imageRect = image.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const scale = Math.min(imageRect.width / image.naturalWidth, imageRect.height / image.naturalHeight);
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const contentLeft = imageRect.left - containerRect.left + (imageRect.width - renderedWidth) / 2;
    const contentTop = imageRect.top - containerRect.top + (imageRect.height - renderedHeight) / 2;
    return {
      left: contentLeft + selection.x / 100 * renderedWidth,
      top: contentTop + selection.y / 100 * renderedHeight,
      width: selection.width / 100 * renderedWidth,
      height: selection.height / 100 * renderedHeight
    };
  }

  async function reorderCandidate(targetId) {
    if (!draggedId || draggedId === targetId || !detail) return;
    if (confirmedCount > 0) return toast.error("已有题目确认入库，不能整体重排题号。");
    const active = detail.candidates.filter((item) => item.review_status !== "rejected");
    const fromIndex = active.findIndex((item) => item.id === draggedId);
    const toIndex = active.findIndex((item) => item.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const reordered = [...active];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    setDraggedId(null);
    setSaving(true);
    try {
      const result = await apiRequest(`/import/pipeline/tasks/${detail.task.id}/candidates/reorder`, {
        method: "POST",
        body: JSON.stringify({ candidate_ids: reordered.map((item) => item.id) })
      });
      setDetail((current) => ({ ...current, candidates: result.items }));
      const refreshedSelected = result.items.find((item) => item.id === selectedId);
      if (refreshedSelected) selectCandidate(refreshedSelected);
      toast.success("题目顺序和题号已更新");
    } catch (error) {
      toast.error(error.message);
      await refreshTask(detail.task.id);
    } finally {
      setSaving(false);
    }
  }

  function beginSplit() {
    if (!selected) return;
    setSplitParts([
      { question_number: Number(selected.question_number) || 1, stem_text: editing?.stem_text || "" },
      { question_number: (Number(selected.question_number) || 1) + 1, stem_text: "" }
    ]);
  }

  async function saveSplit() {
    if (!selected || splitParts.some((part) => !part.stem_text.trim())) return toast.error("拆分后的每道题都需要填写题目内容。");
    setSaving(true);
    try {
      const result = await apiRequest(`/import/pipeline/candidates/${selected.id}/split`, {
        method: "POST",
        body: JSON.stringify({ parts: splitParts })
      });
      const next = await refreshTask(detail.task.id);
      const nextCandidate = next.candidates.find((item) => item.id === result.items?.[0]?.id);
      if (nextCandidate) selectCandidate(nextCandidate);
      toast.success(`已拆分为 ${result.items.length} 道候选题`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function mergeCandidates() {
    if (!selected || !mergeTargetId) return toast.error("请选择需要合并的另一道题。");
    setSaving(true);
    try {
      const merged = await apiRequest("/import/pipeline/candidates/merge", {
        method: "POST",
        body: JSON.stringify({ candidate_ids: [selected.id, mergeTargetId] })
      });
      const next = await refreshTask(detail.task.id);
      const nextCandidate = next.candidates.find((item) => item.id === merged.id);
      if (nextCandidate) selectCandidate(nextCandidate);
      toast.success("候选题已合并，请复核题干和题号");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
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
    setCreating(false);
    setSplitParts(null);
    setMergeTargetId("");
    setSelection(null);
    setDraggedId(null);
    setParsePercent(0);
    setParseProgress("");
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
          <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "导入后自动拆分独立题目"}</span>
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
        <div className="import-live-progress" role="progressbar" aria-label="PDF 解析进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={parsePercent}><span style={{ width: `${parsePercent}%` }} /></div>
        <strong className="parse-percent">{parsePercent}%</strong>
        <div className="parsing-steps"><div className={`parsing-step ${parsePercent >= 5 ? "active" : ""}`}><span>1</span><span>上传文件</span></div><div className={`parsing-step ${parsePercent >= 12 ? "active" : ""}`}><span>2</span><span>渲染页面</span></div><div className={`parsing-step ${parsePercent >= 20 ? "active" : ""}`}><span>3</span><span>逐题识别</span></div><div className="parsing-step"><span>4</span><span>人工校对</span></div></div>
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
        {detail?.integrity?.missing_question_numbers?.length > 0 && <p className="error">检测到可能漏识别的题号：第 {detail.integrity.missing_question_numbers.join("、")} 题。选择对应页面后点击“补题”，或重新识别该页。</p>}
        {detail?.integrity?.duplicate_question_numbers?.length > 0 && <p className="error">检测到重复题号：第 {detail.integrity.duplicate_question_numbers.join("、")} 题。请检查是否需要合并或调整题号。</p>}
        <div className="review-progress"><div className="progress-info"><span>已处理 <strong>{settledCount}</strong> 题</span><span>待校对 <strong>{unsettled.length}</strong> 题</span></div><div className="progress-bar"><span style={{ width: `${detail?.candidates.length ? settledCount / detail.candidates.length * 100 : 0}%` }} /></div></div>
      </section>

      <section className="import-review-layout">
        <aside className="review-sidebar">
          <div className="page-thumbnails"><p className="eyebrow">Pages</p><div className="thumbnail-grid">{detail?.pages.map((page) => <button key={page.id} className="page-thumbnail" onClick={() => { setSelectedPageId(page.id); const item = detail.candidates.find((candidate) => candidate.page_id === page.id); if (item) selectCandidate(item); }}><img src={page.image_url} alt={`第 ${page.page_number} 页`} /><span>{page.page_number}</span></button>)}</div>{selectedPageId && <button className="ghost" disabled={saving} onClick={reprocessSelectedPage}>重新识别本页</button>}</div>
          <div className="question-list"><div className="list-header"><span>题目列表</span><div><button className="text-button" disabled={saving} onClick={beginAddCandidate}>补题</button><button className="text-button" disabled={saving || !unsettled.length} onClick={confirmAll}>全部确认</button></div></div><div className="list-items">{detail?.candidates.map((candidate) => <button key={candidate.id} draggable={confirmedCount === 0 && candidate.review_status !== "rejected"} onDragStart={() => setDraggedId(candidate.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => { if (draggedId) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); reorderCandidate(candidate.id); }} className={`question-item ${selectedId === candidate.id ? "active" : ""} ${candidate.review_status === "confirmed" ? "confirmed" : ""} ${draggedId === candidate.id ? "dragging" : ""}`} onClick={() => selectCandidate(candidate)}><span className="drag-handle" aria-hidden="true">⋮⋮</span><span className="question-num">{String(candidate.question_number || "?").padStart(2, "0")}</span><span className="question-type">{questionTypeLabel(candidate.question_type)}</span><span className={`confidence ${candidate.recognition_confidence == null ? "manual" : candidate.recognition_confidence >= .9 ? "high" : candidate.recognition_confidence >= .8 ? "medium" : "low"}`}>{candidate.recognition_confidence == null ? "人工" : `${Math.round(candidate.recognition_confidence * 100)}%`}</span>{candidate.review_status === "confirmed" && <span className="confirmed-badge">✓</span>}{candidate.review_status === "rejected" && <span className="rejected-badge">排除</span>}</button>)}</div></div>
        </aside>

        <div className="review-main">
          {!selected && !creating ? <div className="review-empty-state"><p>{unsettled.length ? "选择一道题目查看并校对" : "所有候选都已处理"}</p><p className="hint">置信度低于 85% 的题目需要重点检查</p></div> : (
            <div className="question-review-card">
              <div className="review-card-header"><div><span className="question-badge">{creating ? "补录题目" : `第 ${editing?.question_number} 题`}</span>{!creating && <span className="type-badge">{questionTypeLabel(editing?.question_type)}</span>}{selected && <span className={`confidence-badge ${selected.recognition_confidence == null ? "manual" : selected.recognition_confidence >= .9 ? "high" : selected.recognition_confidence >= .8 ? "medium" : "low"}`}>{selected.recognition_confidence == null ? "人工补录" : `置信度 ${Math.round(selected.recognition_confidence * 100)}%`}</span>}</div><button className="text-button" onClick={() => { setSelectedId(null); setCreating(false); setSplitParts(null); setEditing(null); }}>关闭</button></div>
              <div className={`review-image-section ${creating ? "crop-select" : ""}`} onPointerDown={startSelection} onPointerMove={moveSelection} onPointerUp={finishSelection} onPointerCancel={finishSelection}><img ref={imageRef} draggable="false" src={selected?.crop_image_url || pageById.get(selected?.page_id || selectedPageId)?.image_url} alt="原卷页面" />{creating && selection && <span className="crop-selection" style={selectionStyle()} />}</div>
              {splitParts ? <div className="split-editor"><p>分别整理拆分后的题号和题干</p>{splitParts.map((part, index) => <div className="split-part" key={index}><label>题号<input type="number" value={part.question_number} onChange={(event) => setSplitParts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, question_number: Number(event.target.value) } : item))} /></label><label>第 {index + 1} 道题<textarea rows="6" value={part.stem_text} onChange={(event) => setSplitParts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, stem_text: event.target.value } : item))} /></label></div>)}<div className="review-actions"><button className="ghost" onClick={() => setSplitParts(null)}>取消</button><button className="primary" disabled={saving} onClick={saveSplit}>确认拆分</button></div></div> : <><div className="review-form">
                <label>题目内容<textarea rows="8" value={editing?.stem_text || ""} onChange={(event) => updateField("stem_text", event.target.value)} /></label>
                <div className="review-form-row"><label>题号<input type="number" value={editing?.question_number || ""} onChange={(event) => updateField("question_number", Number(event.target.value))} /></label><label>题型<select value={editing?.question_type || "choice"} onChange={(event) => updateField("question_type", event.target.value)}>{questionTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label></div>
                <label className="figure-toggle"><input type="checkbox" checked={Boolean(editing?.has_figure)} onChange={(event) => updateField("has_figure", event.target.checked)} /><span>本题含图形（几何图/函数图像/图表等）——做题时直接展示裁切原图</span></label>
                <label>参考答案<textarea rows="4" value={editing?.reference_answer_text || ""} onChange={(event) => updateField("reference_answer_text", event.target.value)} /></label>
                <label>知识点标签<div className="tag-editor"><div>{editing?.knowledge_tags.map((tag) => <span key={tag} className="tag-item">{tag}<button type="button" onClick={() => updateField("knowledge_tags", editing.knowledge_tags.filter((item) => item !== tag))}>×</button></span>)}</div><div className="tag-suggestions">{subjectTags[subject].filter((tag) => !editing?.knowledge_tags.includes(tag)).slice(0, 8).map((tag) => <button type="button" key={tag} onClick={() => updateField("knowledge_tags", [...editing.knowledge_tags, tag])}>{tag}</button>)}</div></div></label>
              </div>
              {creating ? <div className="review-actions"><button className="ghost" type="button" disabled={!selection} onClick={() => setSelection(null)}>清除框选</button><button className="ghost" onClick={() => { setCreating(false); setSelection(null); setEditing(null); }}>取消</button><button className="primary" disabled={saving || !editing?.stem_text.trim()} onClick={saveNewCandidate}>加入校对列表</button></div> : <><div className="candidate-tools"><button className="ghost" disabled={saving} onClick={beginSplit}>拆分此题</button><select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}><option value="">选择要合并的题目</option>{unsettled.filter((item) => item.id !== selected.id).map((item) => <option key={item.id} value={item.id}>第 {item.question_number} 题 · 第 {item.page_number} 页</option>)}</select><button className="ghost" disabled={saving || !mergeTargetId} onClick={mergeCandidates}>合并</button></div><div className="review-actions"><button className="ghost" disabled={saving} onClick={rejectCandidate}>不是独立题目</button><button className="primary" disabled={saving || !editing?.stem_text.trim()} onClick={saveAndConfirm}>{saving ? "正在保存..." : "保存并确认入库"}</button></div></>}</>}
            </div>
          )}
        </div>

        <div className="review-footer"><button className="text-button" onClick={resetImport}>重新上传</button><button className="primary" disabled={unsettled.length > 0 || confirmedCount === 0} onClick={() => setState("completed")}>完成导入</button></div>
      </section>
    </div>
  );
}
