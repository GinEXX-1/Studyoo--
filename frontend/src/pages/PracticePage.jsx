import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { MathText } from "../components/MathText.jsx";
import MathKeyboard from "../components/MathKeyboard.jsx";
import { apiEventStream, apiRequest, trackEvent } from "../lib/api.js";

export default function PracticePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [detail, setDetail] = useState(null);
  const [gradingMode, setGradingMode] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [index, setIndex] = useState(0);
  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [attempts, setAttempts] = useState({});
  const [answerText, setAnswerText] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [loading, setLoading] = useState("");
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 });
  const [followContext, setFollowContext] = useState(null);
  const [followQuestion, setFollowQuestion] = useState("");
  const [followMessages, setFollowMessages] = useState([]);
  const [correction, setCorrection] = useState(null);
  const [correctionNote, setCorrectionNote] = useState("");
  const [redoMode, setRedoMode] = useState(false);
  const [previousAttempt, setPreviousAttempt] = useState(null);
  const [streamingFeedback, setStreamingFeedback] = useState("");
  const reviewRef = useRef(null);
  const questionContentRef = useRef(null);
  const answerRef = useRef(null);

  useEffect(() => {
    apiRequest(`/collections/${id}`).then(setDetail).catch((error) => toast.error(error.message));
    trackEvent("practice_opened", { collection_id: id });
  }, [id]);

  const current = detail?.questions[index];
  const practiceQuestionId = current ? `practice-${current.id}` : null;

  useEffect(() => {
    if (!current || !gradingMode) return;
    setLoading("question");
    setAnswerText(answers[current.id] || "");
    setShowOriginal(false);
    setShowReview(Boolean(attempts[`practice-${current.id}`]));
    setFollowContext(null);
    setFollowMessages([]);
    setRedoMode(false);
    setPreviousAttempt(null);
    setCorrectionNote("");
    apiRequest(`/practice/questions/practice-${current.id}`)
      .then((result) => {
        setData({ ...result, latest_attempt: attempts[`practice-${current.id}`] || null });
        setCorrection(result.correction || null);
      })
      .catch((error) => toast.error(error.message))
      .finally(() => setLoading(""));
  }, [current?.id, gradingMode]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [index]);

  async function startPractice(mode) {
    setLoading("session");
    try {
      const session = await apiRequest(`/collections/${id}/sessions`, {
        method: "POST",
        body: JSON.stringify({ grading_mode: mode })
      });
      setSessionId(session.id);
      setGradingMode(mode);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading("");
    }
  }

  async function gradeQuestion(questionId, value, redoOfAttemptId) {
    return apiRequest(`/practice/questions/${questionId}/attempt`, {
      method: "POST",
      body: JSON.stringify({
        answer_text: value,
        session_id: sessionId,
        ...(redoOfAttemptId ? { redo_of_attempt_id: redoOfAttemptId } : {})
      })
    });
  }

  async function prepareStreamedEvaluation(questionId, value) {
    setStreamingFeedback("正在理解你的作答…");
    await apiEventStream(`/practice/questions/${questionId}/attempt/stream`, {
      method: "POST",
      body: JSON.stringify({ answer_text: value })
    }, (event, payload) => {
      if (event === "feedback" && payload.text) setStreamingFeedback(payload.text);
    });
  }

  // ——— 重做机制 ———
  async function markCorrected(startNow) {
    if (!data?.question) return;
    setLoading("correction");
    try {
      const result = await apiRequest(`/practice/questions/${data.question.id}/corrections`, {
        method: "POST",
        body: JSON.stringify({ note: correctionNote.trim() || undefined })
      });
      setCorrection(result);
      if (startNow) {
        await enterRedo();
      } else {
        toast.success("已记录订正。建议 30 分钟后回来重做这道题。");
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading("");
    }
  }

  async function enterRedo() {
    if (!data?.question) return;
    setLoading("question");
    try {
      const result = await apiRequest(`/practice/questions/${data.question.id}?mode=redo`);
      setData({ question: result.question, latest_attempt: null });
      setCorrection(result.correction || null);
      setRedoMode(true);
      setShowReview(false);
      setAnswerText("");
      setPreviousAttempt(null);
      window.scrollTo({ top: 0, behavior: "auto" });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading("");
    }
  }

  async function submitRedo() {
    const parentId = attempts[data.question.id]?.id || data?.latest_attempt?.id;
    setLoading("attempt");
    try {
      const result = await gradeQuestion(data.question.id, answerText, parentId);
      setAttempts((items) => ({ ...items, [data.question.id]: result.attempt }));
      setData({ question: result.question, latest_attempt: result.attempt });
      setCorrection(result.correction || null);
      setPreviousAttempt(result.previous_attempt || null);
      setRedoMode(false);
      setShowReview(true);
      queryClient.invalidateQueries({ queryKey: ["profile-stats"] });
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading("");
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!data?.question || !answerText.trim()) return;
    if (redoMode) {
      await submitRedo();
      return;
    }
    const nextAnswers = { ...answers, [current.id]: answerText.trim() };
    setAnswers(nextAnswers);

    if (gradingMode === "unified") {
      if (index + 1 < detail.questions.length) {
        setIndex((value) => value + 1);
        setData(null);
        return;
      }
      await gradeAll(nextAnswers);
      return;
    }

    setLoading("attempt");
    try {
      try {
        await prepareStreamedEvaluation(data.question.id, answerText);
      } catch {
        // 弱网、代理不支持 SSE 或流式模型失败时，原同步接口继续完成评阅。
      }
      const result = await gradeQuestion(data.question.id, answerText);
      setAttempts((items) => ({ ...items, [data.question.id]: result.attempt }));
      setData({ question: result.question, latest_attempt: result.attempt });
      setCorrection(result.correction || null);
      setShowReview(true);
      if (result.cached) toast.success("已从 AI 记忆读取评阅");
      queryClient.invalidateQueries({ queryKey: ["profile-stats"] });
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setStreamingFeedback("");
      setLoading("");
    }
  }

  async function gradeAll(finalAnswers) {
    setLoading("batch");
    setBatchProgress({ done: 0, total: detail.questions.length });
    const nextAttempts = {};
    try {
      for (let questionIndex = 0; questionIndex < detail.questions.length; questionIndex++) {
        const item = detail.questions[questionIndex];
        const result = await gradeQuestion(`practice-${item.id}`, finalAnswers[item.id]);
        nextAttempts[`practice-${item.id}`] = result.attempt;
        setBatchProgress({ done: questionIndex + 1, total: detail.questions.length });
      }
      setAttempts(nextAttempts);
      setIndex(0);
      const first = detail.questions[0];
      const firstData = await apiRequest(`/practice/questions/practice-${first.id}`);
      setData({ question: firstData.question, latest_attempt: nextAttempts[`practice-${first.id}`] });
      setShowReview(true);
      queryClient.invalidateQueries({ queryKey: ["profile-stats"] });
      toast.success("整套题已完成统一批改");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading("");
    }
  }

  async function next() {
    if (index + 1 >= detail.questions.length) {
      try {
        if (sessionId) await apiRequest(`/practice/sessions/${sessionId}/complete`, { method: "PATCH" });
      } catch (error) {
        toast.error(error.message);
      } finally {
        queryClient.invalidateQueries({ queryKey: ["profile-stats", "collections"] });
        navigate("/library");
      }
      return;
    }
    setIndex((value) => value + 1);
    setData(null);
  }

  function previous() {
    if (index === 0) return;
    setAnswers((items) => ({ ...items, [current.id]: answerText }));
    setIndex((value) => value - 1);
    setData(null);
  }

  function openFollowUp(contextType, contextText) {
    setFollowContext({ type: contextType, text: contextText || "" });
    setFollowQuestion("");
  }

  function captureQuestionSelection() {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selectedText || !questionContentRef.current?.contains(selection.anchorNode)) return;
    openFollowUp("question", selectedText.slice(0, 1000));
  }

  async function askFollowUp(event) {
    event.preventDefault();
    if (!followQuestion.trim() || !data?.question) return;
    setLoading("follow-up");
    const questionText = followQuestion.trim();
    try {
      const reply = await apiRequest(`/practice/questions/${data.question.id}/follow-up`, {
        method: "POST",
        body: JSON.stringify({
          content_text: questionText,
          attempt_id: attempt?.id,
          context_type: followContext?.type,
          context_text: followContext?.text
        })
      });
      setFollowMessages((items) => [...items, { question: questionText, answer: reply.reply_text }]);
      setFollowQuestion("");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading("");
    }
  }

  const question = data?.question;
  const attempt = data?.latest_attempt || (practiceQuestionId ? attempts[practiceQuestionId] : null);
  const progress = detail ? Math.round((index + 1) / detail.questions.length * 100) : 0;

  if (detail && !gradingMode) {
    return <main className="practice-page-mobile"><header className="practice-header-mobile"><button className="text-button" onClick={() => navigate("/library")}>返回</button><div className="header-center"><strong>{detail.collection.title}</strong><span>{detail.questions.length} 题</span></div></header><div className="practice-content"><section className="grading-mode-panel"><h1>选择批改模式</h1><div className="grading-mode-options"><button disabled={loading === "session"} onClick={() => startPractice("individual")}><strong>单独批改</strong><span>每完成一题立即查看评阅</span></button><button disabled={loading === "session"} onClick={() => startPractice("unified")}><strong>统一批改</strong><span>完成整套题后集中查看结果</span></button></div></section></div></main>;
  }

  return (
    <main className="practice-page-mobile">
      <header className="practice-header-mobile">
        <button className="text-button" onClick={() => navigate("/library")}>返回</button>
        <div className="header-center"><strong>{detail?.collection.title || "加载中"}</strong><span>{index + 1} / {detail?.questions.length || 0} · {gradingMode === "unified" ? "统一批改" : "单独批改"}</span></div>
        {index > 0 && !showReview && <button className="text-button" onClick={previous}>上一题</button>}
        <div className="progress-track-mobile"><span style={{ width: `${progress}%` }} /></div>
      </header>

      <div className="practice-content">
        {loading === "batch" && <section className="batch-grading"><strong>正在统一批改 {batchProgress.done} / {batchProgress.total}</strong><div className="progress-bar"><span style={{ width: `${batchProgress.total ? batchProgress.done / batchProgress.total * 100 : 0}%` }} /></div></section>}
        {loading === "question" && <div className="loading-card"><div className="loading-spinner" /><p>正在加载题目...</p></div>}

        {question && loading !== "batch" && <>
          {redoMode && <div className="redo-banner"><strong>重做模式</strong><span>上次作答与参考答案已隐藏，独立完成后再对比。</span></div>}
          <div className="question-card">
            <div className="question-meta"><span className="question-num">第 {current.question_number} 题</span><span className="question-type">{current.question_type}</span><div className="question-tags">{question.knowledge_tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div>
            <h1 className="question-title">{question.title}</h1>
            <div ref={questionContentRef} className="question-content selectable-question" onMouseUp={captureQuestionSelection}><MathText text={question.content_text} /></div>
            {followContext?.type === "question" && <button className="context-follow-button" onClick={() => openFollowUp("question", followContext.text)}>追问选中内容</button>}
            {question.has_figure && question.content_image_url && <figure className="question-figure"><img src={question.content_image_url} alt={`第 ${current.question_number} 题原图`} /><figcaption>本题含图形，请对照上图作答</figcaption></figure>}
            {question.content_image_url && !question.has_figure && <div className="original-paper-mobile"><button className="ghost" onClick={() => setShowOriginal((value) => !value)}>{showOriginal ? "收起原卷" : "查看原卷"}</button>{showOriginal && <div className="paper-image-wrapper"><img src={question.content_image_url} alt={`原卷第 ${current.page_number || ""} 页`} /></div>}</div>}
          </div>

          {!showReview ? <div className="answer-card"><h2>我的作答</h2><form onSubmit={submit}><MathKeyboard targetRef={answerRef} value={answerText} onChange={setAnswerText} /><textarea ref={answerRef} rows="8" value={answerText} onChange={(event) => setAnswerText(event.target.value)} placeholder="写下思路、步骤和答案。数学符号点上方按钮插入，公式写在 $…$ 之间。" />{answerText.includes("$") && <div className="answer-preview"><span className="answer-preview-label">公式预览</span><MathText text={answerText} /></div>}{loading === "attempt" && !redoMode && streamingFeedback && <div className="streaming-feedback" aria-live="polite"><span>AI 正在评阅</span><MathText text={streamingFeedback} /></div>}<button className="primary" disabled={!answerText.trim() || loading === "attempt"}>{loading === "attempt" ? (redoMode ? "AI 对比评阅中..." : "AI 评阅中...") : redoMode ? "提交重做" : gradingMode === "unified" && index + 1 < detail.questions.length ? "保存并继续" : gradingMode === "unified" ? "提交整套题" : "提交作答"}</button></form></div> :
            <div ref={reviewRef} className="review-card"><div className="review-title-row"><h2>{attempt?.is_redo ? "重做评阅" : "评阅结果"}</h2>{attempt?.from_cache && <span className="memory-badge">AI 记忆</span>}</div>{attempt && <>{attempt.is_redo && previousAttempt ? <div className="redo-compare"><div className="redo-compare-scores"><div><small>上次</small><strong>{previousAttempt.score}</strong></div><span className="redo-arrow">→</span><div><small>这次</small><strong className={attempt.is_correct ? "correct" : "wrong"}>{attempt.score}</strong></div><span className={`score-status ${attempt.is_correct ? "correct" : "wrong"}`}>{attempt.is_correct ? "重做通过" : "仍需订正"}</span></div>{attempt.progress_note && <div className="progress-note"><small>进步对比</small><MathText text={attempt.progress_note} /></div>}</div> : <div className="score-section"><strong className="score-value">{attempt.score}</strong><span className={`score-status ${attempt.is_correct ? "correct" : "wrong"}`}>{attempt.is_correct ? "基本掌握" : "需要订正"}</span></div>}<div className="feedback-section"><MathText text={attempt.feedback_text} /><button className="text-button" onClick={() => openFollowUp("feedback", attempt.feedback_text)}>追问</button></div>{attempt.step_breakdown?.map((step) => <div key={step.step_number} className="step-card"><span className="step-number">{step.step_number}</span><div><MathText text={step.explanation} /><button className="text-button" onClick={() => openFollowUp("step", step.explanation)}>追问这一步</button></div></div>)}<div className="next-action-card">{attempt.next_action}</div>{!attempt.is_correct && <div className="correction-panel">{correction?.correction_status === "redo_pending" ? <><p className="correction-hint">已记录订正。{correction.redo_available_at && new Date(correction.redo_available_at) > new Date() ? "建议 30 分钟后重做（间隔效应记得更牢），也可以立即开始。" : "现在可以重做验证了。"}</p><button className="primary" disabled={loading === "question"} onClick={enterRedo}>开始重做（隐藏上次作答）</button></> : <>{(correction?.redo_count || 0) >= 3 && <p className="correction-hint warning">这道题已重做 {correction.redo_count} 次仍未通过，建议先到「解析」入口把关键步骤逐步拆开，再回来重做。</p>}<p className="correction-hint">看懂反馈后，用一句话记下你订正的理解，然后合上解析重做一遍：</p><textarea className="correction-note" rows="2" value={correctionNote} onChange={(event) => setCorrectionNote(event.target.value)} placeholder="例：应取第 3 个数而不是平均值（选填）" /><div className="correction-actions"><button className="primary" disabled={loading === "correction"} onClick={() => markCorrected(false)}>我已订正，稍后重做</button><button className="ghost" disabled={loading === "correction"} onClick={() => markCorrected(true)}>立即重做</button></div></>}</div>}{question.official_answer_text && !question.official_answer_text.startsWith("原 PDF 未附") && <div className="reference-answer-mobile"><strong>参考答案</strong><MathText text={question.official_answer_text} /><button className="text-button" onClick={() => openFollowUp("answer", question.official_answer_text)}>追问答案</button></div>}<div className="review-actions"><button className="ghost" onClick={() => openFollowUp("analysis", attempt.feedback_text)}>继续追问</button><button className="primary" onClick={next}>{index + 1 >= detail.questions.length ? "完成这套题" : "下一题"}</button></div></>}</div>}

          {followContext && <section className="follow-up-panel"><div className="follow-up-heading"><strong>追问</strong><button className="text-button" onClick={() => setFollowContext(null)}>关闭</button></div>{followContext.text && <blockquote><MathText text={followContext.text} /></blockquote>}{followMessages.map((message, messageIndex) => <div className="follow-up-message" key={messageIndex}><p>{message.question}</p><MathText text={message.answer} /></div>)}<form onSubmit={askFollowUp}><textarea rows="3" value={followQuestion} onChange={(event) => setFollowQuestion(event.target.value)} placeholder="具体说说哪里没有理解" /><button className="primary" disabled={!followQuestion.trim() || loading === "follow-up"}>{loading === "follow-up" ? "思考中..." : "发送追问"}</button></form></section>}
        </>}
      </div>
    </main>
  );
}
