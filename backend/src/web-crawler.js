import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { canonicalTagsForSubject, db, normalizeKnowledgeTags, nowIso } from "./db.js";
import { extractWebQuestions } from "./ai.js";
import { AppError } from "./http.js";
import { withAiQuota } from "./quota.js";

const MAX_HTML_BYTES = 2_000_000;
const MAX_PAGE_TEXT = 8_000;

export function validateCrawlUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "网页地址不合法。");
  }
  if (url.protocol !== "https:" || !config.discoveryAllowedHosts.includes(url.hostname.toLowerCase())) {
    throw new AppError(403, "SOURCE_NOT_ALLOWED", "该域名未加入 DISCOVERY_ALLOWED_HOSTS 白名单。");
  }
  url.hash = "";
  return url;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

export function extractPageData(html, pageUrl) {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || pageUrl.hostname)
    .replace(/\s+/g, " ").trim().slice(0, 300);
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|section|article|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(cleaned)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_PAGE_TEXT);

  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    try {
      const link = new URL(match[1] || match[2] || match[3], pageUrl);
      link.hash = "";
      if (link.protocol !== "https:" || link.hostname.toLowerCase() !== pageUrl.hostname.toLowerCase()) continue;
      if (/\.(?:pdf|zip|rar|7z|jpg|jpeg|png|gif|webp|mp4|mp3)(?:$|\?)/i.test(link.pathname)) continue;
      if (/\b(?:logout|login|signin|signup)\b/i.test(link.pathname)) continue;
      if (!seen.has(link.href)) {
        seen.add(link.href);
        links.push(link.href);
      }
    } catch {
      // Ignore malformed links from the source page.
    }
  }
  return { title, text, links: links.slice(0, 40) };
}

async function fetchHtml(initialUrl) {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "StudyooQuestionCrawler/1.0 (+https://studyoo.space)" }
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new AppError(502, "SOURCE_FETCH_FAILED", "来源网页返回了无目标的跳转。");
        const next = validateCrawlUrl(new URL(location, current).href);
        if (next.hostname.toLowerCase() !== initialUrl.hostname.toLowerCase()) {
          throw new AppError(403, "SOURCE_NOT_ALLOWED", "爬虫拒绝跳转到其他域名。");
        }
        current = next;
        continue;
      }
      if (!response.ok) throw new AppError(502, "SOURCE_FETCH_FAILED", `来源网页返回 HTTP ${response.status}。`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) throw new AppError(400, "SOURCE_TYPE_UNSUPPORTED", "爬虫目前只支持 HTML 页面。");
      return { html: (await response.text()).slice(0, MAX_HTML_BYTES), finalUrl: current };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new AppError(502, "SOURCE_FETCH_FAILED", "来源网页跳转次数过多。");
}

function insertCandidates(job, page, questions) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO discovery_candidates (
      id, job_id, source_url, page_title, content_hash, question_number, question_type,
      content_text, official_answer_text, knowledge_tags_json, difficulty, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const [index, question] of questions.slice(0, 50).entries()) {
    const content = String(question.content_text || "").trim();
    if (!content) continue;
    const hash = createHash("sha256").update(content.replace(/\s+/g, " ")).digest("hex");
    const result = insert.run(
      randomUUID(), job.id, page.url, page.title, hash,
      String(question.question_number || index + 1), String(question.question_type || "其他").slice(0, 30),
      content, typeof question.official_answer_text === "string" ? question.official_answer_text.trim() : null,
      JSON.stringify(normalizeKnowledgeTags(job.subject, question.knowledge_tags)),
      ["easy", "medium", "hard"].includes(question.difficulty) ? question.difficulty : "medium",
      Math.max(0, Math.min(1, Number(question.confidence) || 0)), nowIso()
    );
    inserted += Number(result.changes || 0);
  }
  return inserted;
}

export async function runCrawlJob(jobId) {
  const job = db.prepare("SELECT * FROM discovery_crawl_jobs WHERE id = ?").get(jobId);
  if (!job) return;
  db.prepare("UPDATE discovery_crawl_jobs SET status = 'running', error_message = NULL WHERE id = ?").run(job.id);
  const queue = [job.seed_url];
  const visited = new Set();
  let candidatesFound = 0;
  try {
    while (queue.length && visited.size < job.max_pages) {
      const current = validateCrawlUrl(queue.shift());
      if (visited.has(current.href)) continue;
      visited.add(current.href);
      const fetched = await fetchHtml(current);
      const page = { ...extractPageData(fetched.html, fetched.finalUrl), url: fetched.finalUrl.href };
      for (const link of page.links) if (!visited.has(link) && !queue.includes(link)) queue.push(link);
      if (page.text.length >= 30) {
        const extraction = await withAiQuota(job.user_id, () => extractWebQuestions({
          subject: job.subject,
          pageTitle: page.title,
          pageText: page.text,
          canonicalTags: canonicalTagsForSubject(job.subject)
        }));
        candidatesFound += insertCandidates(job, page, extraction.questions || []);
      }
      db.prepare("UPDATE discovery_crawl_jobs SET pages_crawled = ?, candidates_found = ? WHERE id = ?")
        .run(visited.size, candidatesFound, job.id);
    }
    db.prepare("UPDATE discovery_crawl_jobs SET status = ?, pages_crawled = ?, candidates_found = ?, completed_at = ? WHERE id = ?")
      .run(candidatesFound ? "review" : "completed", visited.size, candidatesFound, nowIso(), job.id);
  } catch (error) {
    db.prepare("UPDATE discovery_crawl_jobs SET status = 'failed', pages_crawled = ?, candidates_found = ?, error_message = ?, completed_at = ? WHERE id = ?")
      .run(visited.size, candidatesFound, String(error.message || "爬取失败").slice(0, 500), nowIso(), job.id);
  }
}
