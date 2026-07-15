const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api/v1";

export async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
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

// 埋点上报：fire-and-forget，失败静默——观测手段绝不打扰学习主流程
export function trackEvent(eventName, payload = {}) {
  apiRequest("/events", {
    method: "POST",
    body: JSON.stringify({ event_name: eventName, payload })
  }).catch(() => {});
}
