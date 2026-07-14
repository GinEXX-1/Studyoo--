# Studyoo 项目进度

> **维护者**：CodeBuddy（唯一维护者）
> **更新规则**：Codex 和 Trae 完成任务后提供"可验证状态"，由 CodeBuddy 合并进此文档。

---

## 状态定义

- **✅ 已验证可用**：真实端到端联调通过，GinEXX 可亲自在浏览器中操作验证
- **🔄 开发中**：有人在编写代码，但尚未完成端到端联调
- **⏳ 未开始**：尚未启动开发

---

## 模块一：账号与数据

| 功能 | 状态 | 如何验证 |
|---|---|---|
| 注册新账号 | ✅ 已验证可用 | 打开 `http://localhost:5173`，点击"注册"，填入昵称/密码/年级，点击"创建账号"，应进入主页面 |
| 用户登录 | ✅ 已验证可用 | 点击"登录"，输入已注册的昵称和密码，点击"进入 Studyoo"，应进入主页面 |
| 获取当前用户信息 | ✅ 已验证可用 | 刷新页面后，cookie 自动校验，不应跳回登录页 |
| 退出登录 | ✅ 已验证可用 | 点击右上角"退出"，清除 cookie，跳回登录页 |
| 更新学科/年级设置 | ⏳ 未开始 | 在设置页修改年级或学科，保存后刷新页面，设置应保持不变 |

---

## 模块二：真题练习（核心）

> 方向调整：Studyoo 的主轴不是“搜题”，而是“通过真题练习提升自己”。智能答疑保留为辅助能力，用于订正、解析和追问。

| 功能 | 状态 | 如何验证 |
|---|---|---|
| 获取当前真题练习 | ✅ 已验证可用 | 运行 `npm run smoke:backend`，应能获取 `/practice/questions/current` 的题目 |
| 提交真题作答 | ✅ 已验证可用 | 运行 `npm run smoke:backend`，应能提交作答并收到 AI 评阅分数 |
| 练习评阅入库 | ✅ 已验证可用 | 运行 `npm run smoke:backend`，应完成真题练习评阅并返回 attempt |
| 真题库试卷列表 | ✅ 已验证可用 | 运行 `npm run smoke:backend`，应能获取 `/exam/papers` |
| 真题库题目列表 | ✅ 已验证可用 | 运行 `npm run smoke:backend`，应能获取 `/exam/papers/:paperId/questions` |
| AI 题目理解档案 | ✅ 已验证可用 | 运行 `npm run smoke:backend`，应能生成 `/exam/questions/:questionId/profile` |
| 手动结构化导入 | ✅ API 就绪 | `POST /exam/ingest/manual` 支持导入结构化 JSON，参考 `backend/samples/exam-import.sample.json` |

---

## 模块二 B：智能答疑（辅助入口）

| 功能 | 状态 | 如何验证 |
|---|---|---|
| 提交文字题目（solve_from_scratch 模式） | ✅ 已验证可用 | 在首页选择"从零开始问"，输入验收题1（分式题），点击"提交解析"，应看到思路引导（hint_text），公式用 KaTeX 渲染 |
| 提交文字题目（deepen_official_answer 模式） | ✅ 已验证可用 | 在首页选择"深化官方答案"，输入验收题2（数列题+官方答案），点击"提交解析"，应看到分步骤讲解（step_breakdown）+ 完整答案 |
| 请求完整解答（reveal-solution） | ✅ 已验证可用 | 在 solve_from_scratch 结果页点击"看完整答案"，应加载完整解答（full_solution_text），公式正确渲染，同时加入错题本 |
| 提交追问（自由文本） | ✅ 已验证可用 | 在答案页面底部追问输入框输入问题，点击"追问"，应看到 AI 返回的回复 |
| 提交图片题目 | ✅ API 就绪 | `POST /questions/image` 接收 base64 图片，AI 视觉识别后入库并返回讲解 |
| 题目历史记录 | ✅ 已验证可用 | `GET /questions` 返回用户所有题目，支持分页和按状态筛选 |

---

## 模块三：错题本 + 薄弱点分析

| 功能 | 状态 | 如何验证 |
|---|---|---|
| 查看错题列表/计数 | ✅ 已验证可用 | 在页面右侧"错题"板块，reveal-solution 后应显示错题计数（如"1 条记录"） |
| 标记复习状态 | ✅ 已验证可用 | `PATCH /mistakes/:id` 可更新 mastery_status（weak→reviewing→mastered） |
| 查看薄弱点统计 | ✅ 已验证可用 | 在页面右侧"薄弱点"板块，应显示各知识点标签 |

---

## 模块四：个性化学习路径

| 功能 | 状态 | 如何验证 |
|---|---|---|
| 查看推荐列表（API） | ⏳ API 就绪 | `GET /learning-path` 返回 items，无数据（需定时任务生成） |
| 更新推荐状态 | ⏳ API 就绪 | `PATCH /learning-path/:itemId` 可更新状态 |

---

## 核心技术能力

| 能力 | 状态 | 如何验证 |
|---|---|---|
| 后端环境就绪检查 | ✅ 已验证可用 | 访问 `/api/v1/system/readiness`，返回 server/database/ai/auth 状态 |
| AI 真实调用 | ✅ 已验证可用 | 已接通 BigModel（模型以 backend/.env 的 AI_MODEL 为准），每日限额 30 次 |
| 数学公式 KaTeX 渲染 | ✅ 已验证可用 | 提交含 `$\frac{}{}$` 的题目，AI 返回 LaTeX，前端 MathText 组件用 KaTeX 渲染 |
| 数据持久化 | ✅ 已验证可用 | 提交题目后 `GET /questions` 可查到历史记录，错题记录持久化 |
| AI 配额（全路由，含 PDF 导入） | ✅ 已验证可用 | `ai_usage` 表跟踪每日用量（本地时区重置），超限返回 `RATE_LIMITED` |
| Token 安全 | ✅ 已验证可用 | httpOnly cookie（不可 JS 读取）+ cookie-parser + CORS credentials |
| 用户数据隔离 | ✅ 已验证可用 | 运行 `npm run test:ownership --workspace backend`，14 项越权测试应全部通过 |
| PDF 逐题拆分 + 单题裁切图 | ✅ 已验证可用 | 上传 PDF 后单页应拆出多道独立题目，每题带裁切图与置信度 |

