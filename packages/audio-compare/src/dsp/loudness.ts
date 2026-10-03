/**
 * ITU-R BS.1770 K 加权响度。
 * 滤波器系数采用 DeMan 设计公式（与 pyloudnorm 一致），对任意采样率有效：
 * 第一级高架滤波 G=+4dB, Q=1/√2, fc=1500Hz；第二级高通 Q=0.5, fc=38Hz。
 */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function designHighShelf(gainDb: number, q: number, fc: number, fs: number): BiquadCoeffs {
  const k = Math.tan((Math.PI * fc) / fs);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.499666774155);
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

function designHighPass(q: number, fc: number, fs: number): BiquadCoeffs {
  const k = Math.tan((Math.PI * fc) / fs);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

export function kWeightingShelf(fs: number): BiquadCoeffs {
  return designHighShelf(4.0, 1 / Math.SQRT2, 1500, fs);
}

export function kWeightingHighPass(fs: number): BiquadCoeffs {
  return designHighPass(0.5, 38, fs);
}

export function filterBiquad(input: Float32Array, coeffs: BiquadCoeffs): Float32Array {
  const { b0, b1, b2, a1, a2 } = coeffs;
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** K 加权后各声道平方和序列（z_i，声道等权）。 */
export function kWeightedSquares(channels: Float32Array[], fs: number): Float64Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const shelf = kWeightingShelf(fs);
  const hp = kWeightingHighPass(fs);
  for (const ch of channels) {
    const y = filterBiquad(filterBiquad(ch, shelf), hp);
    for (let i = 0; i < n; i += 1) out[i] = out[i]! + y[i]! * y[i]!;
  }
  return out;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const LOUDNESS_OFFSET = -0.691;

function blockLoudness(meanSquare: number): number {
  return LOUDNESS_OFFSET + 10 * Math.log10(Math.max(meanSquare, 1e-20));
}

/**
 * 积分响度（LUFS）：400ms 块、75% 重叠，先 -70 LUFS 绝对门控，
 * 再以未门控均值 -10 LU 做相对门控。静音返回 -Infinity。
 */
export function integratedLufsFromSquares(z: ArrayLike<number>, fs: number): number {
  const n = z.length;
  if (n === 0) return -Infinity;
  const block = Math.max(1, Math.round(0.4 * fs));
  const hop = Math.max(1, Math.round(0.1 * fs));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i]! + z[i]!;
  const means: number[] = [];
  if (n <= block) {
    means.push(prefix[n]! / n);
  } else {
    for (let start = 0; start + block <= n; start += hop) {
      means.push((prefix[start + block]! - prefix[start]!) / block);
    }
  }
  const loudness = means.map(blockLoudness);
  const gatedMeans: number[] = [];
  for (let j = 0; j < means.length; j += 1) {
    if (loudness[j]! >= ABSOLUTE_GATE_LUFS) gatedMeans.push(means[j]!);
  }
  if (gatedMeans.length === 0) return -Infinity;
  const ungatedAvg = gatedMeans.reduce((acc, v) => acc + v, 0) / gatedMeans.length;
  const relativeThreshold = blockLoudness(ungatedAvg) + RELATIVE_GATE_LU;
  let sum = 0;
  let count = 0;
  for (let j = 0; j < means.length; j += 1) {
    if (loudness[j]! >= ABSOLUTE_GATE_LUFS && loudness[j]! > relativeThreshold) {
      sum += means[j]!;
      count += 1;
    }
  }
  if (count === 0) return -Infinity;
  return blockLoudness(sum / count);
}

export function integratedLufs(channels: Float32Array[], fs: number): number {
  return integratedLufsFromSquares(kWeightedSquares(channels, fs), fs);
}

/** 分窗响度（LUFS，无门控），用于差异时间线；零能量窗为 -Infinity。 */
export function windowedLufsFromSquares(z: ArrayLike<number>, fs: number, windowSeconds: number): Float64Array {
  const n = z.length;
  const window = Math.max(1, Math.round(windowSeconds * fs));
  const count = Math.max(1, Math.ceil(n / window));
  const out = new Float64Array(count);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i]! + z[i]!;
  for (let w = 0; w < count; w += 1) {
    const start = w * window;
    const end = Math.min(n, start + window);
    const mean = (prefix[end]! - prefix[start]!) / Math.max(1, end - start);
    out[w] = mean <= 0 ? -Infinity : blockLoudness(mean);
  }
  return out;
}

/** 样本峰值（dBFS），静音返回 -Infinity。 */
export function peakDbfs(channel: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < channel.length; i += 1) {
    const v = Math.abs(channel[i]!);
    if (v > peak) peak = v;
  }
  return peak <= 0 ? -Infinity : 20 * Math.log10(peak);
}

export function applyGainDb(input: Float32Array, gainDb: number): Float32Array {
  const gain = Math.pow(10, gainDb / 20);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = input[i]! * gain;
  return out;
}
