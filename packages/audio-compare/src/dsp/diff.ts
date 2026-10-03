/** 差异指标：对齐并响度归一后，量化候选版本与参考版本的残余差异。 */

import { fft, nextPow2 } from "./fft.js";
import { kWeightedSquares } from "./loudness.js";

export interface SegmentDivergence {
  startSec: number;
  endSec: number;
  /** 候选相对参考的 K 加权电平差（dB） */
  deltaDb: number;
  /** 区段内皮尔逊相关 -1..1 */
  correlation: number;
  /** 综合发散度：|ΔdB| + 20·(1-相关) */
  score: number;
}

export interface DiffMetrics {
  samples: number;
  /** 全重叠区皮尔逊相关 */
  correlation: number;
  /** 残余（参考-候选）RMS，dBFS */
  diffRmsDb: number;
  /** 残余 RMS 相对参考 RMS，dB；越小越一致 */
  residualToRefDb: number;
  /** 各频段平均幅度差（候选-参考，dB） */
  bandDeltaDb: Record<string, number>;
  topSegments: SegmentDivergence[];
  verdict: string;
}

export interface DiffOptions {
  segmentSeconds?: number;
  topSegments?: number;
  checkCancel?: (() => void) | undefined;
}

const BAND_EDGES = [0, 120, 500, 2000, 6000, 16000];

function averageBandMagnitudes(signal: Float32Array, fs: number, bands: Array<[number, number]>): number[] {
  const n = signal.length;
  let frame = 8192;
  if (n < frame) frame = nextPow2(Math.max(256, n));
  const hop = frame >> 1;
  const window = new Float64Array(frame);
  for (let i = 0; i < frame; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frame - 1)));
  const sums = new Float64Array(bands.length);
  const counts = new Float64Array(bands.length);
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const binHz = fs / frame;
  for (let start = 0; start + frame <= n || (start === 0 && n <= frame); start += hop) {
    re.fill(0);
    im.fill(0);
    const len = Math.min(frame, n - start);
    for (let i = 0; i < len; i += 1) re[i] = signal[start + i]! * window[i]!;
    fft(re, im, false);
    for (let b = 0; b < bands.length; b += 1) {
      const [lo, hi] = bands[b]!;
      const binLo = Math.max(1, Math.floor(lo / binHz));
      const binHi = Math.min(frame >> 1, Math.ceil(hi / binHz));
      let mag = 0;
      for (let k = binLo; k < binHi; k += 1) mag += Math.hypot(re[k]!, im[k]!);
      if (binHi > binLo) {
        sums[b] = sums[b]! + mag / (binHi - binLo);
        counts[b] = counts[b]! + 1;
      }
    }
    if (start + frame >= n) break;
  }
  const out: number[] = [];
  for (let b = 0; b < bands.length; b += 1) {
    out.push(counts[b]! > 0 ? sums[b]! / counts[b]! : 0);
  }
  return out;
}

function computeBandDeltas(ref: Float32Array, cand: Float32Array, fs: number): Record<string, number> {
  const nyquist = fs / 2;
  const edges = BAND_EDGES.filter((e) => e < nyquist);
  if (edges.length < 3) return {};
  const bands: Array<[number, number]> = [];
  for (let i = 0; i + 1 < edges.length; i += 1) bands.push([edges[i]!, edges[i + 1]!]);
  const top = Math.min(16000, nyquist);
  const lastEdge = edges[edges.length - 1]!;
  if (lastEdge < top) bands.push([lastEdge, top]);
  const refMags = averageBandMagnitudes(ref, fs, bands);
  const candMags = averageBandMagnitudes(cand, fs, bands);
  const out: Record<string, number> = {};
  for (let b = 0; b < bands.length; b += 1) {
    const [lo, hi] = bands[b]!;
    const delta = 20 * Math.log10((candMags[b]! + 1e-12) / (refMags[b]! + 1e-12));
    out[`${lo}-${hi}`] = Number(delta.toFixed(2));
  }
  return out;
}

