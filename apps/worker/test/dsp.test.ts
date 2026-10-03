import { describe, expect, it } from "vitest";
import {
  alignPair,
  applyGain,
  buildDifferenceSignal,
  downmixToMono,
  estimateOffset,
  kWeight,
  measureLoudness,
  planLoudnessGain,
  resampleLinear,
  summarizeDifferences,
} from "../src/lib/dsp.js";
import { decodeWav, encodeWavPcm16 } from "../src/lib/pcm.js";

const SR = 48000;

/** 生成多谐波周期信号（类乐音），带简单包络避免瞬态。 */
function tone(frequency: number, seconds: number, sampleRate = SR, amplitude = 0.5): Float32Array {
  const length = Math.floor(seconds * sampleRate);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    const envelope = Math.min(1, index / 2000) * Math.min(1, (length - index) / 2000);
    output[index] =
      amplitude *
      envelope *
      (Math.sin(2 * Math.PI * frequency * t) + 0.4 * Math.sin(2 * Math.PI * frequency * 2 * t + 0.7));
  }
  return output;
}

function shift(samples: Float32Array, shiftMs: number): Float32Array {
  const shiftSamples = Math.round((shiftMs / 1000) * SR);
  const output = new Float32Array(samples.length + Math.abs(shiftSamples) + SR);
  const offset = Math.max(0, shiftSamples);
  output.set(samples, offset);
  return output;
}

describe("pcm codec", () => {
  it("round-trips 16-bit WAV", () => {
    const original = tone(440, 0.5, SR, 0.7);
    const wav = encodeWavPcm16({ sampleRate: SR, channels: 1, data: original });
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.channels).toBe(1);
    expect(decoded.data.length).toBe(original.length);
    // 16-bit 量化误差 < 1/32768
    let maxError = 0;
    for (let index = 0; index < decoded.data.length; index += 1) {
      maxError = Math.max(maxError, Math.abs((decoded.data[index] ?? 0) - (original[index] ?? 0)));
    }
    expect(maxError).toBeLessThan(2 / 32768);
  });

  it("rejects non-WAV buffers", () => {
    expect(() => decodeWav(Buffer.from("not a wav file!!"))).toThrow(/WAV|不是/);
  });

  it("downmixes stereo equally", () => {
    const interleaved = new Float32Array([0.4, 0.8, -0.2, 0.2]);
    const mono = downmixToMono(interleaved, 2);
    expect(mono.length).toBe(2);
    expect(mono[0]).toBeCloseTo(0.6, 5);
    expect(mono[1]).toBeCloseTo(0, 5);
  });
});

describe("resampling", () => {
  it("keeps length consistent with rate ratio", () => {
    const input = tone(300, 1, 48000);
    const output = resampleLinear(input, 48000, 24000);
    expect(output.length).toBe(24000);
  });

  it("preserves a low-frequency sine amplitude after down/up sampling", () => {
    const input = tone(200, 1, 48000, 0.5);
    const down = resampleLinear(input, 48000, 8000);
    const back = resampleLinear(down, 8000, 48000);
    const stable = back.subarray(8000, 40000);
    let peak = 0;
    for (const value of stable) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeGreaterThan(0.4);
  });
});

describe("K-weighting and loudness", () => {
  it("filters without changing length", () => {
    const input = tone(1000, 0.8);
    expect(kWeight(input, SR).length).toBe(input.length);
  });

  it("measures a louder signal with higher integrated LUFS", () => {
    const quiet = measureLoudness(tone(440, 2, SR, 0.1), SR);
    const loud = measureLoudness(tone(440, 2, SR, 0.5), SR);
    expect(quiet.integratedLufs).not.toBeNull();
    expect(loud.integratedLufs).not.toBeNull();
    expect(loud.integratedLufs! - quiet.integratedLufs!).toBeGreaterThan(12);
    expect(loud.integratedLufs! - quiet.integratedLufs!).toBeLessThan(15);
  });

  it("returns null loudness for digital silence but zero peak", () => {
    const silence = new Float32Array(SR);
    const result = measureLoudness(silence, SR);
    expect(result.integratedLufs).toBeNull();
    expect(result.samplePeak).toBe(0);
    expect(result.truePeak).toBe(0);
  });

  it("true peak is at least the sample peak", () => {
    const result = measureLoudness(tone(3700, 1, SR, 0.6), SR);
    expect(result.truePeak).toBeGreaterThanOrEqual(result.samplePeak - 1e-6);
  });
});

