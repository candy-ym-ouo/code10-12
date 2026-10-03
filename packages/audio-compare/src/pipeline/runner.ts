/**
 * 对比流水线编排：分阶段执行、状态持久化、失败续跑、取消清理、历史版本不可覆盖。
 *
 * 运行目录结构：
 *   <runsDir>/<version>/
 *     state.json        状态机（原子写入）
 *     .lock             进程锁（pid）
 *     CANCEL            取消信号文件（出现即取消）
 *     tmp/              临时对象（解码 PCM、归一化 PCM），取消/完成时清理
 *     artifacts/        最终产物（report.json、report.md、各阶段结果 JSON）
 */

import fs from "node:fs";
import path from "node:path";
import { alignSignals, extractOverlap } from "../dsp/align.js";
import { computeDiff, type DiffMetrics } from "../dsp/diff.js";
import { applyGainDb, integratedLufs, peakDbfs } from "../dsp/loudness.js";
import { decodeWav, downmixToMono, resampleLinear } from "../dsp/wav.js";
import { composeReport } from "./report.js";
import {
  STAGES,
  assertValidVersion,
  hashFile,
  initialState,
  readJson,
  readState,
  writeJsonAtomic,
  writeStateAtomic,
  type CompareOptionsSnapshot,
  type InputFingerprint,
  type RunState,
  type RunStatus,
  type StageName,
} from "./state.js";

export type CompareErrorCode =
  | "VERSION_IMMUTABLE"
  | "INPUT_CHANGED"
  | "RUN_LOCKED"
  | "UNSUPPORTED_FORMAT"
  | "MISSING_INPUT"
  | "INVALID_STATE";

export class CompareError extends Error {
  readonly code: CompareErrorCode;
  constructor(code: CompareErrorCode, message: string) {
    super(message);
    this.name = "CompareError";
    this.code = code;
  }
}

export class CancelError extends Error {
  constructor() {
    super("已取消");
    this.name = "CancelError";
  }
}

/** 协作式取消令牌：CLI 信号、API 调用方均可触发。 */
export class CancelToken {
  private flag = false;
  cancel(): void {
    this.flag = true;
  }
  get cancelled(): boolean {
    return this.flag;
  }
}

export interface CompareOptions {
  runsDir: string;
  version: string;
  reference: string;
  candidates: string[];
  /** 显式归一目标（LUFS）；缺省归一到参考版本响度 */
  targetLufs?: number | undefined;
  maxOffsetSeconds?: number | undefined;
  /** 调试用：完成后保留 tmp/ */
  keepTemp?: boolean | undefined;
  cancelToken?: CancelToken | undefined;
}

