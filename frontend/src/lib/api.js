const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api/v1";

export function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

export async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
    credentials: "include"
  });

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload.success !== "boolean") {
    if (!response.ok) {
      throw new Error(`后端服务暂不可用（HTTP ${response.status}），请确认后端 API 已启动。`);
    }
    throw new Error("接口返回格式不符合约定，请检查前后端服务地址。");
  }

  if (!payload.success) {
    const error = new Error(payload.message || "请求失败。");
    error.code = payload.error_code;
    throw error;
  }

  return payload.data;
}

export async function apiEventStream(path, options = {}, onEvent = () => {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "include"
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.message || `流式接口不可用（HTTP ${response.status}）。`);
    error.code = payload?.error_code;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ready = false;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "message";
      const dataText = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("\n");
      if (!dataText) continue;
      const data = JSON.parse(dataText);
      if (event === "error") {
        const error = new Error(data.message || "流式评阅失败。");
        error.code = data.error_code;
        throw error;
      }
      if (event === "ready") ready = true;
      onEvent(event, data);
    }
    if (done) break;
  }
  if (!ready) throw new Error("流式评阅意外中断。");
}

// 埋点上报：fire-and-forget，失败静默——观测手段绝不打扰学习主流程
export function trackEvent(eventName, payload = {}) {
  apiRequest("/events", {
    method: "POST",
    body: JSON.stringify({ event_name: eventName, payload })
  }).catch(() => {});
}
