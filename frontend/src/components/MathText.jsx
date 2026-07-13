import katex from "katex";
import "katex/dist/katex.min.css";

function renderFormula(source, displayMode) {
  try {
    return {
      __html: katex.renderToString(source, {
        displayMode,
        throwOnError: false,
        strict: false
      })
    };
  } catch {
    // 渲染失败时退回纯文本，绝不把原文当 HTML 注入
    return null;
  }
}

export function normalizeMathText(value) {
  return String(value || "")
    .replace(/＄/g, "$")
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula) => `$$${formula}$$`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, formula) => `$${formula}$`)
    .replace(/([\u{1D400}-\u{1D7FF}])\1/gu, "$1")
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, (character) => character.normalize("NFKD"))
    .replace(/\uFFFD/g, "□");
}

export function MathText({ text }) {
  if (!text) return null;
  const normalizedText = normalizeMathText(text);

  const parts = [];
  const pattern = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(normalizedText)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: normalizedText.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    const display = raw.startsWith("$$");
    parts.push({
      type: "math",
      display,
      value: display ? raw.slice(2, -2) : raw.slice(1, -1)
    });
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < normalizedText.length) {
    parts.push({ type: "text", value: normalizedText.slice(lastIndex) });
  }

  return (
    <span className="math-text">
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <span key={index}>{part.value}</span>;
        }
        const rendered = renderFormula(part.value, part.display);
        if (!rendered) {
          return <span key={index}>{part.value}</span>;
        }
        return (
          <span
            key={index}
            className={part.display ? "math-block" : "math-inline"}
            dangerouslySetInnerHTML={rendered}
          />
        );
      })}
    </span>
  );
}
