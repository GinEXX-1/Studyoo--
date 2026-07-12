# Studyoo v2 API 文档

## 概述

v2 升级将「整页 PDF 作为一道题」的导入方式升级为可校对的结构化题目流水线，并为重做与学习路径提供间隔复习调度。

**Base URL**: `http://localhost:3000/api/v1`

**认证**: 所有标注 `[Auth]` 的端点需携带 `Authorization: Bearer <token>` 或 Cookie 中的 `token`。

---

## 1. PDF 结构化导入流水线

### 1.1 上传 PDF 创建导入任务

```
POST /import/pipeline/upload  [Auth]
Content-Type: application/json
```

**请求体**:
```json
{
  "file_name": "2024年高考数学全国I卷.pdf",
  "data_base64": "<base64 PDF data>",
  "subject": "数学"
}
```

**响应** (201):
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "uuid",
      "status": "uploaded",
      "subject": "数学",
      "total_pages": 6,
      "processed_pages": 0,
      "question_count": 0,
      "created_at": "2026-07-12T00:00:00.000Z"
    },
    "pages": [
      { "id": "uuid", "page_number": 1, "image_url": "/uploads/import-xxx-page-1.png", "render_status": "rendered" }
    ]
  }
}
```

### 1.2 获取导入任务列表

```
GET /import/pipeline/tasks  [Auth]
```
响应: `{ "success": true, "data": { "items": [...] } }`

### 1.3 获取任务详情（含页面和候选）

```
GET /import/pipeline/tasks/:taskId  [Auth]
```
响应包含 `task`, `pages`, `candidates` 三个数组。

### 1.4 处理单页（AI 识别题目）

```
POST /import/pipeline/pages/:pageId/process  [Auth]
```

调用 AI 视觉模型识别该页所有题目，生成 `question_candidates`。
注意: 同一页面重新处理会清除旧候选。

**响应**:
```json
{
  "success": true,
  "data": {
    "page": { "id": "...", "ocr_status": "processed" },
    "candidates": [
      {
        "id": "uuid",
        "page_number": 1,
        "question_number": 1,
        "stem_text": "已知函数 $f(x)=x^2+2x+1$，求 $f(3)$。",
        "options": [],
        "reference_answer_text": "$f(3)=16$",
        "knowledge_tags": ["二次函数", "代数运算"],
        "difficulty": "easy",
        "question_type": "short-answer",
        "recognition_confidence": 0.95,
        "requires_manual_review": false,
        "review_status": "pending"
      }
    ]
  }
}
```

### 1.5 处理所有页面

```
POST /import/pipeline/tasks/:taskId/process-all  [Auth]
```

批量处理该任务所有 `ocr_status = 'pending'` 的页面。

### 1.6 校对更新候选

```
PATCH /import/pipeline/candidates/:candidateId  [Auth]
```

可更新字段: `stem_text`, `reference_answer_text`, `difficulty`, `question_type`, `question_number`, `options`, `knowledge_tags`, `review_notes`。

### 1.7 单题重新识别

```
POST /import/pipeline/candidates/:candidateId/re-recognize  [Auth]
```

对该候选所在页面重新调用 AI 识别，仅更新匹配到的题目。

### 1.8 确认单题入库

```
POST /import/pipeline/candidates/:candidateId/confirm  [Auth]
```

将候选写入 `exam_questions` + `practice_questions`，状态变为 `confirmed`。
任务内所有候选确认后，任务状态自动变为 `completed`。

**响应**:
```json
{
  "success": true,
  "data": {
    "candidate": { "...": "review_status: confirmed" },
    "exam_question_id": "exam-uuid",
    "practice_question_id": "practice-exam-uuid"
  }
}
```

### 1.9 批量确认

```
POST /import/pipeline/candidates/batch-confirm  [Auth]
```

请求体: `{ "candidate_ids": ["id1", "id2", ...] }`

### 1.10 拒绝候选

```
POST /import/pipeline/candidates/:candidateId/reject  [Auth]
```

请求体: `{ "review_notes": "这是题干的一部分，不是独立题目" }`

### 1.11 获取候选页面图像

```
GET /import/pipeline/candidates/:candidateId/page-image  [Auth]
```

返回 `{ page_image_url, bbox }`，前端可用 CSS clip 展示题目在页面中的位置。

---

## 2. 间隔复习调度

### 复习间隔策略

答错后自动生成 4 轮复习任务：
| 轮次 | 间隔 | 说明 |
|------|------|------|
| 1 | 当天 (0天) | 立即复盘 |
| 2 | 3天后 | 短期巩固 |
| 3 | 7天后 | 中期检测 |
| 4 | 14天后 | 长期记忆 |

每轮复测会分配同知识点、相近难度、**不同题目**的题目。
答对后，后续轮次自动取消。

### 2.1 今日待复习

```
GET /review/today  [Auth]
GET /review/today?subject=数学  [Auth]
```

返回当天及之前到期、状态为 `pending` 的复习任务（含关联题目详情）。

### 2.2 所有待复习

```
GET /review/pending  [Auth]
```

返回所有 `pending` 状态的任务，按日期和轮次排序（最多 50 条）。

### 2.3 已完成复习

```
GET /review/completed?page=1&page_size=20  [Auth]
```

分页查询已完成的复习任务。

### 2.4 提交复习结果

```
POST /review/:taskId/submit  [Auth]
```

**请求体**:
```json
{
  "result": "correct|partial|incorrect",
  "score": 85,
  "feedback_text": "这轮复习掌握了"
}
```

`result=correct` 时，该题后续轮次自动取消。

### 2.5 复习统计

```
GET /review/stats  [Auth]
```

```json
{
  "success": true,
  "data": {
    "due_today": 3,
    "completed_total": 12,
    "correct_rate": 67
  }
}
```

---

## 3. 学习路径推荐（规则驱动）

### 推荐算法

优先级 = 掌握度惩罚 + 逾期奖励 + 最近错误奖励 + 轮次加权：
- `mastery=weak`: +50 分
- `mastery=reviewing`: +30 分
- 每逾期 1 天: +5 分
- 7 天内错过: +20 分
- 每轮次: +3 分

**AI 仅用于生成解释文案，不决定调度优先级。**

### 3.1 今日推荐

```
GET /recommend/today  [Auth]
```

返回按优先级排序的推荐列表（top 10）、知识点统计、近期错误计数。

```json
{
  "success": true,
  "data": {
    "recommended": [
      {
        "review_task_id": "uuid",
        "knowledge_tag": "二次函数",
        "subject": "数学",
        "review_round": 2,
        "scheduled_date": "2026-07-12",
        "mastery_level": "weak",
        "question_title": "...",
        "priority": 73,
        "is_overdue": false
      }
    ],
    "tag_summary": [
      { "knowledge_tag": "二次函数", "subject": "数学", "review_count": 3, "overdue_count": 1 }
    ],
    "due_today_count": 5
  }
}
```

### 3.2 学习路径概览

```
GET /recommend/path  [Auth]
```

合并复习进度和薄弱项统计，输出每个知识点的掌握状态：
- `not_started`: 未开始复习
- `struggling`: 复习正确率 < 50%
- `improving`: 正确率 50%-79%
- `nearly_mastered`: 正确率 >= 80%

### 3.3 知识点推荐题目

```
GET /recommend/questions?subject=数学&knowledge_tag=二次函数  [Auth]
```

返回该知识点下 5 道不同题（按难度升序、随机）。

---

## 4. 自动触发机制

当学生在 `/practice/questions/:id/attempt` 答错时（`is_correct=false`），系统自动：
1. 更新学习路径项（已有功能）
2. **创建 4 轮间隔复习任务**（v2 新功能）

复习任务创建失败不会影响主流程。

---

## 5. Mock 返回样例

### 导入任务详情
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "awaiting_review",
      "subject": "数学",
      "source_name": "2024高考数学全国I卷.pdf",
      "total_pages": 6,
      "processed_pages": 6,
      "question_count": 19,
      "created_at": "2026-07-12T08:00:00.000Z"
    },
    "pages": [
      { "id": "page-1", "page_number": 1, "image_url": "/uploads/page-1.png", "render_status": "rendered", "ocr_status": "processed" }
    ],
    "candidates": [
      {
        "id": "cand-1",
        "page_number": 1,
        "question_number": 1,
        "stem_text": "已知集合 $A=\\{x\\mid -2<x<4\\}$，$B=\\{2,3,4,5\\}$，则 $A\\cap B=$",
        "options": [{"label":"A","content":"$\\{2\\}$"},{"label":"B","content":"$\\{2,3\\}$"}],
        "reference_answer_text": "B",
        "knowledge_tags": ["集合"],
        "difficulty": "easy",
        "question_type": "choice",
        "recognition_confidence": 0.96,
        "review_status": "pending"
      }
    ]
  }
}
```

### 今日推荐
```json
{
  "success": true,
  "data": {
    "recommended": [
      {
        "review_task_id": "rt-1",
        "knowledge_tag": "导数",
        "subject": "数学",
        "review_round": 1,
        "scheduled_date": "2026-07-12",
        "mastery_level": "weak",
        "question_id": "practice-exam-001",
        "question_title": "导数的几何意义",
        "priority": 53,
        "is_overdue": false
      }
    ],
    "tag_summary": [
      { "knowledge_tag": "导数", "subject": "数学", "review_count": 2, "overdue_count": 0 }
    ],
    "due_today_count": 2
  }
}
```
