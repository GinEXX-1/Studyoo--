import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { MathText } from "../components/MathText.jsx";
import { apiRequest } from "../lib/api.js";

export default function ReviewPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState(null);
  const [question, setQuestion] = useState(null);
  const [answerText, setAnswerText] = useState("");
  const [attempt, setAttempt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiRequest(`/review/tasks/${taskId}`)
      .then(async (nextTask) => {
        setTask(nextTask);
        if (!nextTask.review_question_id) throw new Error("这项复习还没有可用题目。");
        const data = await apiRequest(`/practice/questions/${nextTask.review_question_id}`);
        setQuestion(data.question);
      })
      .catch((error) => toast.error(error.message))
      .finally(() => setLoading(false));
  }, [taskId]);

  async function submit(event) {
    event.preventDefault();
    if (!question || !answerText.trim()) return;
    setSubmitting(true);
    try {
      const result = await apiRequest(`/practice/questions/${question.id}/attempt`, {
        method: "POST",
        body: JSON.stringify({ answer_text: answerText, review_task_id: taskId })
      });
      setAttempt(result.attempt);
      await apiRequest(`/review/${taskId}/submit`, {
        method: "POST",
        body: JSON.stringify({
          result: result.attempt.is_correct ? "correct" : result.attempt.score >= 50 ? "partial" : "incorrect",
          score: result.attempt.score,
          feedback_text: result.attempt.feedback_text
        })
      });
      toast.success(result.attempt.is_correct ? "复测通过，后续同组任务已调整" : "复测结果已记录，学习计划会继续跟进");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="loading-card"><div className="loading-spinner" /><p>正在打开复习任务...</p></div>;
  if (!task || !question) return <div className="review-empty-state"><p>这项复习暂时无法打开。</p><button className="text-button" onClick={() => navigate("/profile")}>返回学习路径</button></div>;

  return (
    <main className="practice-page-mobile review-practice-page">
      <header className="practice-header-mobile">
        <button className="text-button" onClick={() => navigate("/profile")}>返回</button>
        <div className="header-center"><strong>{task.knowledge_tag}复测</strong><span>第 {task.review_round} 轮 · 间隔 {task.interval_days} 天</span></div>
      </header>
      <div className="practice-content">
        <section className="question-card">
          <div className="question-meta"><span className="question-num">{task.subject}</span><span className="question-type">{question.difficulty}</span><div className="question-tags">{question.knowledge_tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div>
          <h1 className="question-title">{question.title}</h1>
          <div className="question-content"><MathText text={question.content_text} /></div>
          {question.content_image_url && <div className="paper-image-wrapper"><img src={question.content_image_url} alt="复习题原图" /></div>}
        </section>

        {!attempt ? (
          <section className="answer-card"><h2>重新作答</h2><form onSubmit={submit}><textarea rows="8" value={answerText} onChange={(event) => setAnswerText(event.target.value)} placeholder="不要看旧答案，独立写出思路和结论。" /><button className="primary" disabled={submitting || !answerText.trim()}>{submitting ? "AI 评阅中..." : "提交复测"}</button></form></section>
        ) : (
          <section className="review-card"><h2>复测结果</h2><div className="score-section"><strong className="score-value">{attempt.score}</strong><span className={`score-status ${attempt.is_correct ? "correct" : "wrong"}`}>{attempt.is_correct ? "本轮通过" : "继续巩固"}</span></div><div className="feedback-section"><MathText text={attempt.feedback_text} /></div>{attempt.step_breakdown.map((step) => <div className="step-card" key={step.step_number}><span className="step-number">{step.step_number}</span><MathText text={step.explanation} /></div>)}<div className="next-action-card">{attempt.next_action}</div><button className="primary" onClick={() => navigate("/profile")}>返回学习路径</button></section>
        )}
      </div>
    </main>
  );
}
