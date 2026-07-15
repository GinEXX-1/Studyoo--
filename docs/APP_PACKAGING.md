# Studyoo App 打包准备

当前版本以可安装 PWA 作为 App 化基线。Web 与未来原生壳共享同一套 React 页面和后端 API，不在这一阶段引入两套业务实现。

## 已就绪

- 路由级代码拆分，首屏不再加载做题、管理台等全部页面代码。
- Web App Manifest、`192x192` / `512x512` 图标、Apple Touch Icon。
- Service Worker 缓存应用壳和按需加载的静态资源，API 与上传资源始终走网络。
- 后端版本接口 `GET /api/v1/system/version`，账户反馈会记录客户端所见版本。
- API 地址通过 `VITE_API_BASE_URL` 注入；Web 生产环境继续推荐同域 `/api/v1` 反向代理。

## 原生壳阶段的约束

1. 优先选择 Capacitor，保留 Vite 构建产物作为 WebView 内容。
2. iOS/Android 不直接复用跨站 Cookie。打包前应实现设备安全存储中的短期 access token 与可撤销 refresh token，Web 仍保留 HttpOnly Cookie。
3. PDF 与图片选择通过 Capacitor Filesystem/Camera 适配层接入，业务上传接口保持不变。
4. 推送通知只承载“重做到期”和“今日计划”，不发送答案或隐私学习数据。
5. 发布前补齐隐私政策、账号注销、数据导出、崩溃监控与商店截图。

## 构建检查

```bash
npm run build
```

生产构建后检查 `frontend/dist/manifest.webmanifest`、图标和懒加载 chunk 均存在，再执行 Lighthouse PWA 与移动端真机验收。
