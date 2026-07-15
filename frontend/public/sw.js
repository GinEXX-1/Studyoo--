// Studyoo Service Worker：静态资源缓存优先，API 永远走网络。
// 目标只有一个：加到主屏幕后二次打开秒开，弱网下壳先出来。
const CACHE_NAME = "studyoo-static-v1";
const PRECACHE = ["/", "/manifest.webmanifest", "/brand/studyoo-black.png", "/brand/studyoo-white.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // API、上传资源、跨域请求永远走网络——学习数据绝不能吃到过期缓存
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return;

  // 页面导航：网络优先，离线时回退缓存的壳
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/"))
    );
    return;
  }

  // 静态资源（vite 构建产物带内容哈希）：缓存优先，未命中再取并写入缓存
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
