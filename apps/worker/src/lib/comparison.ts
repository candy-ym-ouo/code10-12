import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  alignPair,
  applyGain,
  buildDifferenceSignal,
  downmixToMono,
  estimateOffset,
  measureLoudness,
  planLoudnessGain,
  resampleLinear,
  summarizeDifferences,
  type DifferenceSummary,
  type MonoPcm,
} from "./dsp.js";
import { decodeWithFfmpeg, decodeWav, encodeWavPcm16, PcmDecodeError, readFileBuffer } from "./pcm.js";
import type { Queue } from "bullmq";
import { deleteObjectQuiet, getObjectStream, objectExists, putObjectBytes } from "./s3.js";

const ANALYSIS_RATE = 48000;
const RENDER_RATE = 24000;
const PEAK_BUCKETS = 800;


export interface TrackInput {
  id: string;
  mediaId: string;
  position: number;
  role: "BASELINE" | "CANDIDATE";
  label: string;
  objectKey: string;
  originalName: string;
}

export interface ComparisonConfig {
  targetLufs: number;
  truePeakDbTp: number;
  windowMs: number;
  hopMs: number;
  maxOffsetMs: number;
}

interface Checkpoint {
  downloaded?: Record<string, string>; // mediaId -> local raw path
  measured?: Record<string, { integratedLufs: number | null; truePeak: number; samplePeak: number; gainDb: number; gain: number; truePeakLimited: boolean }>;
  offsetMs?: number;
  correlation?: number;
}

interface CancellationToken {
  cancelled: boolean;
  poll: () => Promise<boolean>;
}

function workDirFor(comparisonId: string): string {
  return path.join(tmpdir(), `practice-compare-${comparisonId}`);
}

/** 清理超过 maxAgeMs 的陈旧临时目录（worker 启动时调用）。 */
export async function sweepStaleCompareDirs(maxAgeMs = 24 * 60 * 60_000): Promise<number> {
  const fs = await import("node:fs/promises");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(tmpdir());
  } catch {
    return 0;
  }
  let removed = 0;
  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name.startsWith("practice-compare-"))
      .map(async (name) => {
        const full = path.join(tmpdir(), name);
        try {
          const stat = await fs.stat(full);
          if (now - stat.mtimeMs > maxAgeMs) {
            await rm(full, { recursive: true, force: true });
            removed += 1;
          }
        } catch {
          // 竞态删除忽略
        }
      }),
  );
  return removed;
}

function isLikelyWav(name: string): boolean {
  return /\.wav$/i.test(name);
}

async function loadCheckpoint(workDir: string): Promise<Checkpoint> {
  try {
    return JSON.parse(await readFile(path.join(workDir, "checkpoint.json"), "utf8")) as Checkpoint;
  } catch {
    return {};
  }
}

async function saveCheckpoint(workDir: string, checkpoint: Checkpoint): Promise<void> {
  await writeFile(path.join(workDir, "checkpoint.json"), JSON.stringify(checkpoint), "utf8");
}

function computePeaks(samples: Float32Array, bucketCount: number): number[] {
  if (samples.length === 0) return [];
  const buckets = Math.min(bucketCount, samples.length);
  const size = Math.floor(samples.length / buckets);
  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    let max = 0;
    const start = bucket * size;
    const end = bucket === buckets - 1 ? samples.length : start + size;
    for (let index = start; index < end; index += 1) {
      const abs = Math.abs(samples[index] ?? 0);
      if (abs > max) max = abs;
    }
    peaks.push(Number(max.toFixed(4)));
  }
  return peaks;
}

export class ComparisonCancelledError extends Error {
  constructor() {
    super("COMPARISON_CANCELLED");
    this.name = "ComparisonCancelledError";
  }
}

export class ComparisonFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = "ComparisonFailedError";
  }
}

/**
 * 执行一次多版本对比。幂等：READY/CANCELLED 直接返回；失败重跑沿用本地检查点。
 * 成功或取消后清理临时目录；失败时保留供续跑（由 sweepStaleCompareDirs 兜底）。
 */