export interface RunHooks {
  onStageStart?: ((stage: StageName) => void) | undefined;
  onStageDone?: ((stage: StageName) => void) | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface RunSummary {
  version: string;
  runDir: string;
  status: RunStatus;
  reportJsonPath: string;
  reportMdPath: string;
}

interface PcmMeta {
  key: string;
  name: string;
  sourcePath: string;
  sampleRate: number;
  originalSampleRate: number;
  samples: number;
}

interface InputsArtifact {
  reference: InputFingerprint & { key: string; name: string };
  candidates: Array<InputFingerprint & { key: string; name: string }>;
}

function displayName(file: string, taken: Set<string>): string {
  const base = path.basename(file).replace(/\.[^.]+$/, "") || "audio";
  let name = base;
  let index = 2;
  while (taken.has(name)) {
    name = `${base}#${index}`;
    index += 1;
  }
  taken.add(name);
  return name;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runCompare(options: CompareOptions, hooks: RunHooks = {}): Promise<RunSummary> {
  assertValidVersion(options.version);
  const version = options.version;
  const runsDir = path.resolve(options.runsDir);
  const runDir = path.join(runsDir, version);
  const tmpDir = path.join(runDir, "tmp");
  const pcmDir = path.join(tmpDir, "pcm");
  const artifactsDir = path.join(runDir, "artifacts");
  const cancelFile = path.join(runDir, "CANCEL");
  const lockFile = path.join(runDir, ".lock");

  const reference = path.resolve(options.reference);
  const candidates = options.candidates.map((p) => path.resolve(p));
  if (candidates.length === 0) {
    throw new CompareError("MISSING_INPUT", "至少需要一个候选版本（--candidate）");
  }
  for (const file of [reference, ...candidates]) {
    if (!fs.existsSync(file)) throw new CompareError("MISSING_INPUT", `输入文件不存在：${file}`);
  }
  const snapshot: CompareOptionsSnapshot = {
    reference,
    candidates,
    targetLufs: options.targetLufs ?? null,
    maxOffsetSeconds: options.maxOffsetSeconds ?? 30,
  };

  // ---- 历史版本检查：已完成 → 不可覆盖；未完成 → 校验输入指纹后续跑 ----
  let state = readState(runDir);
  if (state) {
    if (state.status === "completed") {
      throw new CompareError(
        "VERSION_IMMUTABLE",
        `版本 ${version} 已完成，历史版本不可覆盖；请使用新的版本号`,
      );
    }
    if (state.inputs) {
      await verifyInputsUnchanged(state.inputs, reference, candidates);
    }
  }

  // ---- 进程锁：防止并发写同一运行目录 ----
  fs.mkdirSync(runDir, { recursive: true });
  acquireLock(lockFile);
  fs.rmSync(cancelFile, { force: true });

  const token = options.cancelToken;
  let lastCancelFileCheck = 0;
  const cancelFileSeen = (): boolean => {
    const now = Date.now();
    if (now - lastCancelFileCheck < 100) return false;
    lastCancelFileCheck = now;
    return fs.existsSync(cancelFile);
  };
  /** 循环内检查：令牌每次查，取消文件节流（避免频繁 stat） */
  const checkCancel = (): void => {
    if (token?.cancelled) throw new CancelError();
    if (cancelFileSeen()) throw new CancelError();
  };
  /** 阶段边界检查：不节流，保证取消信号在阶段切换时必定生效 */
  const checkCancelAtBoundary = (): void => {
    if (token?.cancelled) throw new CancelError();
    lastCancelFileCheck = 0;
    if (cancelFileSeen()) throw new CancelError();
  };

  const save = (): void => writeStateAtomic(runDir, state!);

  try {
    if (!state) {
      state = initialState(version, snapshot);
      save();
    } else {
      state.status = "running";
      state.error = null;
      reconcileStages(state, runDir);
      save();
    }

    const runStage = async (name: StageName, fn: () => Promise<string[]>): Promise<void> => {
      const record = state!.stages[name];
      if (record.status === "done") {
        hooks.log?.(`阶段 ${name} 已完成，跳过`);
        return;
      }
      checkCancelAtBoundary();
      hooks.onStageStart?.(name);
      record.status = "running";
      record.startedAt = new Date().toISOString();
      record.error = null;
      save();
      try {
        const outputs = await fn();
        record.status = "done";
        record.finishedAt = new Date().toISOString();
        record.outputs = outputs;
        save();
        hooks.onStageDone?.(name);
      } catch (err) {
        if (err instanceof CancelError) {
          record.status = "pending";
          record.error = null;
          save();
        } else {
          record.status = "failed";
          record.error = errorMessage(err);
          save();
        }
        throw err;
      }
    };

    // ---- validate：校验格式、计算输入指纹 ----
    await runStage("validate", async () => {
      fs.mkdirSync(artifactsDir, { recursive: true });
      const taken = new Set<string>();
      const entries: Array<InputFingerprint & { key: string; name: string }> = [];
      const all = [["ref", reference], ...candidates.map((c, i) => [`cand${i}`, c])] as Array<[string, string]>;
      for (const [key, file] of all) {
        checkCancel();
        if (path.extname(file).toLowerCase() !== ".wav") {
          throw new CompareError(
            "UNSUPPORTED_FORMAT",
            `仅支持 WAV（PCM/浮点）输入：${file}；其他格式请先用 ffmpeg 转码，例如 ffmpeg -i in.mp3 -ar 48000 out.wav`,
          );
        }
        const { sha256, bytes } = await hashFile(file);
        entries.push({ key, name: displayName(file, taken), path: file, sha256, bytes });
      }
      const artifact: InputsArtifact = {
        reference: entries[0]!,
        candidates: entries.slice(1),
      };
      state!.inputs = {
        reference: { path: artifact.reference.path, sha256: artifact.reference.sha256, bytes: artifact.reference.bytes },
        candidates: artifact.candidates.map((c) => ({ path: c.path, sha256: c.sha256, bytes: c.bytes })),
      };
      save();
      const out = path.join("artifacts", "inputs.json");
      writeJsonAtomic(path.join(runDir, out), artifact);
      return [out];
    });

    // ---- decode：解码 → 单声道 → 统一采样率 → tmp/pcm ----
    await runStage("decode", async () => {
      fs.mkdirSync(pcmDir, { recursive: true });
      const inputs = readJson<InputsArtifact>(path.join(artifactsDir, "inputs.json"));
      const entries = [inputs.reference, ...inputs.candidates];
      const decoded = entries.map((entry) => {
        checkCancel();
        return { entry, wav: decodeWav(fs.readFileSync(entry.path)) };
      });
      const targetRate = Math.max(...decoded.map((d) => d.wav.sampleRate));
      const outputs: string[] = [];
      decoded.forEach(({ entry, wav }) => {
        checkCancel();
        let mono = downmixToMono(wav.channels);
        if (wav.sampleRate !== targetRate) mono = resampleLinear(mono, wav.sampleRate, targetRate);
        const pcmRel = path.join("tmp", "pcm", `${entry.key}.f32`);
        const metaRel = path.join("tmp", "pcm", `${entry.key}.json`);
        fs.writeFileSync(path.join(runDir, pcmRel), Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength));
        const meta: PcmMeta = {
          key: entry.key,
          name: entry.name,
          sourcePath: entry.path,
          sampleRate: targetRate,
          originalSampleRate: wav.sampleRate,
          samples: mono.length,
        };
        writeJsonAtomic(path.join(runDir, metaRel), meta);
        outputs.push(pcmRel, metaRel);
      });
      return outputs;
    });

    // ---- align：每个候选与参考做同段对齐 ----
    await runStage("align", async () => {
      const inputs = readJson<InputsArtifact>(path.join(artifactsDir, "inputs.json"));
      const refPcm = loadPcm(runDir, "ref");
      const results = [];
      for (const cand of inputs.candidates) {
        checkCancel();
        const candPcm = loadPcm(runDir, cand.key);
        const result = alignSignals(refPcm.data, candPcm.data, refPcm.meta.sampleRate, {
          maxOffsetSeconds: snapshot.maxOffsetSeconds,
          checkCancel,
        });
        results.push({ key: cand.key, name: cand.name, ...result });
      }
      const out = path.join("artifacts", "alignment.json");
      writeJsonAtomic(path.join(runDir, out), {
        sampleRate: refPcm.meta.sampleRate,
        reference: inputs.reference.name,
        results,
      });
      return [out];
    });

    // ---- normalize：响度归一（候选 → 目标响度） ----
    await runStage("normalize", async () => {
      const inputs = readJson<InputsArtifact>(path.join(artifactsDir, "inputs.json"));
      const refPcm = loadPcm(runDir, "ref");
      const fsRate = refPcm.meta.sampleRate;
      const refLufs = integratedLufs([refPcm.data], fsRate);
      const explicitTarget = snapshot.targetLufs;
      if (!Number.isFinite(refLufs) && explicitTarget === null) {
        throw new CompareError(
          "INVALID_STATE",
          "参考版本为静音，无法作为响度基准；请使用 --target-lufs 显式指定目标响度",
        );
      }
      const target = explicitTarget ?? refLufs;
      const outputs: string[] = [];
      const writeNormalized = (key: string, data: Float32Array, gainDb: number): Float32Array => {
        const normalized = applyGainDb(data, gainDb);
        const rel = path.join("tmp", "pcm", `${key}.norm.f32`);
        fs.writeFileSync(path.join(runDir, rel), Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength));
        outputs.push(rel);
        return normalized;
      };
      const refGainDb = explicitTarget !== null && Number.isFinite(refLufs) ? explicitTarget - refLufs : 0;
      const refNormalized = writeNormalized("ref", refPcm.data, refGainDb);
      const referenceInfo = {
        key: "ref",
        name: inputs.reference.name,
        lufs: refLufs,
        gainDb: refGainDb,
        peakDb: peakDbfs(refPcm.data),
        peakDbAfterGain: peakDbfs(refNormalized),
      };
      const candidateInfos = [];
      for (const cand of inputs.candidates) {
        checkCancel();
        const candPcm = loadPcm(runDir, cand.key);
        const lufs = integratedLufs([candPcm.data], fsRate);
        const silent = !Number.isFinite(lufs);
        const gainDb = silent ? 0 : target - lufs;
        const normalized = writeNormalized(cand.key, candPcm.data, gainDb);
        const peakAfter = peakDbfs(normalized);
        candidateInfos.push({
          key: cand.key,
          name: cand.name,
          lufs,
          gainDb,
          normalizedLufs: silent ? -Infinity : lufs + gainDb,
          peakDb: peakDbfs(candPcm.data),
          peakDbAfterGain: peakAfter,
          clipRisk: peakAfter > 0,
          silent,
        });
      }
      const out = path.join("artifacts", "loudness.json");
      writeJsonAtomic(path.join(runDir, out), {
        targetLufs: target,
        reference: referenceInfo,
        candidates: candidateInfos,
      });
      outputs.push(out);
      return outputs;
    });

    // ---- diff：对齐 + 归一后的残余差异 ----
    await runStage("diff", async () => {
      const inputs = readJson<InputsArtifact>(path.join(artifactsDir, "inputs.json"));
      const alignment = readJson<{
        sampleRate: number;
        results: Array<{ key: string; name: string; offsetSamples: number; confidence: number; overlapSamples: number }>;
      }>(path.join(artifactsDir, "alignment.json"));
      const fsRate = alignment.sampleRate;
      const refNorm = loadNormPcm(runDir, "ref");
      const outputs: string[] = [];
      for (const cand of inputs.candidates) {
        checkCancel();
        const align = alignment.results.find((r) => r.key === cand.key);
        if (!align) throw new CompareError("INVALID_STATE", `缺少对齐结果：${cand.key}`);
        const candNorm = loadNormPcm(runDir, cand.key);
        const { refSeg, candSeg, length } = extractOverlap(refNorm, candNorm, align.offsetSamples);
        let metrics: DiffMetrics;
        if (length < Math.round(fsRate * 0.25)) {
          metrics = {
            samples: length,
            correlation: 0,
            diffRmsDb: 0,
            residualToRefDb: Infinity,
            bandDeltaDb: {},
            topSegments: [],
            verdict: "重叠区过短，无法比较",
          };
        } else {
          metrics = computeDiff(refSeg, candSeg, fsRate, { checkCancel });
          if (align.confidence < 0.3) {
            metrics.verdict = "对齐置信度低，内容可能不同，差异指标仅供参考";
          }
        }
        const out = path.join("artifacts", `diff.${cand.key}.json`);
        writeJsonAtomic(path.join(runDir, out), { key: cand.key, name: cand.name, ...metrics });
        outputs.push(out);
      }
      return outputs;
    });

    // ---- report：汇总报告 ----
    await runStage("report", async () => {
      const inputs = readJson<InputsArtifact>(path.join(artifactsDir, "inputs.json"));
      const alignment = readJson<import("./report.js").AlignmentArtifact>(path.join(artifactsDir, "alignment.json"));
      const loudness = readJson<import("./report.js").LoudnessArtifact>(path.join(artifactsDir, "loudness.json"));
      const diffs = inputs.candidates.map((cand) =>
        readJson<import("./report.js").DiffArtifact>(path.join(artifactsDir, `diff.${cand.key}.json`)),
      );
      const report = composeReport({
        version,
        createdAt: state!.createdAt,
        inputs,
        alignment,
        loudness,
        diffs,
      });
      const jsonRel = path.join("artifacts", "report.json");
      const mdRel = path.join("artifacts", "report.md");
      writeJsonAtomic(path.join(runDir, jsonRel), report.json);
      fs.writeFileSync(path.join(runDir, mdRel), report.markdown);
      return [jsonRel, mdRel];
    });

    state.status = "completed";
    state.error = null;
    save();
    if (!options.keepTemp) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(cancelFile, { force: true });
    return {
      version,
      runDir,
      status: state.status,
      reportJsonPath: path.join(artifactsDir, "report.json"),
      reportMdPath: path.join(artifactsDir, "report.md"),
    };
  } catch (err) {
    if (err instanceof CancelError) {
      state!.status = "cancelled";
      state!.error = null;
      save();
      // 取消后清理临时对象
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(cancelFile, { force: true });
    } else {
      state!.status = "failed";
      state!.error = errorMessage(err);
      // 失败保留 tmp/ 现场，续跑可直接复用已解码产物
      save();
    }
    throw err;
  } finally {
    releaseLock(lockFile);
  }
}

