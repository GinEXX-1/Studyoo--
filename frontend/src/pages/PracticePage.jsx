import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/api.js";
import { useParams, useNavigate } from "react-router-dom";
import { MathText } from "../components/MathText.jsx";
import { toast } from "sonner";

export default function PracticePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [detail, setDetail] = useState(null);
  const [index, setIndex] = useState(0);
  const [data, setData] = useState(null);
  const [answerText, setAnswerText] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [loading, setLoading] = useState("");
  const [showReview, setShowReview] = useState(false);
  const reviewRef = useRef(null);

  useEffect(() => {
    Promise.all([
      apiRequest(`/collections/${id}`),
      apiRequest(`/collections/${id}/sessions`, { method: "POST" })
    ]).then(([collection]) => setDetail(collection)).catch((err) => toast.error(err.message));
  }, [id]);

  const current = detail?.questions[index];
  useEffect(() => {
    if (!current) return;
    setLoading("question");
    setAnswerText("");
    setShowOriginal(false);
    setShowReview(false);
    apiRequest(`/practice/questions/practice-${current.id}`)
      .then(setData)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(""));
  }, [current?.id]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [index]);

  async function submit(event) {
    event.preventDefault();
    if (!data?.question) return;
    setLoading("attempt");
    try {
      const result = await apiRequest(`/practice/questions/${data.question.id}/attempt`, { method: "POST", body: JSON.stringify({ answer_text: answerText }) });
      setData({ question: result.question, latest_attempt: result.attempt });
      queryClient.invalidateQueries({ queryKey: ["profile-stats"] });
      setShowReview(true);
      setTimeout(() => {
        reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading("");
    }
  }

  function next() {
    if (index + 1 >= detail.questions.length) {
      queryClient.invalidateQueries({ queryKey: ["profile-stats", "collections"] });
      return navigate("/library");
    }
    setIndex((value) => value + 1);
    setData(null);
    setShowReview(false);
  }

  const question = data?.question;
  const attempt = data?.latest_attempt;
  const progress = detail ? Math.round((index + 1) / detail.questions.length * 100) : 0;

  return (
    <main className="practice-page-mobile">
      <header className="practice-header-mobile">
        <button className="text-button" onClick={() => navigate("/library")}>返回</button>
        <div className="header-center">
          <strong>{detail?.collection.title || "加载中"}</strong>
          <span>{index + 1} / {detail?.questions.length || 0}</span>
        </div>
        <div className="progress-track-mobile">
          <span style={{ width: `${progress}%` }} />
        </div>
      </header>

      <div className="practice-content">
        {loading === "question" && (
          <div className="loading-card">
            <div className="loading-spinner" />
            <p>正在加载题目...</p>
          </div>
        )}

        {question && (
          <>
            <div className="question-card">
              <div className="question-meta">
                <span className="question-num">第 {current.question_number} 题</span>
                <span className="question-type">{current.question_type}</span>
                <div className="question-tags">
                  {question.knowledge_tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              </div>
              <h1 className="question-title">{question.title}</h1>
              <div className="question-content">
                <MathText text={question.content_text} />
              </div>
              {question.content_image_url && (
                <div className="original-paper-mobile">
                  <button className="ghost" onClick={() => setShowOriginal((value) => !value)}>
                    {showOriginal ? "收起原卷" : "查看原卷"}
                  </button>
                  {showOriginal && (
                    <div className="paper-image-wrapper">
                      <img src={question.content_image_url} alt={`原卷第 ${current.page_number || ""} 页`} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {!showReview ? (
              <div className="answer-card">
                <h2>我的作答</h2>
                <form onSubmit={submit}>
                  <textarea
                    rows="8"
                    value={answerText}
                    onChange={(event) => setAnswerText(event.target.value)}
                    placeholder="写下思路、步骤和答案。选择题也请说明判断依据。"
                  />
                  <button className="primary" disabled={!answerText.trim() || loading === "attempt"}>
                    {loading === "attempt" ? "AI 评阅中..." : "提交作答"}
                  </button>
                </form>
              </div>
            ) : (
              <div ref={reviewRef} className="review-card">
                <h2>评阅结果</h2>
                {attempt ? (
                  <>
                    <div className="score-section">
                      <strong className="score-value">{attempt.score}</strong>
                      <span className={`score-status ${attempt.is_correct ? "correct" : "wrong"}`}>
                        {attempt.is_correct ? "基本掌握" : "需要订正"}
                      </span>
                    </div>
                    <div className="feedback-section">
                      <MathText text={attempt.feedback_text} />
                    </div>
                    {attempt.step_breakdown?.map((step) => (
                      <div key={step.step_number} className="step-card">
                        <span className="step-number">{step.step_number}</span>
                        <MathText text={step.explanation} />
                      </div>
                    ))}
                    <div className="next-action-card">
                      {attempt.next_action}
                    </div>
                    {question.official_answer_text && !question.official_answer_text.startsWith("原 PDF 未附") && (
                      <div className="reference-answer-mobile">
                        <strong>参考答案</strong>
                        <MathText text={question.official_answer_text} />
                      </div>
                    )}
                    <div className="review-actions">
                      <button className="primary" onClick={next}>
                        {index + 1 >= detail.questions.length ? "完成这套题" : "下一题"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="review-empty">
                    <p>提交后，这里会出现得分、关键步骤与下一步建议。</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}