function computeSegments(
  ref: Float32Array,
  cand: Float32Array,
  fs: number,
  segmentSeconds: number,
  topN: number,
): SegmentDivergence[] {
  const n = Math.min(ref.length, cand.length);
  const segLen = Math.max(1, Math.round(segmentSeconds * fs));
  const zRef = kWeightedSquares([ref], fs);
  const zCand = kWeightedSquares([cand], fs);
  const segments: SegmentDivergence[] = [];
  for (let start = 0; start + Math.round(0.25 * segLen) <= n; start += segLen) {
    const end = Math.min(n, start + segLen);
    const len = end - start;
    let sumR = 0;
    let sumC = 0;
    let sumRR = 0;
    let sumCC = 0;
    let sumRC = 0;
    let zr = 0;
    let zc = 0;
    for (let i = start; i < end; i += 1) {
      const r = ref[i]!;
      const c = cand[i]!;
      sumR += r;
      sumC += c;
      sumRR += r * r;
      sumCC += c * c;
      sumRC += r * c;
      zr += zRef[i]!;
      zc += zCand[i]!;
    }
    const meanSqR = sumRR / len;
    const meanSqC = sumCC / len;
    // 双静音区段不参与排名
    if (Math.max(meanSqR, meanSqC) < 1e-6) continue;
    const covNum = len * sumRC - sumR * sumC;
    const covDen = Math.sqrt(Math.max(1e-30, (len * sumRR - sumR * sumR) * (len * sumCC - sumC * sumC)));
    const correlation = covNum / covDen;
    let deltaDb = 10 * Math.log10(Math.max(zc, 1e-20) / Math.max(zr, 1e-20));
    if (!Number.isFinite(deltaDb)) deltaDb = 0;
    deltaDb = Math.max(-60, Math.min(60, deltaDb));
    const score = Math.abs(deltaDb) + 20 * (1 - correlation);
    segments.push({
      startSec: Number((start / fs).toFixed(3)),
      endSec: Number((end / fs).toFixed(3)),
      deltaDb: Number(deltaDb.toFixed(2)),
      correlation: Number(correlation.toFixed(4)),
      score: Number(score.toFixed(3)),
    });
  }
  segments.sort((a, b) => b.score - a.score);
  return segments.slice(0, topN);
}

function verdictOf(correlation: number, residualToRefDb: number): string {
  if (correlation >= 0.999 && residualToRefDb <= -40) return "高度一致（仅电平/细微差异）";
  if (correlation >= 0.98 && residualToRefDb <= -25) return "基本一致，存在局部差异";
  return "存在明显内容差异";
}

export function computeDiff(
  ref: Float32Array,
  cand: Float32Array,
  fs: number,
  options: DiffOptions = {},
): DiffMetrics {
  const n = Math.min(ref.length, cand.length);
  if (n === 0) throw new Error("DIFF_EMPTY_OVERLAP");
  const check = options.checkCancel;
  check?.();
  let sumR = 0;
  let sumC = 0;
  let sumRR = 0;
  let sumCC = 0;
  let sumRC = 0;
  let sumDD = 0;
  for (let i = 0; i < n; i += 1) {
    const r = ref[i]!;
    const c = cand[i]!;
    const d = r - c;
    sumR += r;
    sumC += c;
    sumRR += r * r;
    sumCC += c * c;
    sumRC += r * c;
    sumDD += d * d;
  }
  const covNum = n * sumRC - sumR * sumC;
  const covDen = Math.sqrt(Math.max(1e-30, (n * sumRR - sumR * sumR) * (n * sumCC - sumC * sumC)));
  const correlation = covNum / covDen;
  const rmsRef = Math.sqrt(sumRR / n);
  const rmsDiff = Math.sqrt(sumDD / n);
  const diffRmsDb = rmsDiff <= 0 ? -Infinity : 20 * Math.log10(rmsDiff);
  const residualToRefDb = rmsDiff <= 0 ? -Infinity : rmsRef <= 0 ? Infinity : 20 * Math.log10(rmsDiff / rmsRef);
  check?.();
  const bandDeltaDb = computeBandDeltas(ref.subarray(0, n), cand.subarray(0, n), fs);
  check?.();
  const topSegments = computeSegments(
    ref.subarray(0, n),
    cand.subarray(0, n),
    fs,
    options.segmentSeconds ?? 1,
    options.topSegments ?? 5,
  );
  return {
    samples: n,
    correlation: Number(correlation.toFixed(6)),
    diffRmsDb: Number(diffRmsDb.toFixed(2)),
    residualToRefDb: Number(residualToRefDb.toFixed(2)),
    bandDeltaDb,
    topSegments,
    verdict: verdictOf(correlation, residualToRefDb),
  };
}
