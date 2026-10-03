# 乐器练习复盘本

一个可持久化、可部署的练习闭环 Web 应用。Vue 3 负责真实音频播放、波形定位与标记；Node.js 负责认证、练习历史、验证、目标、进度和统计。

## 核心闭环

1. 创建练习并上传真实音频。
2. API 校验对象大小与 SHA-256，Worker 使用 `ffprobe` 探测格式并生成波形峰值。
3. 在真实波形上播放、缩放、循环并标记节奏、指法或情绪问题。
4. 填写复盘总结，为已有目标记录进度或创建下一次可执行目标。
5. 服务端在一个数据库事务中校验并关闭复盘。
6. 历史详情和统计接口读取同一数据库口径，服务重启后数据仍保留。

## 多版本音频对比台

同一演奏段的多个版本（基线 vs 候选）在「音频对比台」中完成服务端对比：

1. **同段对齐**：K 加权响度归一后，粗到精两级互相关估计全局时延（1 kHz 包络粗搜 → 8 kHz 能量段精修，默认 ±1500 ms）。
2. **响度归一**：BS.1770-4 门控积分响度（K 加权、400 ms/75% 重叠块、绝对-70 LUFS + 相对-10 dB 双门），恒定增益统一到目标 LUFS（默认 -23），并以 4x 过采样真峰值限制在 -1 dBTP 内。
3. **差异摘要**：逐 2 s/0.5 s 滑窗给出双版本 RMS、响度差、相关系数，汇总综合相似度（0-100）与差异最大 5 段；同时渲染对齐后的两轨与「基线−候选」差异 WAV，前端用单个 AudioContext 采样级同步试听（混合同听 / 单听 / 听差异）。

可靠性约定：

- **失败可续跑**：BullMQ 指数退避重试，Worker 启动时恢复卡死超过 5 分钟的对比；本地检查点（`tmp/practice-compare-<id>/checkpoint.json`）缓存已下载源文件与响度结果，只重算未完成阶段。
- **取消后清理**：取消为协作式，处理循环在每个阶段边界轮询；提交 READY 与落 CANCELLED 互斥（条件更新 + 行锁），取消后删除全部派生对象（aligned/diff/report）与临时目录，源音频绝不删除；启动时清扫 24 小时陈旧临时目录。
- **历史版本不可覆盖**：同段对比归入 `groupId`，`(group_id, revision)` 数据库唯一约束保证版本号只增不改，所有历史版本只读保留；源练习/媒体删除时对比轨外键 `SET NULL`，对齐产物仍可播放。
- WAV（8/16/24/32-bit PCM、32-bit float）由 Worker 内置纯 TypeScript 解码器处理，不依赖 ffmpeg；其他压缩格式在安装 ffmpeg 时自动解码。

## 架构

```text
Vue 3 Web -> Fastify API -> PostgreSQL
                 |               |
                 +-> Redis Queue -+-> Worker -> ffprobe / ffmpeg
                 |
                 +-> S3 / MinIO（私有音频对象）
```

- `apps/web`：Vue 3、TypeScript、Pinia、Vue Router、WaveSurfer.js、ECharts。
- `apps/api`：Fastify、Zod、Prisma、Argon2id、Refresh Token 轮换、S3 预签名上传。
- `apps/worker`：BullMQ 音频探测、波形峰值、删除清理、逾期目标和数据导出。
- `packages/contracts`：前后端共享的 Zod 请求约束与领域纯函数。
- `infra/scripts`：测试音频生成脚本。

## 本地启动

要求：Node.js 22 LTS、npm 10+、PostgreSQL 16、Redis 7、S3/MinIO 和 FFmpeg 7+。

```bash
npm install
cp .env.example .env
# 首次运行请替换两个 Secret，至少 32 个随机字符
npm run db:generate
npm run db:migrate
set -a
source .env
set +a
npm run dev
```

默认地址：

- Web：<http://localhost:5173>
- API：<http://localhost:3000>
- API 存活检查：<http://localhost:3000/health/live>
- API 就绪检查：<http://localhost:3000/health/ready>

`npm run dev` 不自动加载 `.env`，需要由 Shell、IDE 或进程管理器注入。生产环境应分别运行 API、Worker 和 Web 构建产物。

## 常用命令

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e

npm run db:generate
npm run db:migrate
npm run db:deploy
npm run db:studio
```

端到端测试需要可用的 PostgreSQL、Redis、S3/MinIO、FFmpeg、已启动的应用和 Chromium：

```bash
npx playwright install chromium
npm run test:e2e
```

## 必需环境变量

| 变量 | 用途 | 示例 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql://practice:practice@localhost:5432/practice` |
| `REDIS_URL` | BullMQ 与健康检查 | `redis://localhost:6379` |
| `JWT_ACCESS_SECRET` | Access Token 密钥 | 至少 32 字节随机值 |
| `REFRESH_TOKEN_PEPPER` | Refresh Token 摘要加盐 | 至少 32 字节随机值 |
| `S3_ENDPOINT` | API/Worker 访问对象存储的地址 | `http://localhost:9000` |
| `S3_PUBLIC_ENDPOINT` | 浏览器预签名地址 | `http://localhost:9000` |
| `S3_BUCKET` | 私有音频 Bucket | `practice-audio` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | S3 凭证 | 通过 Secret 注入 |
| `WEB_ORIGIN` | 允许的 Web 来源列表，逗号分隔 | `https://app.example.com` |
| `PUBLIC_API_ORIGIN` | 对外 API 地址，用于 Cookie Secure 判断 | `https://api.example.com` |

完整变量见 [.env.example](./.env.example)。生产环境必须使用 HTTPS，设置真实的 `PUBLIC_API_ORIGIN`，并禁止在 `WEB_ORIGIN` 中使用通配符。

## 数据与安全

- 密码使用 Argon2id；Access Token 只在浏览器内存保存。
- Refresh Token 使用 `HttpOnly` Cookie 并每次轮换；检测到复用会撤销同一会话族。
- 音频 Bucket 保持私有，播放 URL 默认 300 秒过期。
- 上传先创建 `MediaAsset`，对象直传 S3/MinIO，确认时流式计算 SHA-256。
- 同一用户重复上传相同 SHA-256 时复用已有对象，新练习只创建业务关联，不重复占用存储。
- Worker 禁止拼接 Shell 命令，统一使用参数数组调用 `ffprobe/ffmpeg`。
- 所有资源查询都带 `userId` 条件，无法通过 ID 访问其他用户资源。
- 删除练习进入后台清理队列，失败时保留 `DELETE_FAILED` 以便重试和审计。

## 项目文档

- [API 契约](./docs/api.md)
- [部署说明](./docs/deployment.md)
- [备份与恢复](./docs/backup-restore.md)

统计口径、状态机、数据库字段和验收清单以仓库根目录的 `项目文档.md` 为准。