/** 续跑前校验：输入指纹必须与首次运行一致，防止“同名版本换了内容”。 */
async function verifyInputsUnchanged(
  stored: { reference: InputFingerprint; candidates: InputFingerprint[] },
  reference: string,
  candidates: string[],
): Promise<void> {
  const expected = [stored.reference, ...stored.candidates];
  const actual = [reference, ...candidates];
  if (expected.length !== actual.length) {
    throw new CompareError("INPUT_CHANGED", "候选数量与首次运行不一致；请使用新的版本号");
  }
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]!;
    const gotPath = actual[i]!;
    if (path.resolve(gotPath) !== want.path) {
      throw new CompareError("INPUT_CHANGED", `输入路径与首次运行不一致：${gotPath} ≠ ${want.path}`);
    }
    const { sha256, bytes } = await hashFile(gotPath);
    if (sha256 !== want.sha256 || bytes !== want.bytes) {
      throw new CompareError(
        "INPUT_CHANGED",
        `输入内容已变化：${gotPath}；历史版本不可篡改，请使用新的版本号`,
      );
    }
  }
}

/**
 * 续跑 reconcile：输入经 SHA-256 指纹锁定、各阶段确定性，
 * 故按“done 且产物齐全”独立判定每个阶段是否可跳过；
 * 产物缺失（如 tmp 已清理）或状态非 done 的阶段重置为 pending。
 */
