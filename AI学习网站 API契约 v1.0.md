
本文档是前后端协作的唯一真相来源。任何接口的新增、修改，必须先改这份文档，再动代码。Codex、Trae、CodeBuddy 三方均按此文档开发，禁止私自改动接口形状后不同步文档。

> **文档分层说明**：
> - README.md：产品愿景、定位、路线图
> - 本文档（API契约）：前后端接口唯一真相来源
> - PROGRESS.md：当前实现状态唯一真相来源
> 需求变更时，README 与本文档同步更新，以本文档为准。

> **2026-07-05 方向修正**：Studyoo 的第一主轴不是“搜题”，而是“通过真题练习提升自己”。智能答疑/题目解析能力保留，但降级为辅助入口。后续新增功能优先围绕“真题 -> 学生作答 -> AI 评阅 -> 订正复盘 -> 薄弱点更新”展开。

---

## 0. 全局约定

### 0.1 Base URL

```
前端开发环境: http://localhost:5173
后端开发环境: http://localhost:3000/api/v1
生产环境: https://<your-domain>/api/v1
```

前端不得把后端地址写死在页面组件里，必须通过环境变量 `VITE_API_BASE_URL` 读取；本地默认值为 `http://localhost:3000/api/v1`。

### 0.2 认证方式

- 除注册/登录接口外，所有接口需通过 **HttpOnly Cookie** 携带 token，后端设置 `Set-Cookie: token=<jwt>; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`。前端无需手动在请求头添加 Authorization。
- 第一版 token 使用 JWT，7 天过期；过期后后端返回 `AUTH_INVALID_TOKEN` 错误码，前端统一跳转登录页，不做静默刷新。
- 密码必须哈希存储（使用 bcrypt 或类似算法），禁止明文保存；`nickname` 全局唯一；密码最少 6 位。
- **所有权鉴权规则**：所有 PATCH/DELETE 接口必须校验资源所有权，只有资源所属用户（`user_id` 匹配当前登录用户）才能操作。否则返回 `AUTH_INVALID_TOKEN`。

### 0.3 统一响应格式

**成功响应：**

```json
{
  "success": true,
  "data": { },
  "message": "ok"
}
```

**失败响应：**

```json
{
  "success": false,
  "data": null,
  "message": "错误的具体描述，用于前端直接展示",
  "error_code": "AUTH_INVALID_TOKEN"
}
```

- 前端**只允许**通过 `success` 字段判断成功/失败，不允许用 HTTP 状态码猜测业务逻辑（HTTP状态码只反映网络/服务器层面的情况）。
- `error_code` 是给开发者排查用的，`message` 是给用户看的，两者不能混用。

### 0.4 常用 error_code 约定

|error_code|含义|
|---|---|
|AUTH_INVALID_TOKEN|token失效或缺失|
|AUTH_USER_NOT_FOUND|用户不存在|
|VALIDATION_ERROR|请求参数不合法|
|RESOURCE_NOT_FOUND|请求的资源不存在|
|AI_SERVICE_ERROR|AI接口调用失败|
|RATE_LIMITED|触发限流|
|SERVER_ERROR|未分类的服务器错误|

### 0.5 分页约定（用于错题本等列表接口）

请求：`?page=1&page_size=20` 响应中固定携带：

```json
"pagination": { "page": 1, "page_size": 20, "total": 137 }
```

---

## 1. 数据模型（跨模块共用）

### User

```json
{
  "id": "uuid",
  "nickname": "string",
  "grade": "高一 | 高二 | 高三",
  "subjects": ["数学", "物理"],
  "created_at": "ISO8601"
}
```

