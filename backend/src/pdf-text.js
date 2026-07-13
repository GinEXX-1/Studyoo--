import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const QUESTION_START = /^\s*(\d{1,2})[.．、]\s*(.*)$/;
const ANSWER_HEADING = /^\s*(参考答案|答案与解析|试题答案|参考答案及解析)\s*$/;
const PAGE_FOOTER = /^\s*第\s*\d+\s*页\s*[\/／]\s*共\s*\d+\s*页\s*$/;

function cleanLines(lines) {
  return lines
    .filter((line) => !PAGE_FOOTER.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // 部分数学字体的 ToUnicode 映射会把同一个数学字母输出两次。
    .replace(/([\u{1D400}-\u{1D7FF}])\1/gu, "$1")
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, (character) => character.normalize("NFKD"))
    .replace(/\uFFFD/g, "□")
    .trim();
}

function parseBlocks(pages, pageOffset = 0) {
  const blocks = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const text = cleanLines(current.lines);
    if (text.length >= 2) blocks.push({ ...current, text });
    current = null;
  };

  pages.forEach((pageText, pageIndex) => {
    const lines = pageText.replace(/\r/g, "").split("\n");
    for (const line of lines) {
      const match = line.match(QUESTION_START);
      if (match) {
        flush();
        current = {
          question_number: Number(match[1]),
          page_number: pageOffset + pageIndex + 1,
          lines: [match[2]]
        };
      } else if (current) {
        current.lines.push(line);
      }
    }
  });
  flush();
  return blocks;
}

function questionType(text) {
  const optionCount = (text.match(/(?:^|\s)[A-D][.．、]/g) || []).length;
  if (optionCount >= 2) return "choice";
  if (/_{3,}|＿{3,}|填空/.test(text)) return "fill-in-blank";
  return "short-answer";
}

function extractionIsReliable(blocks) {
  if (blocks.length === 0) return false;
  const numbers = blocks.map((block) => block.question_number);
  const unique = new Set(numbers);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const coverage = unique.size / Math.max(1, max - min + 1);
  return unique.size === blocks.length && min >= 1 && max <= 50 && coverage >= 0.8;
}

export async function extractStructuredPdfText(pdfPath) {
  const startedAt = Date.now();
  const { stdout } = await execFileAsync(config.pdfTextCommand, ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024
  });
  const pages = stdout.split("\f").filter((page, index, items) => page.trim() || index < items.length - 1);
  const answerPageIndex = pages.findIndex((page) => page.split(/\r?\n/).some((line) => ANSWER_HEADING.test(line)));
  const questionPages = answerPageIndex >= 0 ? pages.slice(0, answerPageIndex) : pages;
  const answerPages = answerPageIndex >= 0 ? pages.slice(answerPageIndex) : [];
  const questionBlocks = parseBlocks(questionPages);
  const answerBlocks = parseBlocks(answerPages, answerPageIndex >= 0 ? answerPageIndex : 0);
  const answerByNumber = new Map(answerBlocks.map((block) => [block.question_number, block.text]));

  return {
    reliable: extractionIsReliable(questionBlocks),
    elapsed_ms: Date.now() - startedAt,
    pages,
    questions: questionBlocks.map((block) => ({
      question_number: block.question_number,
      page_number: block.page_number,
      stem_text: block.text,
      options: [],
      reference_answer_text: answerByNumber.get(block.question_number) || "",
      knowledge_tags: [],
      difficulty: "medium",
      question_type: questionType(block.text),
      confidence: 0.82,
      bbox_rel: null
    }))
  };
}
