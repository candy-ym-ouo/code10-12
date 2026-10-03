/**
 * 多版本音频对比的 DSP 纯函数集合（无 Node API 依赖，可直接单测）。
 *
 * 流水线：
 *   原始 PCM -> 下混/重采样 -> K 加权积分响度(BS.1770-4)
 *          -> 恒定增益 + 真峰值限制 -> 互相关对齐 -> 逐窗差异摘要 / 差异音频
 */

export interface MonoPcm {
  sampleRate: number;
  samples: Float32Array;
}

/** 多声道交错 PCM 简单等比下混为单声道。 */
export function downmixToMono(data: Float32Array, channels: number): Float32Array {
  if (channels === 1) return data;
  const frames = Math.floor(data.length / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += data[frame * channels + channel] ?? 0;
    mono[frame] = sum / channels;
  }
  return mono;
}

/** 线性插值重采样（分析用途足够；渲染前源信号会先下混到单声道）。 */
export function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate || input.length === 0) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const fraction = position - left;
    const current = input[left] ?? 0;
    const next = input[left + 1] ?? current;
    output[index] = current + (next - current) * fraction;
  }
  return output;
}

/** 一阶 IIR biquad 直接形式 I（单零点单极点），用于 K 加权两级级联。 */
function biquadFirstOrder(
  input: Float32Array,
  b0: number,
  b1: number,
  a1: number,
): Float32Array {
  const output = new Float32Array(input.length);
  let prevInput = 0;
  let prevOutput = 0;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index] ?? 0;
    const value = b0 * current + b1 * prevInput - a1 * prevOutput;
    output[index] = value;
    prevInput = current;
    prevOutput = value;
  }
  return output;
}

/**
 * BS.1770-4 K 加权：高频搁架 + RLB 高通（48kHz 标准系数）。
 * 两级均为 IIR：stage1 一阶搁架，stage2 二阶高通，直接形式 I。
 */
export function kWeight(input: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate !== 48000) {
    throw new Error(`K 加权仅定义在 48kHz，当前 ${sampleRate}Hz（请先重采样）`);
  }
  // Stage 1：pre-filter（高频搁架）
  const shelfB0 = 1.53512485958697;
  const shelfB1 = -1.33775141862776;
  const shelfA1 = -0.81113290202053;
  const shelved = biquadFirstOrder(input, shelfB0, shelfB1, shelfA1);

  // Stage 2：RLB 高通（b0=1, b1=-2, b2=1）
  const rlbA1 = -1.69065929318241;
  const rlbA2 = 0.73248077421582;
  const output = new Float32Array(shelved.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < shelved.length; index += 1) {
    const current = shelved[index] ?? 0;
    const value = current - 2 * x1 + x2 - rlbA1 * y1 - rlbA2 * y2;
    output[index] = value;
    x2 = x1;
    x1 = current;
    y2 = y1;
    y1 = value;
  }
  return output;
}

/** K 加权滤波后的平方均值（单声道，z_j）。 */
function blockMeanSquares(weighted: Float32Array, blockSamples: number, hopSamples: number): number[] {
  const blocks: number[] = [];
  for (let start = 0; start + blockSamples <= weighted.length; start += hopSamples) {
    let sum = 0;
    for (let index = start; index < start + blockSamples; index += 1) {
      const sample = weighted[index] ?? 0;
      sum += sample * sample;
    }
    blocks.push(sum / blockSamples);
  }
  return blocks;
}

export interface LoudnessResult {
  /** 积分响度 LUFS；静音返回 null */
  integratedLufs: number | null;
  /** 未加权采样峰值（线性） */
  samplePeak: number;
  /** 4x 过采样近似真峰值（线性） */
  truePeak: number;
}