### Question（一次提问/一道题）

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "subject": "数学",
  "mode": "solve_from_scratch | deepen_official_answer",
  "content_text": "题目文字内容",
  "content_image_url": "string | null",
  "official_answer_text": "string | null",
  "official_answer_image_url": "string | null",
  "knowledge_tags": ["计数原理", "排列组合"],
  "status": "answered | pending | failed",
  "created_at": "ISO8601"
}
```

> `mode` 字段是核心区分：
> 
> - `solve_from_scratch`：完全不会，从零开始问，对应"耐心家教"体验
> - `deepen_official_answer`：已有真题参考答案（往往简略、跳步），需要AI把官方答案的推理过程讲透，对应"真题答案太模糊"这个具体痛点
> 
> 两种模式对应不同的前端输入表单：前者只需题目输入框，后者需要"题目 + 官方答案"两个输入框。这是产品差异化的核心功能，不能和普通搜题工具混为一谈。

### Answer（AI给出的讲解）

```json
{
  "id": "uuid",
  "question_id": "uuid",
  "hint_text": "引导思路部分（仅 solve_from_scratch 模式下有值）",
  "step_breakdown": [
    { "step_number": 1, "explanation": "官方答案这一步在做什么、为什么这样做" }
  ],
  "full_solution_text": "完整解答部分",
  "revealed_full_solution": false,
  "created_at": "ISO8601"
}
```

> `step_breakdown` 是 `deepen_official_answer` 模式的核心输出：把官方答案拆成分步骤解释，每一步回答"为什么"，而不是简单重复官方答案的文字。前端应把这部分做成可展开的分步卡片，而不是一段文字堆在一起。

> **revealed_full_solution 语义约定**：
> - `solve_from_scratch` 模式：初始为 false，用户请求完整解答后变为 true
> - `deepen_official_answer` 模式：始终为 true（因为答案直接返回）

> **数学公式渲染约定**：`hint_text`、`full_solution_text`、`step_breakdown[].explanation`、追问的 `reply_text` 中，凡涉及数学表达式，AI输出时必须用标准LaTeX语法包裹——行内公式用 `$...$`，独立公式用 `$$...$$`。调用AI模型的系统提示词里要显式要求这一点，否则模型可能输出纯文本公式（如 `x^2+y^2`），导致前端无法正确渲染。前端使用 KaTeX（而非更重的MathJax）扫描并渲染这些定界符，这是本产品区别于普通搜题工具的必要细节，不能省略。

### MistakeRecord（错题本条目）

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "question_id": "uuid",
  "knowledge_tags": ["计数原理"],
  "mistake_count": 3,
  "mastery_status": "weak | reviewing | mastered",
  "last_reviewed_at": "ISO8601 | null"
}
```