describe("loudness gain planning", () => {
  it("plans positive gain for a quiet source toward -23 LUFS", () => {
    const measured = measureLoudness(tone(440, 2, SR, 0.08), SR);
    const plan = planLoudnessGain(measured, -23, -1);
    expect(plan.gainDb).toBeGreaterThan(0);
    expect(plan.resultingTruePeak).toBeLessThanOrEqual(1.0001);
  });

  it("limits gain when true peak ceiling would be exceeded", () => {
    // 安静但高频的信号：抬到 -5 LUFS 所需增益会冲破 -9 dBTP，必须被真峰值限制
    const measured = measureLoudness(tone(3700, 2, SR, 0.02), SR);
    const plan = planLoudnessGain(measured, -5, -9);
    const tpLinear = 10 ** (-9 / 20);
    expect(measured.truePeak * plan.gain).toBeLessThanOrEqual(tpLinear + 1e-6);
    expect(plan.truePeakLimited).toBe(true);
  });
});

describe("offset estimation", () => {
  it("finds a 400 ms candidate delay", () => {
    const base = tone(523, 6, SR, 0.5);
    const delayed = shift(base, 400);
    const result = estimateOffset(
      { sampleRate: SR, samples: base },
      { sampleRate: SR, samples: delayed },
      1500,
    );
    expect(Math.abs(result.offsetMs - 400)).toBeLessThanOrEqual(4);
    expect(result.correlation).toBeGreaterThan(0.85);
  });

  it("finds a negative offset (candidate starts earlier)", () => {
    const base = shift(tone(523, 6, SR, 0.5), 300);
    const candidate = tone(523, 6, SR, 0.5);
    const result = estimateOffset(
      { sampleRate: SR, samples: base },
      { sampleRate: SR, samples: candidate },
      1500,
    );
    expect(Math.abs(result.offsetMs - (-300))).toBeLessThanOrEqual(4);
  });

  it("reports low correlation for unrelated content", () => {
    const result = estimateOffset(
      { sampleRate: SR, samples: tone(300, 6, SR, 0.4) },
      { sampleRate: SR, samples: tone(2400, 6, SR, 0.4) },
      1500,
    );
    expect(result.correlation).toBeLessThan(0.3);
  });
});

describe("alignment and difference", () => {
  it("zero-pads aligned signals to equal length", () => {
    const base = tone(440, 2, SR, 0.4);
    const candidate = shift(base, 250);
    const pair = alignPair(
      { sampleRate: SR, samples: base },
      { sampleRate: SR, samples: candidate },
      250,
    );
    expect(pair.baseline.length).toBe(pair.candidate.length);
    expect(pair.padSamples).toBe(Math.round(0.25 * SR));
  });

  it("identical loudness-normalized versions score near 100", () => {
    const baseRaw = tone(660, 4, SR, 0.2);
    const candidateRaw = tone(660, 4, SR, 0.5); // 同内容不同响度
    const baseGain = planLoudnessGain(measureLoudness(baseRaw, SR), -23, -1);
    const candGain = planLoudnessGain(measureLoudness(candidateRaw, SR), -23, -1);
    const pair = alignPair(
      { sampleRate: SR, samples: applyGain(baseRaw, baseGain.gain) },
      { sampleRate: SR, samples: applyGain(candidateRaw, candGain.gain) },
      0,
    );
    const summary = summarizeDifferences(pair, 2000, 500);
    expect(summary.similarityScore).toBeGreaterThan(95);
    expect(summary.overallCorrelation).toBeGreaterThan(0.98);
    expect(Math.abs(summary.meanRmsDeltaDb ?? 99)).toBeLessThan(0.5);
    expect(summary.coveragePct).toBeGreaterThan(90);

    const diff = buildDifferenceSignal(pair);
    let diffPeak = 0;
    for (const value of diff) diffPeak = Math.max(diffPeak, Math.abs(value));
    expect(diffPeak).toBeLessThan(0.05);
  });

  it("detects a locally different segment in worst windows", () => {
    const base = tone(660, 4, SR, 0.4);
    const candidate = new Float32Array(base);
    // 第 2~2.8 秒替换成不和谐的高频
    const replacement = tone(2600, 0.8, SR, 0.4);
    candidate.set(replacement, 2 * SR);
    const pair = alignPair(
      { sampleRate: SR, samples: base },
      { sampleRate: SR, samples: candidate },
      0,
    );
    const summary = summarizeDifferences(pair, 400, 200);
    expect(summary.similarityScore).toBeLessThan(90);
    expect(summary.worstWindows.length).toBeGreaterThan(0);
    const worst = summary.worstWindows[0]!;
    // 最差窗口应覆盖改动区域
    expect(worst.startMs).toBeGreaterThanOrEqual(1500);
    expect(worst.endMs).toBeLessThanOrEqual(3200);
  });
});