/** BS.1770-4 门控积分响度（单声道；输入必须是 48kHz）。 */
export function measureLoudness(samples: Float32Array, sampleRate: number): LoudnessResult {
  const weighted = sampleRate === 48000 ? kWeight(samples, sampleRate) : kWeight(resampleLinear(samples, sampleRate, 48000), 48000);
  const blockSamples = Math.round(0.4 * 48000);
  const hopSamples = Math.round(0.1 * 48000); // 75% 重叠
  const z = blockMeanSquares(weighted, blockSamples, hopSamples);

  let samplePeak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const abs = Math.abs(samples[index] ?? 0);
    if (abs > samplePeak) samplePeak = abs;
  }
  const truePeak = approximateTruePeak(samples, sampleRate, samplePeak);

  if (z.length === 0) return { integratedLufs: null, samplePeak, truePeak };

  const absoluteGate = 10 ** ((-70 + 0.691) / 10);
  const aboveAbsolute = z.filter((value) => value > absoluteGate);
  if (aboveAbsolute.length === 0) return { integratedLufs: null, samplePeak, truePeak };

  const preliminaryMean = aboveAbsolute.reduce((sum, value) => sum + value, 0) / aboveAbsolute.length;
  const relativeThreshold = preliminaryMean * 10 ** (-10 / 10);
  const gated = aboveAbsolute.filter((value) => value > relativeThreshold);
  const mean = (gated.length > 0 ? gated : aboveAbsolute).reduce((sum, value) => sum + value, 0) /
    (gated.length > 0 ? gated.length : aboveAbsolute.length);
  if (mean <= 0) return { integratedLufs: null, samplePeak, truePeak };
  return { integratedLufs: -0.691 + 10 * Math.log10(mean), samplePeak, truePeak };
}

/**
 * 4x 过采样真峰值近似：Hann 加窗 sinc 插值器（多相实现）。
 * 只在 |样本| >= 采样峰值 50% 的位置附近评估分数相位——过冲只可能出现在尖峰邻域。
 */
export function approximateTruePeak(samples: Float32Array, sampleRate: number, samplePeakHint?: number): number {
  const phases = 4;
  const halfTaps = 8;
  const kernelSpan = 2 * halfTaps;
  const kernels: number[][] = [];
  for (let phase = 0; phase < phases; phase += 1) {
    const fractional = phase / phases;
    const kernel: number[] = [];
    let norm = 0;
    for (let tap = -halfTaps; tap < halfTaps; tap += 1) {
      const x = tap - fractional;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const windowArg = (x + halfTaps) / (2 * halfTaps); // 0..1
      const hann = windowArg <= 0 || windowArg >= 1 ? 0 : 0.5 * (1 - Math.cos(2 * Math.PI * windowArg));
      const coefficient = sinc * hann;
      kernel.push(coefficient);
      norm += coefficient;
    }
    // 核增益归一（保证插值后直流增益为 1）
    for (let index = 0; index < kernel.length; index += 1) kernel[index] = (kernel[index] ?? 0) / norm;
    kernels.push(kernel);
  }

  const samplePeak = samplePeakHint ?? samplePeakDirect(samples);
  if (samplePeak === 0) return 0;
  // 过冲只可能出现在高幅度样本邻域；阈值以下的样本即使有微小过冲也不可能成为全局峰
  const centerThreshold = samplePeak * 0.5;
  let maxPeak = samplePeak;
  for (let center = 0; center < samples.length; center += 1) {
    if (Math.abs(samples[center] ?? 0) < centerThreshold) continue;
    for (let phase = 0; phase < phases; phase += 1) {
      const kernel = kernels[phase] ?? [];
      let value = 0;
      for (let tapIndex = 0; tapIndex < kernelSpan; tapIndex += 1) {
        const sample = samples[center - halfTaps + tapIndex];
        if (sample === undefined) continue;
        value += sample * (kernel[tapIndex] ?? 0);
      }
      const abs = Math.abs(value);
      if (abs > maxPeak) maxPeak = abs;
    }
  }
  void sampleRate;
  return maxPeak;
}

function samplePeakDirect(samples: Float32Array): number {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const abs = Math.abs(samples[index] ?? 0);
    if (abs > peak) peak = abs;
  }
  return peak;
}

export interface GainPlan {
  /** 应用的线性增益 */
  gain: number;
  gainDb: number;
  /** 归一化后的预测真峰值（线性） */
  resultingTruePeak: number;
  truePeakLimited: boolean;
}

/** 计算响度匹配增益，并保证真峰值不超过 tpLimitDbTP。 */
export function planLoudnessGain(
  measured: LoudnessResult,
  targetLufs: number,
  tpLimitDb: number,
): GainPlan {
  const baseLufs = measured.integratedLufs ?? -70;
  let gainDb = targetLufs - baseLufs;
  const tpLinear = 10 ** (tpLimitDb / 20);
  let truePeakLimited = false;
  const peakLimitGain = measured.truePeak > 0 ? tpLinear / measured.truePeak : Number.POSITIVE_INFINITY;
  const peakLimitGainDb = 20 * Math.log10(peakLimitGain === Number.POSITIVE_INFINITY ? 1 : peakLimitGain);
  if (gainDb > peakLimitGainDb) {
    gainDb = peakLimitGainDb;
    truePeakLimited = true;
  }
  const gain = 10 ** (gainDb / 20);
  return {
    gain,
    gainDb,
    resultingTruePeak: Math.min(measured.truePeak * gain, 1),
    truePeakLimited,
  };
}

