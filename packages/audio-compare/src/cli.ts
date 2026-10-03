#!/usr/bin/env node
/** audio-compare CLI：多版本音频对比台。 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancelError,
  CancelToken,
  CompareError,
  runCompare,
  type CompareOptions,
  type RunHooks,
} from "./pipeline/runner.js";
import { readState } from "./pipeline/state.js";

const USAGE = `多版本音频对比台（同段对齐 / 响度归一 / 差异摘要）

用法：audio-compare <命令> [参数]

命令：
  run       运行一次对比；同版本号未完成时自动断点续跑，已完成版本不可覆盖
  resume    按首次运行记录的输入与参数续跑指定版本
  list      列出全部历史版本及状态
  show      查看指定版本的报告
  cancel    取消正在运行的版本（清理临时对象）
  clean     清理所有未完成运行的临时对象

run 参数：
  --version <id>             版本标识（字母/数字/._-，已完成版本不可复用）
  --reference <path>         参考音频（WAV）
  --candidate <path>         候选版本音频，可重复传入多个
  [--runs-dir <dir>]         运行存档目录，默认 ./audio-compare-runs
  [--target-lufs <v>]        归一目标响度，默认对齐到参考版本响度
  [--max-offset-seconds <v>] 最大搜索偏移秒数，默认 30
  [--keep-temp]              完成后保留临时对象（调试用）

退出码：0 成功；1 失败；2 用法错误；3 版本冲突（不可覆盖/输入变更/被占用）；130 已取消
`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set(["keep-temp", "help"]);

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: new Map(), booleans: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    if (BOOLEAN_FLAGS.has(key)) {
      out.booleans.add(key);
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`参数 --${key} 缺少取值`);
    const list = out.flags.get(key) ?? [];
    list.push(value);
    out.flags.set(key, list);
  }
  return out;
}

function requiredFlag(parsed: ParsedArgs, key: string): string {
  const value = parsed.flags.get(key)?.[0];
  if (!value) throw new Error(`缺少必需参数 --${key}`);
  return value;
}

function optionalNumber(parsed: ParsedArgs, key: string): number | undefined {
  const raw = parsed.flags.get(key)?.[0];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`参数 --${key} 不是有效数字：${raw}`);
  return value;
}

function defaultRunsDir(): string {
  return process.env.AUDIO_COMPARE_RUNS_DIR ?? "./audio-compare-runs";
}

/** 信号取消：第一次置令牌（协作式退出并清理），第二次强退。 */
function wireCancelSignals(token: CancelToken): () => void {
  let hits = 0;
  const handler = (): void => {
    hits += 1;
    token.cancel();
    if (hits > 1) process.exit(130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

const consoleLog: RunHooks["log"] = (message) => console.log(message);

async function executeRun(options: CompareOptions): Promise<number> {
  const token = new CancelToken();
  const unwire = wireCancelSignals(token);
  try {
    const summary = await runCompare({ ...options, cancelToken: token }, { log: consoleLog });
    console.log(`\n对比完成：${summary.version}`);
    console.log(`报告：${summary.reportMdPath}`);
    return 0;
  } catch (err) {
    if (err instanceof CancelError) {
      console.error("已取消：临时对象已清理，状态已保存，可用相同命令续跑");
      return 130;
    }
    if (err instanceof CompareError) {
      console.error(`错误 [${err.code}]：${err.message}`);
      if (err.code === "VERSION_IMMUTABLE" || err.code === "INPUT_CHANGED" || err.code === "RUN_LOCKED") return 3;
      return 1;
    }
    console.error(`运行失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    unwire();
  }
}

async function cmdRun(parsed: ParsedArgs): Promise<number> {
  const version = requiredFlag(parsed, "version");
  const reference = requiredFlag(parsed, "reference");
  const candidates = parsed.flags.get("candidate") ?? [];
  if (candidates.length === 0) throw new Error("至少需要一个 --candidate");
  return executeRun({
    version,
    reference,
    candidates,
    runsDir: parsed.flags.get("runs-dir")?.[0] ?? defaultRunsDir(),
    targetLufs: optionalNumber(parsed, "target-lufs"),
    maxOffsetSeconds: optionalNumber(parsed, "max-offset-seconds"),
    keepTemp: parsed.booleans.has("keep-temp"),
  });
}

async function cmdResume(parsed: ParsedArgs): Promise<number> {
  const version = requiredFlag(parsed, "version");
  const runsDir = path.resolve(parsed.flags.get("runs-dir")?.[0] ?? defaultRunsDir());
  const state = readState(path.join(runsDir, version));
  if (!state) {
    console.error(`版本不存在：${version}`);
    return 2;
  }
  if (state.status === "completed") {
    console.error(`错误 [VERSION_IMMUTABLE]：版本 ${version} 已完成，历史版本不可覆盖`);
    return 3;
  }
  return executeRun({
    version,
    reference: state.options.reference,
    candidates: state.options.candidates,
    runsDir,
    targetLufs: state.options.targetLufs ?? undefined,
    maxOffsetSeconds: state.options.maxOffsetSeconds,
  });
}

function cmdCancel(parsed: ParsedArgs): number {
  const version = requiredFlag(parsed, "version");
  const runsDir = path.resolve(parsed.flags.get("runs-dir")?.[0] ?? defaultRunsDir());
  const runDir = path.join(runsDir, version);
  const state = readState(runDir);
  if (!state) {
    console.error(`版本不存在：${version}`);
    return 2;
  }
  if (state.status !== "running") {
    console.log(`版本 ${version} 当前状态为 ${state.status}，无需取消`);
    return 0;
  }
  fs.writeFileSync(path.join(runDir, "CANCEL"), new Date().toISOString());
  console.log(`已发送取消信号：${version}（运行方将在下一个检查点停止并清理临时对象）`);
  return 0;
}

function cmdList(parsed: ParsedArgs): number {
  const runsDir = path.resolve(parsed.flags.get("runs-dir")?.[0] ?? defaultRunsDir());
  if (!fs.existsSync(runsDir)) {
    console.log("（暂无运行记录）");
    return 0;
  }
  const rows: Array<{ version: string; status: string; updatedAt: string; error: string }> = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = readState(path.join(runsDir, entry.name));
    if (!state) continue;
    rows.push({
      version: state.version,
      status: state.status,
      updatedAt: state.updatedAt,
      error: state.error ?? "",
    });
  }
  rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (rows.length === 0) {
    console.log("（暂无运行记录）");
    return 0;
  }
  console.log(["版本".padEnd(20), "状态".padEnd(12), "更新时间".padEnd(28), "备注"].join(" "));
  for (const row of rows) {
    console.log(
      [row.version.padEnd(20), row.status.padEnd(12), row.updatedAt.padEnd(28), row.error.slice(0, 40)].join(" "),
    );
  }
  return 0;
}

function cmdShow(parsed: ParsedArgs): number {
  const version = requiredFlag(parsed, "version");
  const runsDir = path.resolve(parsed.flags.get("runs-dir")?.[0] ?? defaultRunsDir());
  const runDir = path.join(runsDir, version);
  const state = readState(runDir);
  if (!state) {
    console.error(`版本不存在：${version}`);
    return 2;
  }
  const reportPath = path.join(runDir, "artifacts", "report.md");
  if (state.status === "completed" && fs.existsSync(reportPath)) {
    process.stdout.write(fs.readFileSync(reportPath, "utf8"));
    return 0;
  }
  console.log(`版本 ${version} 状态：${state.status}`);
  if (state.error) console.log(`错误：${state.error}`);
  console.log("阶段进度：");
  for (const [name, record] of Object.entries(state.stages)) {
    console.log(`  ${name.padEnd(10)} ${record.status}`);
  }
  return state.status === "failed" || state.status === "cancelled" ? 1 : 0;
}

function directorySize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return total;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function cmdClean(parsed: ParsedArgs): number {
  const runsDir = path.resolve(parsed.flags.get("runs-dir")?.[0] ?? defaultRunsDir());
  if (!fs.existsSync(runsDir)) {
    console.log("（存档目录不存在）");
    return 0;
  }
  let freed = 0;
  let cleaned = 0;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const tmpDir = path.join(runsDir, entry.name, "tmp");
    if (!fs.existsSync(tmpDir)) continue;
    freed += directorySize(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    cleaned += 1;
  }
  console.log(`已清理 ${cleaned} 个运行的临时对象，释放 ${(freed / 1024 / 1024).toFixed(2)} MiB`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run":
        return await cmdRun(parseArgs(rest));
      case "resume":
        return await cmdResume(parseArgs(rest));
      case "cancel":
        return cmdCancel(parseArgs(rest));
      case "list":
        return cmdList(parseArgs(rest));
      case "show":
        return cmdShow(parseArgs(rest));
      case "clean":
        return cmdClean(parseArgs(rest));
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        return 0;
      case undefined:
        process.stdout.write(USAGE);
        return 2;
      default:
        console.error(`未知命令：${command}\n`);
        process.stdout.write(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

const invokedAsScript = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedAsScript) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