### LearningPathItem（个性化推荐条目）

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "knowledge_tag": "计数原理",
  "reason": "该知识点近7天求助率超过50%",
  "recommended_action": "review | practice",
  "related_question_ids": ["uuid"],
  "status": "pending | done | dismissed"
}
```

---

## 2. 模块一：账号与数据

### 2.1 注册

`POST /auth/register`

请求：

```json
{ "nickname": "string", "password": "string", "grade": "高一" }
```

响应：`data` 为 User 对象 + token

```json
{ "user": { }, "token": "string" }
```

### 2.2 登录

`POST /auth/login`

```json
{ "nickname": "string", "password": "string" }
```

响应同上。

### 2.3 获取当前用户信息

`GET /users/me` 响应：User 对象

### 2.4 更新学科/年级设置

`PATCH /users/me`

```json
{ "grade": "高二", "subjects": ["数学", "物理", "化学"] }
```

---

## 3. 模块二：真题练习（第一主轴）

### 3.1 获取当前练习题

`GET /practice/questions/current?subject=数学&after_id=上一题ID`

`after_id` 可选；传入时返回同学科的下一题，到末尾后从第一题重新开始。

指定打开某道练习题：`GET /practice/questions/{question_id}`。

响应：

```json
{
  "success": true,
  "data": {
    "question": {
      "id": "uuid",
      "subject": "数学",
      "title": "数列递推通项",
      "source": "真题改编",
      "content_text": "题目内容",
      "official_answer_text": "参考答案",
      "knowledge_tags": ["数列"],
      "difficulty": "medium",
      "created_at": "ISO8601"
    },
    "latest_attempt": null
  },
  "message": "ok"
}
```

### 3.2 提交练习作答

`POST /practice/questions/{question_id}/attempt`

请求：

```json
{ "answer_text": "学生自己的作答过程" }
```

响应：

```json
{
  "success": true,
  "data": {
    "question": {},
    "attempt": {
      "id": "uuid",
      "practice_question_id": "uuid",
      "answer_text": "学生自己的作答过程",
      "is_correct": false,
      "score": 72,
      "feedback_text": "针对学生答案的反馈",
      "step_breakdown": [
        { "step_number": 1, "explanation": "关键步骤评阅" }
      ],
      "next_action": "下一步复盘建议",
      "created_at": "ISO8601"
    }
  },
  "message": "ok"
}
```

### 3.3 获取最近练习记录

`GET /practice/attempts`

响应：

```json
{
  "success": true,
  "data": { "items": [] },
  "message": "ok"
}
```

### 3.4 获取真题试卷列表

`GET /exam/papers?subject=数学`

响应：

```json
{
  "success": true,
  "data": { "items": [] },
  "message": "ok"
}
```

### 3.5 获取某份试卷的题目

`GET /exam/papers/{paper_id}/questions`

响应：

```json
{
  "success": true,
  "data": {
    "paper": {},
    "items": []
  },
  "message": "ok"
}
```

### 3.6 获取单题与 AI 理解档案

`GET /exam/questions/{question_id}`

响应：

```json
{
  "success": true,
  "data": {
    "question": {},
    "profile": null
  },
  "message": "ok"
}
```

### 3.7 生成或更新 AI 理解档案

`POST /exam/questions/{question_id}/profile`

响应：

```json
{
  "success": true,
  "data": {
    "question": {},
    "profile": {
      "knowledge_tags": ["数列"],
      "difficulty": "medium",
      "core_idea": "核心思想",
      "common_mistakes": ["常见错误"],
      "exam_intent": "命题意图",
      "prerequisites": ["前置知识"]
    }
  },
  "message": "ok"
}
```

### 3.8 手动结构化导入真题

`POST /exam/ingest/manual`

请求：

```json
{
  "paper": {
    "year": 2024,
    "region": "全国",
    "subject": "数学",
    "title": "数学真题结构化导入样例",
    "source_name": "人工整理样例",
    "source_url": null,
    "license_note": "仅用于个人学习和本地开发验证"
  },
  "questions": [
    {
      "question_number": "1",
      "question_type": "填空题",
      "content_text": "题目内容",
      "official_answer_text": "参考答案",
      "knowledge_tags": ["知识点"],
      "difficulty": "easy"
    }
  ]
}
```

响应：

```json
{
  "success": true,
  "data": {
    "paper_id": "uuid",
    "imported_count": 1
  },
  "message": "ok"
}
```

---

## 3B. 模块二 B：题目解析（辅助入口）

### 3B.1 提交问题——从零开始问

`POST /questions`

```json
{ "subject": "数学", "mode": "solve_from_scratch", "content_text": "..." }
```

第一版采用同步方案：提交问题接口会等待 AI 返回，并在统一响应的 `data` 中一并返回 Question 与 Answer。

响应：

```json
{
  "success": true,
  "data": {
    "question": { "status": "answered" },
    "answer": { "hint_text": "...", "full_solution_text": null }
  },
  "message": "ok"
}
```

### 3B.1b 提交问题——深化官方答案

`POST /questions`

```json
{
  "subject": "数学",
  "mode": "deepen_official_answer",
  "content_text": "题目内容",
  "official_answer_text": "官方给的简略答案"
}
```

响应同样为 `{ question, answer }`。前端表单必须提供两个独立输入框（题目 / 官方答案），不能合并成一个大文本框，否则AI难以区分哪部分是题目哪部分是答案。

### 3B.2 提交问题（图片）

`POST /questions/image`

- multipart/form-data，字段：`image`（题目图片）、`subject`、`mode`
- 若 `mode` 为 `deepen_official_answer`，额外支持 `official_answer_image`（官方答案图片，可选，也可用 `official_answer_text` 文字代替） 响应：Question 对象

> 第一版决定：图片只用于当次 OCR/多模态识别，不持久化原图；`content_image_url` 与 `official_answer_image_url` 固定返回 `null`。如未来需要回看原图，再接入对象存储。

### 3B.3 获取AI讲解

`GET /questions/{question_id}/answer`

- 第一版采用同步方案：提交问题接口本身就阻塞等待AI返回，直接在 `POST /questions` 的响应里一并带上 Answer。避免第一版就搭建轮询/WebSocket机制。
- `GET /questions/{question_id}/answer` 仅用于前端刷新结果页或历史记录回看，不用于轮询。
- 响应按 `mode` 不同而不同：

`solve_from_scratch` 模式：

```json
{
  "question": { },
  "answer": { "hint_text": "...", "full_solution_text": null }
}
```

`full_solution_text` 默认不返回完整解答，只给 `hint_text`，用户需主动点击"直接看答案"（见3.4）。

`deepen_official_answer` 模式：

```json
{
  "question": { },
  "answer": {
    "step_breakdown": [
      { "step_number": 1, "explanation": "..." }
    ],
    "full_solution_text": "..."
  }
}
```

这个模式下用户已经有官方答案了，"藏答案"没有意义，`step_breakdown` 和 `full_solution_text` 直接一起返回。

### 3B.4 请求完整解答（仅 solve_from_scratch 模式适用，用户点击"直接看答案"）

`POST /questions/{question_id}/reveal-solution` 响应：Answer 对象，此时 `full_solution_text` 填充，`revealed_full_solution` 变 true

### 3B.5 获取追问选项

`GET /questions/{question_id}/follow-up-options`

响应：

```json
{
  "success": true,
  "data": {
    "options": [
      { "id": "A", "text": "这一步为什么这样做" },
      { "id": "B", "text": "有没有更简单的方法" },
      { "id": "C", "text": "这个知识点在教材哪一页" }
    ],
    "allow_custom": true
  },
  "message": "ok"
}
```

> `options` 由后端根据题目和已有讲解生成，最多 3 个选项（A/B/C）。`allow_custom` 为 true 时，前端允许用户自定义输入追问内容。

### 3B.6 提交追问

`POST /questions/{question_id}/follow-up`

请求：

```json
{
  "option_id": "A" | null,
  "custom_text": "string | null"
}
```

> 规则：`option_id` 和 `custom_text` 必须有且仅有一个有值。选择预设选项时填 `option_id`；自定义追问时填 `custom_text`。

响应：

```json
{
  "success": true,
  "data": { "reply_text": "..." },
  "message": "ok"
}
```

---

## 4. 模块三：错题本 + 薄弱点分析

### 4.1 获取错题列表

`GET /mistakes?subject=数学&mastery_status=weak&page=1&page_size=20` 响应：MistakeRecord 数组 + pagination

```json
{
  "success": true,
  "data": {
    "items": [],
    "pagination": { "page": 1, "page_size": 20, "total": 0 }
  },
  "message": "ok"
}
```

### 4.2 标记复习状态

`PATCH /mistakes/{mistake_id}`

```json
{ "mastery_status": "mastered" }
```

### 4.3 获取薄弱点统计

`GET /mistakes/stats?subject=数学` 响应：

```json
{
  "success": true,
  "data": {
    "tags": [
      { "knowledge_tag": "计数原理", "mistake_count": 5, "help_rate": 0.62 }
    ]
  },
  "message": "ok"
}
```

> 说明：一道题被判定为"错题"的规则第一版可以简化为——用户点击过"直接看答案"即计入错题本。不必做复杂的正误判定逻辑。
> `help_rate`（求助率）= 该知识点下点击"直接看答案"的题目数 / 该知识点下总题目数。

---

## 5. 模块四：个性化学习路径

### 5.1 获取推荐列表

`GET /learning-path?status=pending` 响应：LearningPathItem 数组

```json
{
  "success": true,
  "data": { "items": [] },
  "message": "ok"
}
```

### 5.2 更新推荐状态

`PATCH /learning-path/{item_id}`

```json
{ "status": "done" }
```

> 第一版推荐逻辑用规则引擎：知识点求助率（help_rate）> 50% 时生成一条 "review" 类型推荐；不接机器学习推荐算法。规则计算可以设计成定时任务（如每天跑一次），不需要实时。

---

## 6. 第一版已拍板的技术约束

1. **技术栈**：
   - 后端：Python 3.10+ / FastAPI + PostgreSQL
   - 前端：React 18+ / Vite
   - ORM：SQLAlchemy（后端）
   - 密码哈希：bcrypt

2. **AI服务商与调用方式**：后端通过一个统一 AI 服务层调用模型。第一版默认使用环境变量 `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` 配置；没有配置时接口返回 `AI_SERVICE_ERROR`，不得用假 AI 数据冒充完成。AI 请求超时 60 秒；网络错误最多重试 1 次；模型内容质量问题不自动重试。
   - **AI超时前端UX**：显示加载动画，标注"AI 正在思考..."；超时后显示"AI 暂时没回应，请稍后重试"，返回 `AI_SERVICE_ERROR` 错误码。

3. **图片存储**：第一版不持久化原图。图片只用于当次 OCR/多模态识别，数据库里的图片 URL 字段固定为 `null`。

4. **限流规则**：单用户每天最多 30 次 AI 请求，包括提交问题、图片问题、追问、请求完整答案。

5. **token存储与过期**：JWT 通过 HttpOnly Cookie 存储，7 天过期；过期后后端返回 `AUTH_INVALID_TOKEN` 错误码，前端统一跳转登录页，不做静默刷新。

6. **数学公式渲染库**：前端需引入 KaTeX（含对应CSS），并实现一个统一的"文本+公式混排"渲染组件，扫描 `$...$` / `$$...$$` 定界符分段渲染，所有展示AI讲解文字的位置（答案卡片、追问回复）都必须复用这一个组件，不能各自实现一套。

7. **第一版页面范围**：登录/注册、首页提问、答案展示、追问、错题列表、薄弱点统计、学习路径列表。暂不做完整 Workspace。

8. **CORS配置**：
   - 开发环境允许：`http://localhost:5173`
   - 生产环境允许：`https://<your-domain>`
   - 允许方法：GET/POST/PATCH/DELETE
   - 允许头：Authorization、Content-Type
   - 允许携带凭证：true

