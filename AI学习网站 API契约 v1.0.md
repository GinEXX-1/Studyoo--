
本文档是前后端协作的唯一真相来源。任何接口的新增、修改，必须先改这份文档，再动代码。 Codex、Trae、CodeBuddy 三方均按此文档开发，禁止私自改动接口形状后不同步文档。

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

- 除注册/登录接口外，所有接口需在请求头携带：

```
Authorization: Bearer <token>
```

- token 由登录接口签发，前端存储在内存或安全存储中，不做本地明文持久化的复杂需求（第一版够用即可）。
- 第一版 token 使用 JWT，7 天过期；过期后前端统一跳转登录页，不做静默刷新。
- 密码必须哈希存储，禁止明文保存；`nickname` 全局唯一；密码最少 6 位。

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
  "reason": "该知识点近7天错误率超过50%",
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

## 3. 模块二：智能答疑

### 3.1 提交问题——从零开始问

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

### 3.1b 提交问题——深化官方答案

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

### 3.2 提交问题（图片）

`POST /questions/image`

- multipart/form-data，字段：`image`（题目图片）、`subject`、`mode`
- 若 `mode` 为 `deepen_official_answer`，额外支持 `official_answer_image`（官方答案图片，可选，也可用 `official_answer_text` 文字代替） 响应：Question 对象

> 第一版决定：图片只用于当次 OCR/多模态识别，不持久化原图；`content_image_url` 与 `official_answer_image_url` 固定返回 `null`。如未来需要回看原图，再接入对象存储。

### 3.3 获取AI讲解

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

### 3.4 请求完整解答（仅 solve_from_scratch 模式适用，用户点击"直接看答案"）

`POST /questions/{question_id}/reveal-solution` 响应：Answer 对象，此时 `full_solution_text` 填充，`revealed_full_solution` 变 true

### 3.5 追问

`POST /questions/{question_id}/follow-up`

```json
{ "content_text": "这一步为什么这样做" }
```

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
      { "knowledge_tag": "计数原理", "mistake_count": 5, "error_rate": 0.62 }
    ]
  },
  "message": "ok"
}
```

> 说明：一道题被判定为"错题"的规则第一版可以简化为——用户点击过"直接看答案"即计入错题本。不必做复杂的正误判定逻辑。

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

> 第一版推荐逻辑用规则引擎：知识点错误率 > 50% 时生成一条 "review" 类型推荐；不接机器学习推荐算法。规则计算可以设计成定时任务（如每天跑一次），不需要实时。

---

## 6. 第一版已拍板的技术约束

1. **AI服务商与调用方式**：后端通过一个统一 AI 服务层调用模型。第一版默认使用环境变量 `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` 配置；没有配置时接口返回 `AI_SERVICE_ERROR`，不得用假 AI 数据冒充完成。AI 请求超时 60 秒；网络错误最多重试 1 次；模型内容质量问题不自动重试。
2. **图片存储**：第一版不持久化原图。图片只用于当次 OCR/多模态识别，数据库里的图片 URL 字段固定为 `null`。
3. **限流规则**：单用户每天最多 30 次 AI 请求，包括提交问题、图片问题、追问、请求完整答案。
4. **token过期时间**：JWT 7 天过期；过期后前端统一跳转登录页，不做静默刷新。
5. **数学公式渲染库**：前端需引入 KaTeX（含对应CSS），并实现一个统一的"文本+公式混排"渲染组件，扫描 `$...$` / `$$...$$` 定界符分段渲染，所有展示AI讲解文字的位置（答案卡片、追问回复）都必须复用这一个组件，不能各自实现一套。
6. **第一版页面范围**：登录/注册、首页提问、答案展示、追问、错题列表、薄弱点统计、学习路径列表。暂不做完整 Workspace。

---

## 7. 视觉设计规范（给Trae开发前端参照）

### 7.1 色彩

|用途|颜色|说明|
|---|---|---|
|主强调色（浅蒂芙尼色）|`#7FC9C1`（图标/强调块）、`#C7EAE6`（浅底）、`#1F5D57`（浅底上的文字）|用于当前选中状态、次要强调（如"从零开始问"被选中时）|
|副强调色（深赤陶色，低饱和）|`#A85C42`（实心按钮底）、`#F0DED2`（浅底）、`#FCF3EC`（深底上的文字）|用于主要行动按钮（提交、确认类），全站只在关键行动点上使用，不滥用|
|页面背景|`#FCF9E8`|米黄色，叠加浅色格子纹理（见7.3）|
|正文文字|`#2C2A22`（主）、`#6B6558`（次）、`#9C9382`（弱化/提示）|暖灰色系，避免纯黑纯灰|
|边框/分割线|`#C9C0A8`|暖色调的浅边框，不用冷灰色|

> 原则：全站只有两个强调色（蒂芙尼、赤陶），不新增第三个撞色。蒂芙尼色用于"轻量的、次要的选中状态"，赤陶色用于"需要用户採取行动的按钮"，两者不混用在同一类元素上。

### 7.2 字体

- 标题、题目文字、公式讲解正文：衬线体（网页端用 `Noto Serif SC` 或类似中文衬线字体，通过 Google Fonts 引入）
- UI控件文字（按钮、标签、导航）：无衬线体，保持功能性文字的清晰度
- 不要全站统一用衬线体——衬线体用在"内容"上（营造可信、认真阅读的感觉），无衬线体用在"操作"上（营造清晰、高效的感觉），这个区分要在组件库层面固定下来，不能每个页面各自决定

### 7.3 背景纹理

- 页面背景色 `#FCF9E8` 上叠加浅色网格线，CSS实现：

```css
background-color: #FCF9E8;
background-image:
  linear-gradient(rgba(0,0,0,0.045) 1px, transparent 1px),
  linear-gradient(90deg, rgba(0,0,0,0.045) 1px, transparent 1px);
background-size: 22px 22px;
```

- 这个纹理只用在页面级背景，卡片内部保持纯色（白色或极浅暖白），避免纹理和纹理叠加显得杂乱

### 7.4 圆角与间距

- 卡片：8px圆角
- 按钮、标签：可用大圆角（999px，胶囊形），也可用8px小圆角，两种在同一页面内不混用，由具体页面统一决定
- 间距用倍数关系（8px基准），不要随意取值

---

## 8. 使用规则（给Codex / Trae / CodeBuddy）

- 前端严禁使用mock/假数据模拟以上任何接口的返回结构，若接口未就绪，先在此文档标注"待实现"并阻塞该功能开发，不得用假数据填充后继续往下做。
- 任何接口字段的增删改，必须先修改本文档对应章节，再修改代码，且需在commit信息中注明"同步了API契约的XX变更"。
- 每完成一个接口的前后端联调，在下方"联调进度"表格中打勾。

### 联调进度表

|接口|后端完成|前端对接完成|真实数据联调通过|
|---|---|---|---|
|POST /auth/register|[ ]|[ ]|[ ]|
|POST /auth/login|[ ]|[ ]|[ ]|
|GET /users/me|[ ]|[ ]|[ ]|
|POST /questions|[ ]|[ ]|[ ]|
|POST /questions/{id}/reveal-solution|[ ]|[ ]|[ ]|
|POST /questions/{id}/follow-up|[ ]|[ ]|[ ]|
|GET /mistakes|[ ]|[ ]|[ ]|
|PATCH /mistakes/{id}|[ ]|[ ]|[ ]|
|GET /mistakes/stats|[ ]|[ ]|[ ]|
|GET /learning-path|[ ]|[ ]|[ ]|
|PATCH /learning-path/{id}|[ ]|[ ]|[ ]|