export async function processComparison(
  prisma: PrismaClient,
  comparisonId: string,
  logger: (level: "info" | "warn" | "error", data: Record<string, unknown>, message: string) => void,
): Promise<void> {
  const comparison = await prisma.audioComparison.findUnique({
    where: { id: comparisonId },
    include: { tracks: { orderBy: { position: "asc" } } },
  });
  if (!comparison) return;
  if (comparison.status === "READY" || comparison.status === "CANCELLED") return;
  if (comparison.cancelRequested) {
    await cancelComparison(prisma, comparisonId, logger);
    return;
  }

  const workDir = workDirFor(comparisonId);
  await mkdir(workDir, { recursive: true });
  const checkpoint = await loadCheckpoint(workDir);

  const token: CancellationToken = {
    cancelled: false,
    async poll() {
      if (this.cancelled) return true;
      const live = await prisma.audioComparison.findUnique({
        where: { id: comparisonId },
        select: { cancelRequested: true, status: true },
      });
      this.cancelled = live?.cancelRequested === true || live?.status === "CANCELLED";
      return this.cancelled;
    },
  };

  const setProgress = async (stage: string, progressPct: number): Promise<void> => {
    await prisma.audioComparison.update({
      where: { id: comparisonId },
      data: { stage, progressPct: Math.min(99, progressPct) },
    });
  };

  const partialObjectKeys: string[] = [];
  try {
    await prisma.audioComparison.update({
      where: { id: comparisonId },
      data: { status: "PROCESSING", stage: "DECODING", progressPct: 1, failureCode: null, failureMessage: null },
    });

    const config: ComparisonConfig = {
      targetLufs: comparison.targetLufs,
      truePeakDbTp: comparison.truePeakDbTp,
      windowMs: comparison.windowMs,
      hopMs: comparison.hopMs,
      maxOffsetMs: comparison.maxOffsetMs,
    };

    // 1) 下载 + 解码到 48kHz 单声道
    if (await token.poll()) throw new ComparisonCancelledError();
    await setProgress("DECODING", 5);
    const tracks: Array<TrackInput & { mono: MonoPcm }> = [];
    checkpoint.downloaded ??= {};
    for (let index = 0; index < comparison.tracks.length; index += 1) {
      const track = comparison.tracks[index];
      if (!track) continue;
      if (!track.mediaId) {
        throw new ComparisonFailedError("MEDIA_NOT_READY", "源音频已被删除，无法重新计算该历史对比", true);
      }
      if (await token.poll()) throw new ComparisonCancelledError();
      const media = await prisma.mediaAsset.findUnique({
        where: { id: track.mediaId },
        select: { objectKey: true, originalName: true, status: true, userId: true },
      });
      if (!media || media.status !== "READY") {
        throw new ComparisonFailedError("MEDIA_NOT_READY", "引用的音频尚未就绪或已被删除", true);
      }
      const rawPath = path.join(workDir, `source-${track.position}${path.extname(media.originalName).slice(0, 12) || ".bin"}`);
      if (!checkpoint.downloaded[track.mediaId]) {
        const stream = await getObjectStream(media.objectKey);
        await pipeline(stream, createWriteStream(rawPath));
        checkpoint.downloaded[track.mediaId] = rawPath;
        await saveCheckpoint(workDir, checkpoint);
      }
      let nativeMono: Float32Array;
      let nativeRate: number;
      try {
        const buffer = await readFileBuffer(rawPath);
        if (isLikelyWav(media.originalName) || buffer.subarray(0, 4).toString("latin1") === "RIFF") {
          const decoded = decodeWav(buffer);
          nativeMono = downmixToMono(decoded.data, decoded.channels);
          nativeRate = decoded.sampleRate;
        } else {
          const decoded = await decodeWithFfmpeg(rawPath, ANALYSIS_RATE);
          nativeMono = decoded.data;
          nativeRate = decoded.sampleRate;
        }
      } catch (error) {
        if (error instanceof PcmDecodeError) {
          // 解码类错误重试不会改变结果，统一终止（用户可修正源文件后续跑）
          throw new ComparisonFailedError(
            error.code === "FFMPEG_UNAVAILABLE" ? "FFMPEG_UNAVAILABLE" : "DECODE_FAILED",
            error.code === "FFMPEG_UNAVAILABLE" ? "服务器缺少 ffmpeg，压缩格式暂无法对比，请上传 WAV" : "音频解码失败，请确认文件完整后重试",
            true,
          );
        }
        throw error;
      }
      const samples48 = nativeRate === ANALYSIS_RATE ? nativeMono : resampleLinear(nativeMono, nativeRate, ANALYSIS_RATE);
      const mono: MonoPcm = { sampleRate: ANALYSIS_RATE, samples: samples48 };
      tracks.push({
        id: track.id,
        mediaId: track.mediaId,
        position: track.position,
        role: track.role,
        label: track.label,
        objectKey: media.objectKey,
        originalName: media.originalName,
        mono,
      });
      await setProgress("DECODING", 5 + Math.round(((index + 1) / comparison.tracks.length) * 25));
    }

    if (tracks.length < 2) throw new ComparisonFailedError("NOT_ENOUGH_TRACKS", "至少需要两个音频版本", true);

    // 2) 响度测量与增益规划
    if (await token.poll()) throw new ComparisonCancelledError();
    await setProgress("LOUDNESS", 35);
    checkpoint.measured ??= {};
    for (const track of tracks) {
      const loudness = measureLoudness(track.mono.samples, track.mono.sampleRate);
      if ((loudness.integratedLufs === null || loudness.integratedLufs < -70) && loudness.samplePeak < 10 ** (-60 / 20)) {
        throw new ComparisonFailedError("SILENT_TRACK", `《${track.label}》是静音或响度过低，无法对比`, true);
      }
      const plan = planLoudnessGain(loudness, config.targetLufs, config.truePeakDbTp);
      checkpoint.measured[track.id] = {
        integratedLufs: loudness.integratedLufs,
        truePeak: loudness.truePeak,
        samplePeak: loudness.samplePeak,
        gainDb: plan.gainDb,
        gain: plan.gain,
        truePeakLimited: plan.truePeakLimited,
      };
    }
    await saveCheckpoint(workDir, checkpoint);

    // 3) 对齐（以第一轨为基线）
    if (await token.poll()) throw new ComparisonCancelledError();
    await setProgress("ALIGNING", 50);
    const baselineTrack = tracks[0];
    if (!baselineTrack) throw new ComparisonFailedError("NOT_ENOUGH_TRACKS", "至少需要两个音频版本", true);
    const candidateTrack = tracks[1];
    if (!candidateTrack) throw new ComparisonFailedError("NOT_ENOUGH_TRACKS", "至少需要两个音频版本", true);
    const normalizedTracks = tracks.map((track) => {
      const measured = checkpoint.measured![track.id]!;
      return {
        track,
        normalized: applyGain(track.mono.samples, measured.gain),
      };
    });
    const baselineNorm: MonoPcm = { sampleRate: ANALYSIS_RATE, samples: normalizedTracks[0]!.normalized };
    const candidateNorm: MonoPcm = { sampleRate: ANALYSIS_RATE, samples: normalizedTracks[1]!.normalized };
    const alignment = estimateOffset(baselineNorm, candidateNorm, config.maxOffsetMs);
    checkpoint.offsetMs = alignment.offsetMs;
    checkpoint.correlation = alignment.correlation;
    await saveCheckpoint(workDir, checkpoint);

    // 4) 逐窗差异
    if (await token.poll()) throw new ComparisonCancelledError();
    await setProgress("DIFFING", 60);
    const aligned48 = alignPair(baselineNorm, candidateNorm, alignment.offsetMs);
    const diff48 = buildDifferenceSignal(aligned48);
    const summary: DifferenceSummary = summarizeDifferences(aligned48, config.windowMs, config.hopMs);

    // 5) 渲染 24kHz 单声道对齐音频与差异音频
    if (await token.poll()) throw new ComparisonCancelledError();
    await setProgress("RENDERING", 80);
    const renderBase = resampleLinear(aligned48.baseline, aligned48.sampleRate, RENDER_RATE);
    const renderCand = resampleLinear(aligned48.candidate, aligned48.sampleRate, RENDER_RATE);
    const renderDiff = resampleLinear(diff48, aligned48.sampleRate, RENDER_RATE);
    const baselineWav = encodeWavPcm16({ sampleRate: RENDER_RATE, channels: 1, data: renderBase });
    const candidateWav = encodeWavPcm16({ sampleRate: RENDER_RATE, channels: 1, data: renderCand });
    const diffWav = encodeWavPcm16({ sampleRate: RENDER_RATE, channels: 1, data: renderDiff });

    // 6) 上传产物（partialObjectKeys 记录，失败/取消时回滚）
    if (await token.poll()) throw new ComparisonCancelledError();
    await setProgress("UPLOADING", 88);
    const alignedBaseKey = `users/${comparison.userId}/comparisons/${comparisonId}/aligned-0.wav`;
    const alignedCandKey = `users/${comparison.userId}/comparisons/${comparisonId}/aligned-1.wav`;
    const diffKey = `users/${comparison.userId}/comparisons/${comparisonId}/diff.wav`;
    const reportKey = `users/${comparison.userId}/comparisons/${comparisonId}/report.json`;

    const uploads = [
      { key: alignedBaseKey, body: baselineWav, trackIndex: 0 },
      { key: alignedCandKey, body: candidateWav, trackIndex: 1 },
      { key: diffKey, body: diffWav, trackIndex: -1 },
    ];
    for (const upload of uploads) {
      if (await token.poll()) throw new ComparisonCancelledError();
      if (!(await objectExists(upload.key))) {
        await putObjectBytes(upload.key, upload.body, "audio/wav");
        partialObjectKeys.push(upload.key);
      }
    }

    if (await token.poll()) throw new ComparisonCancelledError();
    const measuredBase = checkpoint.measured![baselineTrack.id]!;
    const measuredCand = checkpoint.measured![tracks[1]!.id]!;
    const report = {
      schemaVersion: 1,
      comparisonId,
      generatedAt: new Date().toISOString(),
      config,
      alignment: { offsetMs: alignment.offsetMs, correlation: alignment.correlation },
      tracks: [
        {
          position: 0,
          role: baselineTrack.role,
          label: baselineTrack.label,
          mediaId: baselineTrack.mediaId,
          measuredLufs: round(measuredBase.integratedLufs, 2),
          gainDb: round(measuredBase.gainDb, 2),
          truePeakDb: round(20 * Math.log10(Math.max(measuredBase.truePeak, 1e-12)), 2),
          truePeakLimited: measuredBase.truePeakLimited,
        },
        {
          position: 1,
          role: tracks[1]!.role,
          label: tracks[1]!.label,
          mediaId: tracks[1]!.mediaId,
          measuredLufs: round(measuredCand.integratedLufs, 2),
          gainDb: round(measuredCand.gainDb, 2),
          truePeakDb: round(20 * Math.log10(Math.max(measuredCand.truePeak, 1e-12)), 2),
          truePeakLimited: measuredCand.truePeakLimited,
        },
      ],
      summary,
      peaks: {
        baseline: computePeaks(renderBase, PEAK_BUCKETS),
        candidate: computePeaks(renderCand, PEAK_BUCKETS),
        diff: computePeaks(renderDiff, PEAK_BUCKETS),
      },
      artifacts: { alignedBaseKey, alignedCandKey, diffKey },
    };
    const reportBuffer = Buffer.from(JSON.stringify(report), "utf8");
    await putObjectBytes(reportKey, reportBuffer, "application/json");
    partialObjectKeys.push(reportKey);

    // 7) 事务提交
    if (await token.poll()) throw new ComparisonCancelledError();
    await setProgress("FINALIZING", 97);
    const dbSummary = JSON.parse(JSON.stringify({
      alignment: { offsetMs: alignment.offsetMs, correlation: round(alignment.correlation, 4) },
      overallCorrelation: summary.overallCorrelation,
      similarityScore: summary.similarityScore,
      meanRmsDeltaDb: summary.meanRmsDeltaDb,
      maxRmsDeltaDb: summary.maxRmsDeltaDb,
      meanAbsDelta: summary.meanAbsDelta,
      coveragePct: summary.coveragePct,
      alignedDurationMs: summary.alignedDurationMs,
      worstWindows: summary.worstWindows,
      windowCount: summary.windows.length,
      tracks: report.tracks,
    })) as Prisma.InputJsonObject;

    // 整段事务由“行锁 + cancelRequested 条件”保护：
    // 取消流程要先把同一行置为 CANCELLED，必然等本事务提交/回滚，二者不可能交叉落库
    const commitCount = await prisma.$transaction(async (tx) => {
      await tx.comparisonTrack.update({
        where: { id: tracks[0]!.id },
        data: {
          measuredLufs: measuredBase.integratedLufs,
          gainDb: measuredBase.gainDb,
          peakDb: 20 * Math.log10(Math.max(measuredBase.truePeak, 1e-12)),
          offsetMs: 0,
          correlation: alignment.correlation,
          normalizedObjectKey: alignedBaseKey,
          normalizedReady: true,
        },
      });
      await tx.comparisonTrack.update({
        where: { id: tracks[1]!.id },
        data: {
          measuredLufs: measuredCand.integratedLufs,
          gainDb: measuredCand.gainDb,
          peakDb: 20 * Math.log10(Math.max(measuredCand.truePeak, 1e-12)),
          offsetMs: alignment.offsetMs,
          correlation: alignment.correlation,
          normalizedObjectKey: alignedCandKey,
          normalizedReady: true,
        },
      });
      const finalize = await tx.audioComparison.updateMany({
        where: { id: comparisonId, cancelRequested: false, status: { not: "CANCELLED" } },
        data: {
          status: "READY",
          stage: "DONE",
          progressPct: 100,
          summary: dbSummary,
          reportObjectKey: reportKey,
          diffObjectKey: diffKey,
          failureCode: null,
          failureMessage: null,
          completedAt: new Date(),
        },
      });
      return finalize.count;
    });

    if (commitCount === 0) {
      // 提交期间被取消：对象已上传但未被主表引用，交给幂等取消流程回滚
      throw new ComparisonCancelledError();
    }

    await rm(workDir, { recursive: true, force: true });
    logger("info", { comparisonId, similarityScore: summary.similarityScore, offsetMs: alignment.offsetMs }, "comparison completed");
  } catch (error) {
    if (error instanceof ComparisonCancelledError || (await token.poll())) {
      await cancelComparison(prisma, comparisonId, logger, partialObjectKeys);
      await rm(workDir, { recursive: true, force: true });
      return;
    }
    if (error instanceof ComparisonFailedError) {
      await prisma.audioComparison.update({
        where: { id: comparisonId },
        data: {
          status: "FAILED",
          stage: "FAILED",
          failureCode: error.code,
          failureMessage: error.message.slice(0, 500),
          completedAt: new Date(),
        },
      });
      logger("warn", { comparisonId, code: error.code, terminal: error.terminal }, "comparison failed");
      if (error.terminal) return;
    } else {
      await prisma.audioComparison.update({
        where: { id: comparisonId },
        data: {
          failureCode: "COMPARISON_RUN_FAILED",
          failureMessage: (error instanceof Error ? error.message : "UNKNOWN_ERROR").slice(0, 500),
        },
      });
    }
    logger("error", { comparisonId, err: error instanceof Error ? error.message : String(error) }, "comparison run failed");
    throw error; // BullMQ 重试（检查点保留，可续跑）
  }
}