9. **knowledge_tags归一化**：
   - 学科固定枚举：数学、物理、化学、生物、语文、英语、历史、地理、政治
   - 知识点标签允许 AI 生成，但后端需做归一化（同义词映射）
   - 数据库保留原始标签和规范标签两列
   - 前端展示和统计均使用规范标签

---

## 7. 视觉设计规范（给Trae开发前端参照）

### 7.1 设计方向

Studyoo 的界面应像一份可交互的学习期刊：理性、温暖、安静、重视阅读与思考。借鉴编辑出版物的网格、索引、分割线和留白，但不复制任何第三方品牌标识、字体或页面结构。

- 重点是“先做题，再理解”，不是 SaaS 营销或聊天机器人界面
- 由排版、内容层级和学习节奏建立高级感，不依赖装饰性视觉效果
- 真题练习是主入口；解析、真题库、错题和学习路径作为学习档案组织
- 避免蓝紫渐变、霓虹、玻璃拟态、发光阴影、3D 机器人、粒子背景、Bento Grid 和过度卡片化

### 7.2 色彩

|用途|颜色|说明|
|---|---|---|
|页面背景|`#FCF9E8`|温暖米黄色，保持纸张感；不再依赖明显网格纹理|
|内容浅底|`#F3EED8`|用于题目解析、学习提示等内容区块|
|正文文字|`#2C2A22`（主）、`#6B6558`（次）|暖黑与暖灰，避免纯黑纯灰|
|边框/分割线|`#C9C0A8`、`#9D947F`|优先使用细分割线建立结构|
|主行动色（赤陶）|`#A85C42`、`#F0DED2`|仅用于提交、确认、继续等关键行动|
|次强调色（蒂芙尼）|`#7FC9C1`、`#C7EAE6`、`#1F5D57`|用于选中状态、理解提示、学习反馈|

