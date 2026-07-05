import { config } from "./config.js";
import { AppError } from "./http.js";

export function ensureAiConfigured() {
  if (!config.aiApiKey) {
    throw new AppError(503, "AI_SERVICE_ERROR", "AI 服务尚未配置，请先设置 AI_API_KEY。");
  }
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw new AppError(502, "AI_SERVICE_ERROR", "AI 返回格式无法解析，请稍后重试。");
  }
}

async function callChat(messages) {
  ensureAiConfigured();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiTimeoutMs);

  try {
    const response = await fetch(config.aiBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiApiKey}`
      },
      body: JSON.stringify({
        model: config.aiModel,
        messages,
        temperature: 0.3
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new AppError(502, "AI_SERVICE_ERROR", "AI 服务调用失败，请稍后再试。");
    }

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new AppError(502, "AI_SERVICE_ERROR", "AI 没有返回有效内容。");
    }
    return content;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "AI_SERVICE_ERROR", "AI 服务暂时不可用，请稍后再试。");
  } finally {
    clearTimeout(timeout);
  }
}

const baseSystemPrompt = `
你是 Studyoo（学有）的高中学习解析助手。你的职责是帮助学生建立理解，而不是替学生完成思考。
所有数学表达式必须使用标准 LaTeX：行内公式用 $...$，独立公式用 $$...$$。
只返回 JSON，不要返回 Markdown 说明。
`;

export async function generateAnswer({ subject, mode, contentText, officialAnswerText }) {
  const schema =
    mode === "solve_from_scratch"
      ? `{"hint_text":"先引导学生思考的讲解","step_breakdown":[],"full_solution_text":null,"knowledge_tags":["知识点"]}`
      : `{"hint_text":null,"step_breakdown":[{"step_number":1,"explanation":"解释官方答案这一步在做什么以及为什么"}],"full_solution_text":"完整讲透官方答案的说明","knowledge_tags":["知识点"]}`;

  const userPrompt =
    mode === "solve_from_scratch"
      ? `学科：${subject}\n题目：${contentText}\n请先给思路引导，不要直接给完整答案。JSON 形状必须是：${schema}`
      : `学科：${subject}\n题目：${contentText}\n官方答案：${officialAnswerText || ""}\n请把官方答案拆成步骤，重点解释为什么这样做。JSON 形状必须是：${schema}`;

  const content = await callChat([
    { role: "system", content: baseSystemPrompt },
    { role: "user", content: userPrompt }
  ]);

  return extractJson(content);
}

export async function generateFullSolution({ subject, contentText, previousHint }) {
  const content = await callChat([
    { role: "system", content: baseSystemPrompt },
    {
      role: "user",
      content: `学科：${subject}\n题目：${contentText}\n已有引导：${previousHint || ""}\n现在学生主动请求完整答案。只返回 JSON：{"full_solution_text":"完整解答，公式用 LaTeX"}`
    }
  ]);
  return extractJson(content);
}

export async function generateFollowUp({ question, answer, contentText }) {
  const content = await callChat([
    { role: "system", content: baseSystemPrompt },
    {
      role: "user",
      content: `原题：${question.content_text}\n已有讲解：${JSON.stringify(answer)}\n学生追问：${contentText}\n请基于上下文回答，不要重新从零讲。只返回 JSON：{"reply_text":"回答内容，公式用 LaTeX"}`
    }
  ]);
  return extractJson(content);
}
