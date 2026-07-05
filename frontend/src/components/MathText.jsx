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
    return { __html: source };
  }
}

export function MathText({ text }) {
  if (!text) return null;

  const parts = [];
  const pattern = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
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

  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }

  return (
    <span className="math-text">
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <span key={index}>{part.value}</span>;
        }
        return (
          <span
            key={index}
            className={part.display ? "math-block" : "math-inline"}
            dangerouslySetInnerHTML={renderFormula(part.value, part.display)}
          />
        );
      })}
    </span>
  );
}