原则：全站仍只有蒂芙尼与赤陶两个强调色。赤陶推动行动，蒂芙尼表达理解与状态，两者不在同一类控件中混用。

### 7.3 字体与内容层级

- 标题、题目、公式讲解和答案正文使用 `Noto Serif SC`、`Songti SC` 或类似中文衬线体，强调阅读与可信度
- 导航、按钮、表单、标签和状态信息使用中性无衬线体，保持操作清晰
- 日期、题号、学科、题型等元信息可使用等宽体，形成研究档案与索引感
- 标题使用较大字号、较紧行高和适度负字距；正文保持舒适阅读宽度与 1.7 左右行高
- 不要让所有文字统一使用衬线体，也不要使用夸张粗黑字体

### 7.4 布局、组件与动效

- 桌面端使用最大约 1320px 的内容宽度；主内容与右侧学习档案采用不对称双栏
- 顶部为品牌标题区，下面是“真题练习 / 题目解析 / 真题库”的文字索引式模式切换
- 练习题以试卷页形式呈现：题目、元信息、作答区和评阅区通过细线分层，不默认包在厚重卡片里
- 真题库使用“试卷—题目索引—题目详情”的编辑目录结构；错题、薄弱点、学习路径使用学习档案结构
- 卡片与内容容器圆角不超过 4px；按钮使用 2px 左右小圆角；避免胶囊形控件
- 页面区块使用 24–48px 内间距，章节间使用 80–160px 留白；不以卡片数量制造信息层级
- Hover 只允许轻微底色变化、下划线、箭头位移或 2–4px 上移，时长 180–350ms
- 页面进入可使用 opacity + translateY，位移不超过 24px；必须支持 `prefers-reduced-motion`
- 移动端将双栏改为单栏，题目索引横向滚动，保持标题冲击力与舒适阅读宽度

