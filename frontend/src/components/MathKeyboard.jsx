// 数学公式输入辅助面板：点击符号在光标处插入 LaTeX 片段，配合实时预览，
// 解决键盘打不出数学符号的问题。片段以 $...$ 约定书写，AI 评阅也按此解析。
const KEYS = [
  { label: "½", snippet: "\\frac{}{}", caret: 6, hint: "分数" },
  { label: "xⁿ", snippet: "^{}", caret: 2, hint: "上标/指数" },
  { label: "xₙ", snippet: "_{}", caret: 2, hint: "下标" },
  { label: "√", snippet: "\\sqrt{}", caret: 6, hint: "根号" },
  { label: "∑", snippet: "\\sum_{}^{}", caret: 5, hint: "求和" },
  { label: "∫", snippet: "\\int_{}^{}", caret: 5, hint: "积分" },
  { label: "π", snippet: "\\pi " },
  { label: "±", snippet: "\\pm " },
  { label: "×", snippet: "\\times " },
  { label: "÷", snippet: "\\div " },
  { label: "≤", snippet: "\\leq " },
  { label: "≥", snippet: "\\geq " },
  { label: "≠", snippet: "\\neq " },
  { label: "≈", snippet: "\\approx " },
  { label: "→", snippet: "\\to " },
  { label: "∞", snippet: "\\infty " },
  { label: "°", snippet: "^{\\circ} ", hint: "度" },
  { label: "∠", snippet: "\\angle " },
  { label: "△", snippet: "\\triangle " },
  { label: "公式 $ $", snippet: "$$", caret: 1, wrap: true, hint: "插入行内公式" }
];

export default function MathKeyboard({ targetRef, value, onChange }) {
  function insert(key) {
    const el = targetRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);

    let snippet = key.snippet;
    let caret = key.caret ?? snippet.length;
    if (key.wrap) {
      snippet = `$${selected}$`;
      caret = selected ? snippet.length : 1;
    }

    onChange(value.slice(0, start) + snippet + value.slice(end));
    // 受控 textarea 重渲染会把光标重置到末尾，故在提交后的宏任务里再定位到 {} 内
    const pos = start + caret;
    setTimeout(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  return (
    <div className="math-keyboard" role="toolbar" aria-label="数学公式输入">
      {KEYS.map((key) => (
        <button key={key.label} type="button" title={key.hint || key.label} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(key)}>
          {key.label}
        </button>
      ))}
    </div>
  );
}
