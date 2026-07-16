process.env.JWT_SECRET = "crawler-test-secret";
process.env.DISCOVERY_ALLOWED_HOSTS = "example.com";
process.env.DATABASE_PATH = "/tmp/studyoo-web-crawler-test.db";

const { extractPageData, validateCrawlUrl } = await import("../src/web-crawler.js");

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

const html = `<!doctype html><html><head><title>数学题库 &amp; 练习</title><style>.ad{}</style></head>
<body><nav>导航</nav><article><h1>每日一题</h1><p>1. 已知 f(x)=x²，求 f(2)。</p></article>
<a href="/questions/2#answer">下一题</a><a href="https://other.example/test">站外</a>
<a href="/paper.pdf">PDF</a><script>ignore()</script></body></html>`;
const page = extractPageData(html, new URL("https://example.com/questions/1"));

assert(page.title === "数学题库 & 练习", "解析网页标题与 HTML 实体");
assert(page.text.includes("已知 f(x)=x²") && !page.text.includes("ignore()"), "提取正文并去除脚本");
assert(page.links.length === 1 && page.links[0] === "https://example.com/questions/2", "只保留同域 HTML 链接并去除锚点");
assert(validateCrawlUrl("https://example.com/questions").hostname === "example.com", "允许白名单 HTTPS 地址");

let blocked = false;
try {
  validateCrawlUrl("https://not-allowed.example/questions");
} catch (error) {
  blocked = error.errorCode === "SOURCE_NOT_ALLOWED";
}
assert(blocked, "拒绝非白名单来源");
