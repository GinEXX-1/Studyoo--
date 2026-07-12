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
    throw new Error("接口返回格式不符合约定。");
  }

  if (!payload.success) {
    const error = new Error(payload.message || "请求失败。");
    error.code = payload.error_code;
    throw error;
  }

  return payload.data;
}