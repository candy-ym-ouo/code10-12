# API 契约

基础路径：`/api/v1`。除注册、登录和刷新外，请求使用 `Authorization: Bearer <accessToken>`。

错误统一返回：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段不合法",
    "details": [],
    "traceId": "req-..."
  }
}
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | 注册并返回 Access Token，同时设置 Refresh Cookie |
| POST | `/auth/login` | 登录并轮换 Refresh Cookie |
| POST | `/auth/refresh` | 使用 Cookie 轮换刷新令牌 |
| POST | `/auth/logout` | 撤销当前 Refresh Session 并清除 Cookie |

Refresh Cookie 路径为 `/api/v1/auth`，生产环境在 HTTPS 下自动使用 `Secure`。

## 用户与设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/me` | 当前用户 |
| PATCH | `/users/me` | 更新展示名、默认乐器、时区和语言 |
| POST | `/users/me/password` | 修改密码并撤销其他会话 |

## 练习

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 光标分页、搜索、筛选和排序 |
| POST | `/sessions` | 创建练习 |
| GET | `/sessions/:id` | 详情，包含音频、标记、目标和复盘 |
| PATCH | `/sessions/:id` | 乐观锁更新；请求必须带 `version` |
| POST | `/sessions/:id/start-review` | 存在已就绪音频时进入 `IN_REVIEW` |
| GET | `/sessions/:id/completion-check` | 返回结构化缺失项 |
| POST | `/sessions/:id/complete` | 原子完成复盘 |
| POST | `/sessions/:id/archive` | 归档已完成练习 |
| POST | `/sessions/:id/restore` | 恢复归档练习 |
| DELETE | `/sessions/:id` | 必须提交完整 `confirmationTitle` |

创建练习：

```json
{
  "title": "协奏曲第二乐章 17-24 小节",
  "instrument": "小提琴",
  "startedAt": "2026-09-29T12:00:00.000Z",
  "focus": "换把后的音准",
  "location": "琴房 A",
  "notes": "节拍器 84 BPM",
  "actualDurationMs": 1800000
}
```

## 音频上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:sessionId/media/uploads` | 创建上传会话并返回预签名 PUT URL |
| POST | `/media/:mediaId/complete-upload` | 校验对象大小/SHA-256 并投递探测任务 |
| GET | `/media/:mediaId` | 状态、元数据与波形峰值 |
| GET | `/media/:mediaId/playback-url` | 获取短期私有播放地址 |
| POST | `/media/:mediaId/retry-probe` | 重试音频探测 |
| DELETE | `/media/:mediaId` | 删除对象和关联标记 |

创建上传会话：

```json
{
  "originalName": "practice.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 2646000,
  "sha256": "64-hex-characters"
}
```

预签名请求的 `Content-Type` 和 `x-amz-meta-sha256` 已纳入签名，必须使用返回的 `requiredHeaders` 原样上传。

## 标记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/annotations` | 标记列表 |
| POST | `/sessions/:sessionId/annotations` | 新增标记 |
| PATCH | `/annotations/:id` | 编辑标记 |
| DELETE | `/annotations/:id` | 删除标记 |

区间使用毫秒整数，最小时长 100 ms，且不能超过音频时长。问题类型为 `RHYTHM`、`FINGERING` 或 `EMOTION`。

## 复盘与目标

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/review` | 获取复盘 |
| PUT | `/sessions/:sessionId/review` | 保存复盘草稿 |
| POST | `/sessions/:sessionId/review/complete` | 完成复盘事务 |
| GET/POST | `/goals` | 目标列表/创建 |
| GET/PATCH | `/goals/:id` | 目标详情/更新 |
| POST | `/goals/:id/activate` | 重新激活取消或逾期目标 |
| POST | `/goals/:id/cancel` | 带原因取消 |
| POST | `/goals/:id/complete` | 用户确认完成 |
| GET/POST | `/goals/:id/progress` | 进度列表/新增 |

完成复盘请求会原子写入复盘、目标、进度并更新练习状态。任一步失败时全部回滚，返回 `REVIEW_INCOMPLETE` 且 `details` 为缺失项数组。

## 统计与导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/statistics/overview` | 总览指标 |
| GET | `/statistics/trends` | 按用户时区分日趋势 |
| GET | `/statistics/issues` | 问题类型、严重度和困难片段 |
| GET | `/statistics/goals` | 目标完成率和逾期 |
| GET | `/statistics/instruments` | 各乐器聚合 |
| GET | `/statistics/dashboard` | 首页聚合 |
| POST | `/exports` | 创建 JSON/CSV 用户数据导出 |
| GET | `/exports/:id` | 查询导出状态和短时下载地址 |