export function applyGain(samples: Float32Array, gain: number): Float32Array {
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) output[index] = (samples[index] ?? 0) * gain;
  return output;
}

/** 去均值（相关前去掉直流）。 */
function removeMean(samples: Float32Array): Float32Array {
  if (samples.length === 0) return samples;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] ?? 0;
  const mean = sum / samples.length;
  if (Math.abs(mean) < 1e-9) return samples;
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) output[index] = (samples[index] ?? 0) - mean;
  return output;
}

export interface AlignmentResult {
  /** 候选相对基线的偏移毫秒；> 0 表示候选开始得更晚 */
  offsetMs: number;
  /** 最佳归一化互相关 [-1, 1] */
  correlation: number;
}

/**
 * 粗到精全局时延估计：
 * 1. 1 kHz 包络级网格 ±maxOffsetMs 粗搜（使用前 leadMs 秒）；
 * 2. 在前 20s 中能量最高的 8s 片段上，以 8 kHz 在 ±15ms 内精修。
 * 返回的 offsetMs > 0 表示候选开始得更晚。
 */
export function estimateOffset(
  baseline: MonoPcm,
  candidate: MonoPcm,
  maxOffsetMs: number,
  leadMs = 60_000,
): AlignmentResult {
  const coarseRate = 1000;
  const baseCoarse = resampleLinear(removeMean(baseline.samples), baseline.sampleRate, coarseRate);
  const candCoarse = resampleLinear(removeMean(candidate.samples), candidate.sampleRate, coarseRate);
  const leadSamples = Math.min(
    baseCoarse.length,
    candCoarse.length,
    Math.floor((leadMs / 1000) * coarseRate),
  );
  if (leadSamples < coarseRate) return { offsetMs: 0, correlation: 0 };

  const x = baseCoarse.subarray(0, leadSamples);
  const y = candCoarse.subarray(0, leadSamples);
  const maxLag = Math.floor((maxOffsetMs / 1000) * coarseRate);
  let bestLag = 0;
  let bestScore = -Infinity;

  // lag>0：候选滞后于基线（candidate[t+lag] 对齐 baseline[t]）
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const score = normalizedCorrelation(x, y, lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // 精修：8 kHz、±15ms、能量最高的 8s 片段
  const fineRate = 8000;
  const fineBase = resampleLinear(removeMean(baseline.samples), baseline.sampleRate, fineRate);
  const fineCand = resampleLinear(removeMean(candidate.samples), candidate.sampleRate, fineRate);
  const segmentMs = 8000;
  const searchRangeMs = Math.min(20_000, fineBase.length / fineRate * 1000);
  const segment = pickEnergySegment(fineBase, fineCand, fineRate, segmentMs, searchRangeMs);
  const coarseLagFine = Math.round((bestLag / coarseRate) * fineRate);
  const fineRadius = Math.round((15 / 1000) * fineRate);
  let fineBestLag = coarseLagFine;
  let fineBestScore = -Infinity;
  for (let lag = coarseLagFine - fineRadius; lag <= coarseLagFine + fineRadius; lag += 1) {
    const score = normalizedCorrelation(segment.x, segment.y, lag);
    if (score > fineBestScore) {
      fineBestScore = score;
      fineBestLag = lag;
    }
  }

  const confidence = Number.isFinite(fineBestScore) ? fineBestScore : bestScore;
  return {
    offsetMs: Math.round((fineBestLag / fineRate) * 1000),
    correlation: Number.isFinite(confidence) ? Math.max(-1, Math.min(1, confidence)) : 0,
  };
}

/** 在 searchRangeMs 范围内滑窗，挑选双方能量之和最大的 segmentMs 片段。 */
function pickEnergySegment(
  x: Float32Array,
  y: Float32Array,
  sampleRate: number,
  segmentMs: number,
  searchRangeMs: number,
): { x: Float32Array; y: Float32Array } {
  const segment = Math.min(x.length, y.length, Math.floor((segmentMs / 1000) * sampleRate));
  const range = Math.min(x.length, y.length, Math.floor((searchRangeMs / 1000) * sampleRate));
  if (range <= segment) return { x: x.subarray(0, range), y: y.subarray(0, range) };
  const hop = Math.floor(sampleRate * 0.5);
  let bestStart = 0;
  let bestEnergy = -1;
  for (let start = 0; start + segment <= range; start += hop) {
    let energy = 0;
    for (let index = start; index < start + segment; index += 1) {
      energy += (x[index] ?? 0) ** 2 + (y[index] ?? 0) ** 2;
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }
  return { x: x.subarray(bestStart, bestStart + segment), y: y.subarray(bestStart, bestStart + segment) };
}

/** y[t+lag] 相对 x[t] 的零延迟归一化互相关，重叠区过短返回 -Infinity。 */
function normalizedCorrelation(x: Float32Array, y: Float32Array, lag: number): number {
  const xStart = Math.max(0, -lag);
  const yStart = Math.max(0, lag);
  const overlap = Math.min(x.length - xStart, y.length - yStart);
  if (overlap < 100) return -Infinity;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  for (let index = 0; index < overlap; index += 1) {
    const xv = x[xStart + index];
    const yv = y[yStart + index];
    if (xv === undefined || yv === undefined) continue;
    sumXY += xv * yv;
    sumXX += xv * xv;
    sumYY += yv * yv;
  }
  const denominator = Math.sqrt(sumXX * sumYY);
  if (denominator < 1e-12) return -Infinity;
  return sumXY / denominator;
}

export interface AlignedPair {
  /** 等长、同采样率；偏移用零填充对齐 */
  baseline: Float32Array;
  candidate: Float32Array;
  sampleRate: number;
  /** 候选前导填充样本数 */
  padSamples: number;
}

/** 按 offsetMs 将候选与基线零填充对齐，输出等长信号。 */
export function alignPair(baseline: MonoPcm, candidate: MonoPcm, offsetMs: number): AlignedPair {
  const sampleRate = baseline.sampleRate;
  const candResampled = candidate.sampleRate === sampleRate
    ? candidate.samples
    : resampleLinear(candidate.samples, candidate.sampleRate, sampleRate);
  const offsetSamples = Math.round((offsetMs / 1000) * sampleRate);
  const pad = Math.max(0, offsetSamples);
  const trim = Math.max(0, -offsetSamples);
  const shifted = candResampled.subarray(trim);
  const length = Math.max(baseline.samples.length, pad + shifted.length);
  const outBase = new Float32Array(length);
  const outCand = new Float32Array(length);
  outBase.set(baseline.samples.subarray(0, Math.min(baseline.samples.length, length)), 0);
  outCand.set(shifted.subarray(0, Math.min(shifted.length, length - pad)), pad);
  return { baseline: outBase, candidate: outCand, sampleRate, padSamples: pad };
}

export interface DifferenceWindow {
  startMs: number;
  endMs: number;
  baselineRmsDb: number | null;
  candidateRmsDb: number | null;
  rmsDeltaDb: number | null;
  correlation: number;
  meanAbsDelta: number;
  /** 两版本都有足够能量时才计入总体评分 */
  voiced: boolean;
}

export interface DifferenceSummary {
  windows: DifferenceWindow[];
  overallCorrelation: number;
  meanRmsDeltaDb: number | null;
  maxRmsDeltaDb: number | null;
  meanAbsDelta: number;
  /** 0-100 综合相似度 */
  similarityScore: number;
  /** 差异最大的窗口（最多 5 个） */
  worstWindows: DifferenceWindow[];
  alignedDurationMs: number;
  /** 双方都有信号的样本占比 */
  coveragePct: number;
}

const rmsToDb = (rms: number): number | null => (rms > 1e-7 ? 20 * Math.log10(rms) : null);

/** 滑窗差异：RMS 差、逐窗相关、平均绝对差，输出窗口明细与总体摘要。 */
export function summarizeDifferences(
  pair: AlignedPair,
  windowMs: number,
  hopMs: number,
): DifferenceSummary {
  const { sampleRate, baseline, candidate } = pair;
  const windowSamples = Math.round((windowMs / 1000) * sampleRate);
  const hopSamples = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const windows: DifferenceWindow[] = [];

  for (let start = 0; start + windowSamples <= baseline.length; start += hopSamples) {
    let sumB = 0;
    let sumC = 0;
    let sumBB = 0;
    let sumCC = 0;
    let sumBC = 0;
    let absDelta = 0;
    let activeB = 0;
    let activeC = 0;
    for (let index = start; index < start + windowSamples; index += 1) {
      const b = baseline[index] ?? 0;
      const c = candidate[index] ?? 0;
      sumB += b;
      sumC += c;
      sumBB += b * b;
      sumCC += c * c;
      sumBC += b * c;
      absDelta += Math.abs(b - c);
      if (Math.abs(b) > 1e-5) activeB += 1;
      if (Math.abs(c) > 1e-5) activeC += 1;
    }
    const n = windowSamples;
    const varB = Math.max(0, sumBB / n - (sumB / n) ** 2);
    const varC = Math.max(0, sumCC / n - (sumC / n) ** 2);
    const cov = sumBC / n - (sumB / n) * (sumC / n);
    const denom = Math.sqrt(varB * varC);
    const correlation = denom > 1e-12 ? Math.max(-1, Math.min(1, cov / denom)) : 0;
    const rmsB = Math.sqrt(sumBB / n);
    const rmsC = Math.sqrt(sumCC / n);
    const dbB = rmsToDb(rmsB);
    const dbC = rmsToDb(rmsC);
    const voiced = activeB > n * 0.05 && activeC > n * 0.05;
    windows.push({
      startMs: Math.round((start / sampleRate) * 1000),
      endMs: Math.round(((start + n) / sampleRate) * 1000),
      baselineRmsDb: dbB,
      candidateRmsDb: dbC,
      rmsDeltaDb: dbB !== null && dbC !== null ? Number((dbC - dbB).toFixed(2)) : null,
      correlation: Number(correlation.toFixed(4)),
      meanAbsDelta: Number((absDelta / n).toFixed(6)),
      voiced,
    });
  }

  const voicedWindows = windows.filter((window) => window.voiced);
  const scored = voicedWindows.length > 0 ? voicedWindows : windows;
  const deltas = scored.map((window) => window.rmsDeltaDb).filter((value): value is number => value !== null);
  const meanRmsDeltaDb = deltas.length > 0
    ? Number((deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(2))
    : null;
  const maxRmsDeltaDb = deltas.length > 0
    ? Number(deltas.reduce((max, value) => Math.max(max, Math.abs(value)), 0).toFixed(2))
    : null;
  const meanCorrelation = scored.length > 0
    ? scored.reduce((sum, window) => sum + window.correlation, 0) / scored.length
    : 0;
  const meanAbsDelta = scored.length > 0
    ? scored.reduce((sum, window) => sum + window.meanAbsDelta, 0) / scored.length
    : 0;

  // 相似度：波形相关 70% + 响度一致性 30%（每 1dB 差异扣约 6 分）
  const correlationPart = Math.max(0, meanCorrelation) * 70;
  const loudnessPart = meanRmsDeltaDb === null ? 30 : Math.max(0, 30 - Math.abs(meanRmsDeltaDb) * 6);
  const similarityScore = Math.round(Math.max(0, Math.min(100, correlationPart + loudnessPart)));

  const worstWindows = [...windows]
    .filter((window) => window.voiced)
    .sort((a, b) => b.meanAbsDelta - a.meanAbsDelta)
    .slice(0, 5);

  // 覆盖：双方都非静音的帧占比
  let covered = 0;
  for (let index = 0; index < baseline.length; index += 100) {
    if (Math.abs(baseline[index] ?? 0) > 1e-5 && Math.abs(candidate[index] ?? 0) > 1e-5) covered += 1;
  }
  const totalProbes = Math.max(1, Math.ceil(baseline.length / 100));

  return {
    windows,
    overallCorrelation: Number(meanCorrelation.toFixed(4)),
    meanRmsDeltaDb,
    maxRmsDeltaDb,
    meanAbsDelta: Number(meanAbsDelta.toFixed(6)),
    similarityScore,
    worstWindows,
    alignedDurationMs: Math.round((baseline.length / sampleRate) * 1000),
    coveragePct: Number(((covered / totalProbes) * 100).toFixed(1)),
  };
}

/** 生成归一化差异音频：限幅后的 (基线 - 候选) / 2，便于快速 A/B 听辨。 */
export function buildDifferenceSignal(pair: AlignedPair): Float32Array {
  const output = new Float32Array(pair.baseline.length);
  for (let index = 0; index < pair.baseline.length; index += 1) {
    const value = ((pair.baseline[index] ?? 0) - (pair.candidate[index] ?? 0)) * 0.5;
    output[index] = Math.max(-1, Math.min(1, value));
  }
  return output;
}
