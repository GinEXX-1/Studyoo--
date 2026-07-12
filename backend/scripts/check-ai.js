import dotenv from "dotenv";

dotenv.config();

const key = process.env.AI_API_KEY || "";
const baseUrl = process.env.AI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const model = process.env.AI_MODEL || "glm-4-flash";

function maskKey(value) {
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 4)}...`;
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

console.log("AI config:");
console.log({
  hasKey: Boolean(key),
  key: maskKey(key),
  baseUrl,
  model
});

if (!key || key === "sk-your-api-key-here" || key === "your-zhipu-api-key-here") {
  console.log("AI_API_KEY is empty or still uses the placeholder value.");
  process.exit(1);
}

try {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: "Return JSON only: {\"ok\":true}"
        }
      ],
      temperature: 0
    })
  });

  const body = await response.text();
  console.log("status:", response.status);
  console.log("body:", body.slice(0, 1200));
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.log("network_error:", error.name, error.message);
  if (error.cause) {
    console.log("cause:", error.cause);
  }
  process.exit(1);
}