/**
 * 取消：删除本对比的所有派生对象并落 CANCELLED。幂等。
 * extraKeys 用于回滚“已上传但未提交到 DB”的对象。
 * READY 行永不被改写——若发现对比已完成，立即放弃取消并保留对象。
 */
export async function cancelComparison(
  prisma: PrismaClient,
  comparisonId: string,
  logger: (level: "info" | "warn" | "error", data: Record<string, unknown>, message: string) => void,
  extraKeys: string[] = [],
): Promise<void> {
  const comparison = await prisma.audioComparison.findUnique({
    where: { id: comparisonId },
    select: { status: true, cancelRequested: true, reportObjectKey: true, diffObjectKey: true, tracks: { select: { normalizedObjectKey: true } } },
  });
  if (!comparison) return;
  if (comparison.status === "READY") {
    logger("info", { comparisonId }, "cancel ignored: comparison already READY");
    await rm(workDirFor(comparisonId), { recursive: true, force: true });
    return;
  }

  // 条件落库：只有非 READY 行能转为 CANCELLED（CANCELLED 行幂等重入）
  const result = await prisma.audioComparison.updateMany({
    where: { id: comparisonId, status: { not: "READY" } },
    data: {
      status: "CANCELLED",
      stage: "CANCELLED",
      progressPct: 0,
      summary: Prisma.DbNull,
      reportObjectKey: null,
      diffObjectKey: null,
      cancelledAt: new Date(),
      completedAt: new Date(),
      failureCode: null,
      failureMessage: null,
    },
  });
  if (result.count === 0) return;

  // 行已锁定为 CANCELLED，此时处理循环即使持有上传结果也无法再提交 READY
  const keys = new Set<string>(extraKeys);
  if (comparison.reportObjectKey) keys.add(comparison.reportObjectKey);
  if (comparison.diffObjectKey) keys.add(comparison.diffObjectKey);
  for (const track of comparison.tracks) {
    if (track.normalizedObjectKey) keys.add(track.normalizedObjectKey);
  }
  await Promise.all([...keys].map((key) => deleteObjectQuiet(key)));
  await prisma.comparisonTrack.updateMany({
    where: { comparisonId },
    data: { normalizedObjectKey: null, normalizedReady: false, measuredLufs: null, gainDb: null, peakDb: null, offsetMs: null, correlation: null },
  });
  await rm(workDirFor(comparisonId), { recursive: true, force: true });
  logger("info", { comparisonId, removedObjects: keys.size }, "comparison cancelled and cleaned");
}

function round(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Worker 启动恢复：崩溃会留下 PENDING/PROCESSING 行和孤儿 BullMQ 作业。
 * 重新入队所有非取消、非终态且超过 staleMs 未更新的对比；BullMQ 固定 jobId 天然去重。
 */
export async function recoverStaleComparisons(
  prisma: PrismaClient,
  queue: Queue,
  logger: (level: "info" | "warn" | "error", data: Record<string, unknown>, message: string) => void,
  staleMs = 5 * 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await prisma.audioComparison.findMany({
    where: {
      status: { in: ["PENDING", "PROCESSING"] },
      cancelRequested: false,
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
    take: 200,
  });
  for (const comparison of stale) {
    await queue.add(
      "compare-audio",
      { comparisonId: comparison.id },
      {
        jobId: `compare:${comparison.id}`,
        attempts: 4,
        backoff: { type: "exponential", delay: 4000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    );
    await prisma.audioComparison.update({
      where: { id: comparison.id },
      data: { status: "PENDING", stage: "QUEUED" },
    });
  }
  if (stale.length > 0) logger("info", { count: stale.length }, "stale comparisons re-enqueued");
  return stale.length;
}
