import { evaluatePracticeAttemptStream } from "../src/ai.js";

const startedAt = Date.now();
let firstFeedbackAt = null;
let latestFeedback = "";

try {
  const evaluation = await evaluatePracticeAttemptStream({
    practiceQuestion: {
      subject: "数学",
      content_text: "已知 $f(x)=x^2$，求 $f(2)$。",
      official_answer_text: "$4$",
      knowledge_tags: ["函数"]
    },
    answerText: "$f(2)=2^2=4$。",
    canonicalTags: ["函数"]
  }, (feedback) => {
    if (!firstFeedbackAt && feedback.trim()) firstFeedbackAt = Date.now();
    latestFeedback = feedback;
  });

  console.log(JSON.stringify({
    success: true,
    first_feedback_ms: firstFeedbackAt ? firstFeedbackAt - startedAt : null,
    total_ms: Date.now() - startedAt,
    feedback_streamed: latestFeedback.length > 0,
    score: Number(evaluation.score),
    schema_complete: Boolean(evaluation.feedback_text && evaluation.next_action && Array.isArray(evaluation.step_breakdown))
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    success: false,
    total_ms: Date.now() - startedAt,
    error_code: error.errorCode || "AI_STREAM_CHECK_FAILED",
    message: error.message
  }, null, 2));
  process.exitCode = 1;
}
