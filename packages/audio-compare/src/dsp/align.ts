/**
 * 同段对齐：包络互相关粗对齐 + 采样级细化 + 抛物线亚采样插值。
 * 约定：offset > 0 表示候选版本比参考版本“晚开始”offset 个采样，
 * 即 cand[t] ≈ ref[t - offset]；对齐配对为 ref[i] ↔ cand[i + offset]。
 */

import { crossCorrelation } from "./fft.js";

export interface AlignmentResult {
  /** 整数采样偏移（候选相对参考的延迟） */
  offsetSamples: number;
  offsetSeconds: number;
  /** 抛物线插值得到的亚采样偏移（仅供展示，配对仍按整数偏移） */
  subSampleOffsetSamples: number;
  /** 归一化相关峰值 0..1，越接近 1 对齐越可信 */
  confidence: number;
  /** 相关峰为强负值时标记（疑似反相版本） */
  polarityInverted: boolean;
  /** 按该偏移对齐后的重叠采样数 */
  overlapSamples: number;
}

export interface AlignOptions {
  maxOffsetSeconds?: number;
  envelopeRate?: number;
  checkCancel?: (() => void) | undefined;
}

function envelope(input: Float32Array, fs: number, factor: number): Float32Array {
  // 绝对值整流 + 15Hz 一阶低通，再按 factor 抽取
  const alpha = 1 - Math.exp((-2 * Math.PI * 15) / fs);
  const out = new Float32Array(Math.ceil(input.length / factor));
  let y = 0;
  let idx = 0;
  for (let i = 0; i < input.length; i += 1) {
    y += alpha * (Math.abs(input[i]!) - y);
    if (i % factor === factor - 1 || i === input.length - 1) {
      out[idx] = y;
      idx += 1;
    }
  }
  return out.subarray(0, idx) as Float32Array;
}

function directBestLag(
  ref: Float32Array,
  cand: Float32Array,
  centerLag: number,
  range: number,
): number {
  // 按 |相关| 取峰：反相版本的相关峰为强负值，延迟仍然正确
  let bestLag = centerLag;
  let bestValue = -Infinity;
  for (let lag = centerLag - range; lag <= centerLag + range; lag += 1) {
    const start = Math.max(0, -lag);
    const end = Math.min(ref.length, cand.length - lag);
    let acc = 0;
    for (let i = start; i < end; i += 1) acc += ref[i]! * cand[i + lag]!;
    const magnitude = Math.abs(acc);
    if (magnitude > bestValue) {
      bestValue = magnitude;
      bestLag = lag;
    }
  }
  return bestLag;
}

export function alignSignals(
  ref: Float32Array,
  cand: Float32Array,
  fs: number,
  options: AlignOptions = {},
): AlignmentResult {
  if (ref.length === 0 || cand.length === 0) throw new Error("ALIGN_EMPTY_INPUT");
  const check = options.checkCancel;
  const maxOffsetSeconds = options.maxOffsetSeconds ?? 30;
  const factor = Math.max(1, Math.round(fs / (options.envelopeRate ?? 200)));

  // 1) 包络粗对齐
  check?.();
  const envRef = envelope(ref, fs, factor);
  const envCand = envelope(cand, fs, factor);
  const corr = crossCorrelation(envRef, envCand);
  const corrBase = envCand.length - 1;
  const maxLagEnv = Math.max(
    1,
    Math.min(Math.floor((maxOffsetSeconds * fs) / factor), Math.max(envRef.length, envCand.length) - 1),
  );
  const lagLo = Math.max(-(envCand.length - 1), -maxLagEnv);
  const lagHi = Math.min(envRef.length - 1, maxLagEnv);
  let bestLagEnv = 0;
  let bestValue = -Infinity;
  for (let lag = lagLo; lag <= lagHi; lag += 1) {
    const v = corr[lag + corrBase]!;
    if (v > bestValue) {
      bestValue = v;
      bestLagEnv = lag;
    }
  }
  const coarse = bestLagEnv * factor;

  // 2) 采样级细化（在粗对齐重叠区上开小窗）
  check?.();
  const search = 3 * factor + 8;
  const ovStart = Math.max(0, -coarse);
  const ovEnd = Math.min(ref.length, cand.length - coarse);
  const overlapAtCoarse = ovEnd - ovStart;
  let refined = coarse;
  let subSample = coarse;
  if (overlapAtCoarse > 0) {
    const maxWindow = 1 << 18;
    const windowLen = Math.min(maxWindow, overlapAtCoarse - 2 * search);
    if (windowLen >= 4096) {
      const w0 = ovStart + search;
      const refWin = ref.subarray(w0, w0 + windowLen);
      const candWin = cand.subarray(w0 + coarse - search, w0 + coarse + windowLen + search);
      const corrWin = crossCorrelation(refWin, candWin);
      const base = candWin.length - 1;
      // candWin 起点提前了 search 个采样，故 m = search + (真实偏移 - coarse)
      // 按 |相关| 取峰以兼容反相版本
      let bestM = search;
      let bestV = -Infinity;
      for (let m = 1; m <= 2 * search - 1; m += 1) {
        const v = Math.abs(corrWin[m + base]!);
        if (v > bestV) {
          bestV = v;
          bestM = m;
        }
      }
      refined = coarse + (bestM - search);
      const y1 = corrWin[bestM - 1 + base]!;
      const y2 = corrWin[bestM + base]!;
      const y3 = corrWin[bestM + 1 + base]!;
      const denom = y1 - 2 * y2 + y3;
      const frac = denom !== 0 ? (0.5 * (y1 - y3)) / denom : 0;
      subSample = refined + Math.max(-0.5, Math.min(0.5, frac));
    } else {
      refined = directBestLag(ref, cand, coarse, Math.min(search, Math.max(1, overlapAtCoarse - 1)));
      subSample = refined;
    }
  }

  // 3) 置信度：重叠区归一化相关
  check?.();
  const start = Math.max(0, -refined);
  const end = Math.min(ref.length, cand.length - refined);
  const overlapSamples = Math.max(0, end - start);
  let num = 0;
  let energyRef = 0;
  let energyCand = 0;
  const cap = Math.min(overlapSamples, 1 << 18);
  for (let i = 0; i < cap; i += 1) {
    const r = ref[start + i]!;
    const c = cand[start + i + refined]!;
    num += r * c;
    energyRef += r * r;
    energyCand += c * c;
  }
  const denom = Math.sqrt(energyRef * energyCand);
  const rawCorr = denom > 0 ? num / denom : 0;

  return {
    offsetSamples: refined,
    offsetSeconds: refined / fs,
    subSampleOffsetSamples: subSample,
    confidence: Math.abs(rawCorr),
    polarityInverted: rawCorr < -0.5,
    overlapSamples,
  };
}

/** 按偏移抽取对齐重叠区（视图，不复制）。 */
export function extractOverlap(
  ref: Float32Array,
  cand: Float32Array,
  offsetSamples: number,
): { refSeg: Float32Array; candSeg: Float32Array; length: number } {
  const start = Math.max(0, -offsetSamples);
  const end = Math.min(ref.length, cand.length - offsetSamples);
  const length = Math.max(0, end - start);
  return {
    refSeg: ref.subarray(start, start + length),
    candSeg: cand.subarray(start + offsetSamples, start + offsetSamples + length),
    length,
  };
}
