/** 迭代基-2 FFT 与互相关。纯 TS 实现，供对齐与频带分析使用。 */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * 原地复数 FFT。re/im 长度必须为 2 的幂。
 * invert=false 为正变换（exp(-2πi/N)），true 为逆变换（含 1/N 归一）。
 */
export function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  if (n !== im.length || n < 2 || (n & (n - 1)) !== 0) {
    throw new Error("FFT_LENGTH_NOT_POWER_OF_TWO");
  }
  // 位反转重排
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((2 * Math.PI) / len) * (invert ? 1 : -1);
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k += 1) {
        const aIdx = i + k;
        const bIdx = i + k + half;
        const bRe = re[bIdx]!;
        const bIm = im[bIdx]!;
        const vRe = bRe * curRe - bIm * curIm;
        const vIm = bRe * curIm + bIm * curRe;
        const uRe = re[aIdx]!;
        const uIm = im[aIdx]!;
        re[aIdx] = uRe + vRe;
        im[aIdx] = uIm + vIm;
        re[bIdx] = uRe - vRe;
        im[bIdx] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/**
 * 线性互相关：C[lag + b.length - 1] = Σ_n a[n] * b[n + lag]，
 * lag ∈ [-(b.length-1), a.length-1]。经 FFT 计算，零延拓消除循环卷积混叠。
 */
export function crossCorrelation(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) throw new Error("XCORR_EMPTY_INPUT");
  const size = nextPow2(la + lb - 1);
  const reA = new Float64Array(size);
  const imA = new Float64Array(size);
  const reB = new Float64Array(size);
  const imB = new Float64Array(size);
  for (let i = 0; i < la; i += 1) reA[i] = a[i]!;
  for (let i = 0; i < lb; i += 1) reB[i] = b[i]!;
  fft(reA, imA, false);
  fft(reB, imB, false);
  // conj(A) * B
  for (let i = 0; i < size; i += 1) {
    const ar = reA[i]!;
    const ai = imA[i]!;
    const br = reB[i]!;
    const bi = imB[i]!;
    reA[i] = ar * br + ai * bi;
    imA[i] = ar * bi - ai * br;
  }
  fft(reA, imA, true);
  // IFFT 输出下标 m（0..size-1）对应循环 lag；lag>=0 取 m=lag，lag<0 取 m=size+lag
  const out = new Float64Array(la + lb - 1);
  const offset = lb - 1;
  for (let lag = 0; lag < la; lag += 1) out[lag + offset] = reA[lag]!;
  for (let lag = -(lb - 1); lag < 0; lag += 1) out[lag + offset] = reA[size + lag]!;
  return out;
}