function reconcileStages(state: RunState, runDir: string): void {
  for (const name of STAGES) {
    const record = state.stages[name];
    if (record.status === "done") {
      const missing = record.outputs.some((rel) => !fs.existsSync(path.join(runDir, rel)));
      if (missing) resetStage(record);
    } else if (record.status !== "pending") {
      resetStage(record);
    }
  }
}

function resetStage(record: RunState["stages"][StageName]): void {
  record.status = "pending";
  record.startedAt = null;
  record.finishedAt = null;
  record.outputs = [];
  record.error = null;
}

function acquireLock(lockFile: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(fs.readFileSync(lockFile, "utf8"));
      if (pid && isProcessAlive(pid)) {
        throw new CompareError("RUN_LOCKED", `版本正在被进程 ${pid} 运行；如确认已退出请删除 ${lockFile}`);
      }
      fs.rmSync(lockFile, { force: true });
    }
  }
  throw new CompareError("RUN_LOCKED", "无法获取运行锁");
}

function releaseLock(lockFile: string): void {
  try {
    if (fs.existsSync(lockFile) && Number(fs.readFileSync(lockFile, "utf8")) === process.pid) {
      fs.rmSync(lockFile, { force: true });
    }
  } catch {
    // 锁释放失败不影响结果
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LoadedPcm {
  meta: PcmMeta;
  data: Float32Array;
}

function loadPcm(runDir: string, key: string): LoadedPcm {
  const meta = readJson<PcmMeta>(path.join(runDir, "tmp", "pcm", `${key}.json`));
  const buffer = fs.readFileSync(path.join(runDir, "tmp", "pcm", `${key}.f32`));
  return { meta, data: toFloat32Array(buffer) };
}

function loadNormPcm(runDir: string, key: string): Float32Array {
  return toFloat32Array(fs.readFileSync(path.join(runDir, "tmp", "pcm", `${key}.norm.f32`)));
}

/** Buffer → Float32Array（复制到对齐的 ArrayBuffer，避免池化 Buffer 偏移未对齐）。 */
function toFloat32Array(buffer: Buffer): Float32Array {
  const aligned = new ArrayBuffer(buffer.length);
  new Uint8Array(aligned).set(buffer);
  return new Float32Array(aligned);
}
