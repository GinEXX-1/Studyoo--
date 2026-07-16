// ——— AI 输出形状校验 ———
// AI 返回的 JSON 在入库/返回前必须过一遍形状校验：缺字段、类型错都会被拦下并触发一次带错误信息的重试。
// 刻意不引入 zod 等依赖：校验规则简单固定，几十行手写足够，也少一个供应链面。

function ruleProblems(value, rule, path) {
  const problem = rule(value);
  return problem ? [`${path}${problem}`] : [];
}

export const rules = {
  str: (value) => (typeof value === "string" && value.trim() !== "" ? null : " 应为非空字符串"),
  strOrNull: (value) => (value === null || value === undefined || typeof value === "string" ? null : " 应为字符串或 null"),
  num: (value) => (Number.isFinite(Number(value)) ? null : " 应为数字"),
  bool: (value) => (typeof value === "boolean" || value === 0 || value === 1 ? null : " 应为布尔值"),
  strArray: (value) => (Array.isArray(value) && value.every((item) => typeof item === "string") ? null : " 应为字符串数组"),
  arrayOf: (shape) => (value) => {
    if (!Array.isArray(value)) return " 应为数组";
    for (let index = 0; index < value.length; index++) {
      const problems = validateShape(value[index], shape);
      if (problems.length) return `[${index}] ${problems.join("；")}`;
    }
    return null;
  },
  oneOf: (options) => (value) => (options.includes(value) ? null : ` 应为 ${options.join("/")} 之一`)
};

export function validateShape(value, shape) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["整体应为 JSON 对象"];
  }
  const problems = [];
  for (const [field, rule] of Object.entries(shape)) {
    problems.push(...ruleProblems(value[field], rule, field));
  }
  return problems;
}

const stepShape = { explanation: rules.str };

export const shapes = {
  answer: {
    step_breakdown: rules.arrayOf(stepShape),
    knowledge_tags: rules.strArray
  },
  fullSolution: { full_solution_text: rules.str },
  followUp: { reply_text: rules.str },
  evaluation: {
    score: rules.num,
    feedback_text: rules.str,
    step_breakdown: rules.arrayOf(stepShape),
    next_action: rules.str,
    knowledge_tags: rules.strArray
  },
  redoEvaluation: {
    score: rules.num,
    feedback_text: rules.str,
    progress_note: rules.str,
    next_action: rules.str
  },
  questionProfile: {
    knowledge_tags: rules.strArray,
    difficulty: rules.oneOf(["easy", "medium", "hard"]),
    core_idea: rules.str,
    common_mistakes: rules.strArray,
    exam_intent: rules.str,
    prerequisites: rules.strArray
  },
  collectionBuild: {
    title: rules.str,
    selected_ids: rules.strArray
  },
  learningPath: {
    items: rules.arrayOf({
      knowledge_tag: rules.str,
      reason: rules.str,
      recommended_action: rules.str,
      related_question_ids: rules.strArray
    })
  },
  webQuestionExtraction: {
    questions: rules.arrayOf({
      question_number: rules.str,
      question_type: rules.str,
      content_text: rules.str,
      official_answer_text: rules.strOrNull,
      knowledge_tags: rules.strArray,
      difficulty: rules.oneOf(["easy", "medium", "hard"]),
      confidence: rules.num
    })
  }
  // 视觉识别（拆题/单题/拍照）不做强校验：导入流水线本身有人工校对环节兜底，
  // 强校验反而会因个别残缺题让整页识别反复重试。
};