---

## 8. 使用规则（给Codex / Trae / CodeBuddy）

- 前端严禁使用mock/假数据模拟以上任何接口的返回结构，若接口未就绪，先在此文档标注"待实现"并阻塞该功能开发，不得用假数据填充后继续往下做。
- 任何接口字段的增删改，必须先修改本文档对应章节，再修改代码，且需在commit信息中注明"同步了API契约的XX变更"。
- **进度跟踪分工**：
  - **本文档联调进度表**：记录每个接口的后端完成、前端对接完成、真实数据联调通过状态，由 Codex 和 Trae 各自打勾。
  - **PROGRESS.md**：记录用户可见的功能状态（已验证可用/开发中/未开始），由 CodeBuddy 作为唯一维护者。Codex 和 Trae 完成任务后提供"可验证状态"（操作步骤+预期结果），由 CodeBuddy 合并进 PROGRESS.md。

### 联调进度表

|接口|后端完成|前端对接完成|真实数据联调通过|
|---|---|---|---|
|POST /auth/register|[ ]|[ ]|[ ]|
|POST /auth/login|[ ]|[ ]|[ ]|
|GET /users/me|[ ]|[ ]|[ ]|
|POST /questions|[ ]|[ ]|[ ]|
|POST /questions/{id}/reveal-solution|[ ]|[ ]|[ ]|
|GET /questions/{id}/follow-up-options|[ ]|[ ]|[ ]|
|POST /questions/{id}/follow-up|[ ]|[ ]|[ ]|
|GET /mistakes|[ ]|[ ]|[ ]|
|PATCH /mistakes/{id}|[ ]|[ ]|[ ]|
|GET /mistakes/stats|[ ]|[ ]|[ ]|
|GET /learning-path|[ ]|[ ]|[ ]|
|PATCH /learning-path/{id}|[ ]|[ ]|[ ]|

---

## 附录 C：v2.2 新增接口（拍照导入 / 共享题库）

### C.1 拍照识别题目
`POST /import/pipeline/../import/photo/recognize`（实际路径 `/api/v1/import/photo/recognize`，需登录，消耗 1 次 AI 额度）

请求：`{ "subject": "数学", "image_base64": "<dataURL 或纯 base64，≤10MB>" }`

响应 data：`{ "photo_id", "image_url", "draft": { stem_text, options, reference_answer_text, knowledge_tags, difficulty, question_type, has_figure, confidence } }`

说明：照片与 AI 原始识别结果存入 `photo_uploads` 表（微调语料囤积）；识别失败自动清理照片文件并回滚配额。

### C.2 拍照确认入库
`POST /api/v1/import/photo/confirm`（需登录，不消耗 AI）

请求：`{ "photo_id", "stem_text"(必填), "options", "reference_answer_text", "knowledge_tags", "difficulty", "question_type", "has_figure" }`

行为：入库到该用户的「拍照导入 · 学科」试卷与题库（ID 形如 `collection-photo-<userId>-math`，纯 ASCII）；同一 photo_id 重复确认返回 409。

响应 data：`{ "exam_question_id", "practice_question_id", "collection_id" }`

### C.3 共享题库开关
`PATCH /api/v1/collections/:collectionId/share`（仅 owner）

请求：`{ "shared": true | false }`

行为：同步设置题库、源试卷、关联练习题的 `is_shared`；共享后对全体用户可见可练，编辑/删除/共享开关仍仅限 owner；已被任何人完成过的题库不可删除。

可见性规则（全局统一）：`owner IS NULL（公共种子） OR owner = 当前用户 OR is_shared = 1`。

### C.4 序列化新增字段
- 题库（collection）：`is_shared`、`is_owner`
- 练习题（practice question）：`has_figure`（true 时前端直接展示题目原图）、`is_shared`
