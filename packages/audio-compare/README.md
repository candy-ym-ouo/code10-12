# @practice/audio-compare

多版本音频对比台：对同一内容的多个音频版本（参考版 + 若干候选版）做**同段对齐**、**响度归一**与**差异摘要**，产出机器可读（JSON）与人读（Markdown）报告。

纯 TypeScript 实现，零运行时依赖，不调用外部进程；WAV（PCM 16/24/32 位、32/64 位浮点，含 WAVE_FORMAT_EXTENSIBLE）直接解码。

## 能力

- **同段对齐**：包络互相关粗对齐（±30s 可配）→ 采样级细化 → 抛物线亚采样插值；输出偏移量、置信度与反相标记。
- **响度归一**：ITU-R BS.1770 K 加权 + 绝对/相对门控的积分响度（LUFS）；候选版本统一归一到参考版本响度（或显式 `--target-lufs`），报告增益与归一后峰值、削波风险。
- **差异摘要**：对齐并归一后计算相关系数、残余电平（dB）、五频段幅度差、按秒的最显著差异区段排名，并给出中文结论。
- **失败可续跑**：分阶段（validate → decode → align → normalize → diff → report）执行，状态原子落盘；失败保留现场，重跑同命令即从断点继续，已完成阶段不重复执行。
- **取消即清理**：SIGINT/SIGTERM、`CancelToken`（API）或 `cancel` 命令（CANCEL 文件）触发协作式取消；取消后清空 `tmp/` 临时对象，状态记为 `cancelled`，可续跑。
- **历史版本不可覆盖**：已完成版本拒绝任何重跑；续跑强制校验输入 SHA-256 指纹，内容变更即拒绝（`INPUT_CHANGED`），保证报告与输入一一对应。

## CLI

```bash
# 开发态（tsx）
npm run compare -w @practice/audio-compare -- run \
  --version v1 --reference master.wav --candidate take-a.wav --candidate take-b.wav

# 或构建后
node packages/audio-compare/dist/cli.js run \
  --version v1 --reference master.wav --candidate take-a.wav \
  [--runs-dir ./audio-compare-runs] [--target-lufs -23] [--max-offset-seconds 30]

audio-compare resume --version v1     # 按首次记录的输入与参数续跑
audio-compare list                    # 全部历史版本及状态
audio-compare show   --version v1     # 查看报告（未完成则显示阶段进度）
audio-compare cancel --version v1     # 取消运行中的版本（清理临时对象）
audio-compare clean                   # 清理所有未完成运行的临时对象
```

退出码：`0` 成功；`1` 失败；`2` 用法错误；`3` 版本冲突（`VERSION_IMMUTABLE` / `INPUT_CHANGED` / `RUN_LOCKED`）；`130` 已取消。

## 运行目录与状态机

```text
<runsDir>/<version>/
  state.json     # 状态机：running → completed / failed / cancelled（原子写入）
  .lock          # 进程锁（pid），防止并发写同一版本
  CANCEL         # 取消信号文件（cancel 命令写入，运行方下一个检查点生效）
  tmp/           # 临时对象：解码 PCM、归一化 PCM；取消/完成时清理，失败时保留供续跑
  artifacts/     # 最终产物：inputs.json、alignment.json、loudness.json、diff.*.json、report.json、report.md
```

续跑时按「`done` 且产物齐全」逐阶段判定跳过；输入经哈希锁定且各阶段确定，因此产物缺失（如 `tmp/` 已清理）的阶段单独重算即可，下游已有产物保持一致。

## API

```ts
import { runCompare, CancelToken } from "@practice/audio-compare";

const token = new CancelToken();
const summary = await runCompare({
  runsDir: "./audio-compare-runs",
  version: "v1",
  reference: "/path/master.wav",
  candidates: ["/path/take-a.wav"],
  cancelToken: token,          // 调 token.cancel() 即协作式取消
});
// summary.reportMdPath / reportJsonPath
```

DSP 原语（`alignSignals` / `integratedLufs` / `computeDiff` / `decodeWav` 等）亦从包根导出，可被 Worker 复用做更上层的编排。

## 口径与限制

- 对齐为**全局恒定偏移**模型（同内容不同起点的版本对比场景），不做局部变速/剪辑对齐；置信度 < 0.3 时报告会标注“内容可能不同”。
- 响度测量针对整文件（含门控），归一增益为恒定增益，不做动态响度匹配。
- 采样率不一致的输入经线性插值重采样到统一率（对比用途足够，非母带级）。
- 输入仅 WAV；其他格式先用 ffmpeg 转码（仓库 Worker 已有 ffmpeg 调用约定，可作为后续集成点）。
- 差异结论阈值：相关 ≥ 0.999 且残余 ≤ -40 dB 为“高度一致”；相关 ≥ 0.98 且残余 ≤ -25 dB 为“基本一致”；其余为“存在明显内容差异”。

## 测试

```bash
npm run test -w @practice/audio-compare
```

覆盖：BS.1770 响度基准（1 kHz 正弦 ≈ -23 LUFS、±6 dB 线性、门控）、正负/短信号/反相对齐、差异区段定位、频段差异，以及流水线的完成、不可覆盖、失败续跑（阶段不重跑）、取消清理、输入变更拒绝、运行锁。