统计接口必须传 `from`、`to` 和 IANA `timezone`。

## 健康检查

| 路径 | 说明 |
|---|---|
| `/health/live` | 仅检查进程存活 |
| `/health/ready` | 检查 PostgreSQL、Redis 和对象存储 |
| `/metrics` | Prometheus 文本指标 |

## 多版本音频对比台

对比一条演奏的两个历史版本（基线 + 候选），Worker 依次完成：下载解码（纯 TS WAV 直通，压缩格式走可选 ffmpeg）→ BS.1770-4 K 加权积分响度测量 → 目标 LUFS 恒定增益 + 真峰值限制 → 粗到精互相关同段对齐 → 逐窗 RMS/相关差异摘要 → 渲染 24kHz 对齐 WAV 与差异 WAV → 上传产物 → 事务落库。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/comparisons` | 创建对比（两轨；可选 `groupId` 同段续版本，默认目标 -23 LUFS / -1 dBTP） |
| GET | `/comparisons` | 对比列表（可按 `groupId`、`status` 过滤，游标分页） |
| GET | `/comparisons/groups/:groupId/revisions` | 同段全部历史版本（revision 升序，只读不可覆盖） |
| GET | `/comparisons/:id` | 对比详情，含状态、阶段、进度与 `summary` |
| POST | `/comparisons/:id/resume` | 失败续跑（固定 BullMQ jobId，沿用 worker 本地检查点） |
| POST | `/comparisons/:id/cancel` | 协作取消（原子置位，删除全部派生对象与临时目录） |
| DELETE | `/comparisons/:id` | 删除对比记录（进行中先取消；终态直接清派生对象，源音频不动） |
| GET | `/media` | 跨练习列出已就绪音频（对比台选轨） |
| GET | `/comparisons/:id/artifacts/:kind/playback-url` | `aligned-0` / `aligned-1` / `diff` 的预签名播放地址 |

关键约束：

- 历史不可覆盖：同一 `groupId` 下 `revision` 由数据库唯一约束保证单调递增，创建冲突自动重试。
- 失败可续跑：BullMQ 指数退避重试（4 次）+ worker 启动恢复超过 5 分钟未更新的 PENDING/PROCESSING 行；本地 `checkpoint.json` 记录已下载源文件与响度测量结果，成功/取消后删除，`sweepStaleCompareDirs` 兜底清理 24 小时陈旧目录。
- 取消即清理：处理循环在每个阶段边界轮询 `cancelRequested`；完成提交使用 `cancelRequested = false` 条件更新，取消落库使用非 READY 条件更新，两路径靠行锁互斥，杜绝“取消后又完成”或“完成后产物被删”。
- 源音频永不被对比流程删除；对比轨对源媒体为 `ON DELETE SET NULL`，源练习删除后历史对比仍可播放对齐产物。

`summary`（JSON）结构：`similarityScore`(0-100)、`overallCorrelation`、`alignment.{offsetMs,correlation}`、`meanRmsDeltaDb`、`maxRmsDeltaDb`、`meanAbsDelta`、`coveragePct`、`alignedDurationMs`、`windowCount`、`worstWindows[]`（差异最大 5 段：时间范围、双版本 RMS、响度差、相关系数）与每轨 `measuredLufs/gainDb/truePeakDb/truePeakLimited`。
