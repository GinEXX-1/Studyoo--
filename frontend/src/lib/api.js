const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000/api/v1";

let token = window.localStorage.getItem("studyoo_token") || "";

export function getToken() {
  return token;
}

export function setToken(nextToken) {
  token = nextToken || "";
  if (token) {
    window.localStorage.setItem("studyoo_token", token);
  } else {
    window.localStorage.removeItem("studyoo_token");
  }
}

export async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload.success !== "boolean") {
    throw new Error("接口返回格式不符合约定。");
  }

  if (!payload.success) {
    if (payload.error_code === "AUTH_INVALID_TOKEN") {
      setToken("");
    }
    const error = new Error(payload.message || "请求失败。");
    error.code = payload.error_code;
    throw error;
  }

  return payload.data;
}