---

## 已知问题

| 日期 | 问题描述 | 负责人 | 状态 |
|---|---|---|---|
| 2026-07-05 | 追问仍是自由文本输入，未改为 A/B/C/D 选项式（契约审计 #1 已记录设计差异） | Trae/Codex | 待排期 |
| 2026-07-05 | knowledge_tags 未做归一化 | Codex | ✅ 已解决（canonical 标签目录 + 别名归一化） |
| 2026-07-05 | 学习路径数据为空，无生成机制 | Codex | ✅ 已解决（`POST /learning-path/generate` + v2 规则推荐） |
| 2026-07-05 | 图片上传路由 `POST /questions/image` 未实现 | Codex | ✅ 已解决 |
| 2026-07-12 | 根目录存在分裂的 studyoo.db + uploads（历史遗留），处置方案见《项目资产与文件结构.md》 | GinEXX | 待决定 |
| 2026-07-13 | 生产环境种子试卷图片/PDF 404；无数据库备份；AI 成本无全局护栏；无密码找回 | Claude | ✅ 已修复（待部署：Railway 设 INVITE_CODE 后 redeploy） |
| 2026-07-13 | 备份仅落在 /data 卷内，异地备份（对象存储）未做 | 待分配 | 待排期 |
| 2026-07-12 | 重做机制尚未实现，计划见《重做机制开发计划.md》 | 待分配 | 待评审 |

---

## 最近更新

| 日期 | 更新内容 | 更新人 |
|---|---|---|
| 2026-07-14 | **带图题目修复 + 数学公式输入**：①识别新增 `has_figure` 判定并全链路贯穿（候选/真题/练习题三表加列），含图题在做题页内联常显裁切原图（不再折叠），导入校对页可手动纠正"含图"标记——修复"带图题丢图/查看原卷只给整页"②做题页新增数学公式符号面板 `MathKeyboard`（分数/根号/上下标等 20 键，点击在光标处插入 LaTeX + 实时预览）——修复"键盘打不出公式"。浏览器实测通过；越权 19 项 + 守护栏 6 项回归通过。详见《下一阶段功能计划 2026-07-14.md》 | Claude |
| 2026-07-13 | **生产四断点修复**：①种子资源随镜像分发（backend/seed-assets），启动自动铺进上传目录，修复公共卷图片/PDF 404 ②数据库每日自动备份（VACUUM INTO + 保留 14 份，生产自启，`npm run backup:db` 手动）③全站 AI 日配额 AI_GLOBAL_DAILY_LIMIT（默认 200，防批量注册烧余额）+ 注册邀请码 INVITE_CODE（前端已加输入框）④管理员重置密码 `npm run admin:reset-password`。新增 `npm run test:guardrails`（6 项）；越权测试 19 项全过；前端构建通过。**部署动作：Railway 设置 INVITE_CODE 环境变量后 redeploy。** | Claude |
| 2026-07-13 | **v2.1 代码审计完成**：①架构评分 8/10（模块职责清晰，routes.js 可进一步拆分）②性能评分 7/10（分页足够，缺复合索引，自动保存无防抖）③安全评分 9/10（所有权过滤完整，AI 配额 100% 包装）④无高风险项，5 个中风险优化项（P1 复合索引、P2 防抖、P3-5 重构），建议修复 P1 后提交。⑤推荐发布时间：本周内。详见《代码审计报告 2026-07-13.md》 | Claude |
| 2026-07-12 | **v2.1 安全修复与拆题优化**：①用户数据隔离（试卷/真题/练习题按 owner 过滤，公共题库禁止覆盖，/uploads 需登录）②PDF 导入流水线接入 AI 配额 ③PDF 原文不再存数据库（正库 24MB→1.1MB）④数据库/上传路径锚定 backend 目录，杜绝双库分裂 ⑤拆题 prompt 重写（单页正确拆多题）+ 按 bbox 生成单题裁切图 + 单题精细重识别 ⑥配额/复习调度改用本地时区 ⑦移动端底部导航 + 安全区适配 ⑧新增 `npm run test:ownership`（14 项越权测试） | Claude |
| 2026-07-05 | 产品主轴调整为真题练习；新增练习题、作答提交、AI 评阅、作答记录最小链路，搜题解析保留为辅助入口 | Codex |
| 2026-07-05 | 真题系统 V1 完成：试卷表、真题表、AI 理解档案、导入任务、真题库 API、手动导入样例 | Codex |
| 2026-07-05 | **CodeBuddy 端到端联调完成**：17 项 API 测试全部通过，涵盖注册/登录/两种答疑模式/追问/reveal/错题本/边界测试。新增 `GET /questions`、`POST /questions/:id/retry`、SidePanel 自动刷新、全路由 save-first 配额保护 | CodeBuddy |
| 2026-07-05 | 后端基础链路验证通过：注册、鉴权、AI 解析、入库返回 | Codex |
| 2026-07-05 | BigModel 配置接通，AI 真实调用可用 | Codex |
| 2026-07-05 | 初始模板创建 | CodeBuddy |
