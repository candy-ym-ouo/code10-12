import { describe, expect, it } from "vitest";
import { integratedLufs, windowedLufsFromSquares, kWeightedSquares } from "../src/dsp/loudness.js";
import { applyGainDb, concat, makeSine } from "./fixtures.js";

describe("响度（BS.1770 K 加权）", () => {
  it("1 kHz 正弦（峰值 0.1）≈ -23 LUFS", () => {
    const x = makeSine(1000, 0.1, 5, 48000);
    const lufs = integratedLufs([x], 48000);
    expect(Math.abs(lufs - -23.01)).toBeLessThan(0.3);
  });

  it("增益 +6 dB → 响度恰好 +6 LU", () => {
    const fs = 48000;
    const x = makeSine(1000, 0.1, 5, fs);
    const louder = applyGainDb(x, 6);
    const diff = integratedLufs([louder], fs) - integratedLufs([x], fs);
    expect(Math.abs(diff - 6)).toBeLessThan(0.05);
  });

  it("非 48k 采样率下滤波器同样准确（16 kHz）", () => {
    const x = makeSine(1000, 0.1, 5, 16000);
    const lufs = integratedLufs([x], 16000);
    expect(Math.abs(lufs - -23.01)).toBeLessThan(0.3);
  });

  it("静音返回 -Infinity", () => {
    expect(integratedLufs([new Float32Array(48000)], 48000)).toBe(-Infinity);
  });

  it("相对门控：长尾低电平不显著拉低积分响度", () => {
    const fs = 48000;
    const loud = makeSine(1000, 0.5, 1, fs);
    const quiet = makeSine(1000, 0.01, 9, fs);
    const combined = concat(loud, quiet);
    const lufs = integratedLufs([combined], fs);
    // 响段约 -9 LUFS；若不门控会被 9 秒低电平拉到约 -19 LUFS
    expect(lufs).toBeGreaterThan(-12);
  });

  it("分窗响度能定位电平变化", () => {
    const fs = 16000;
    const quiet = makeSine(1000, 0.01, 1, fs);
    const loud = makeSine(1000, 0.5, 1, fs);
    const z = kWeightedSquares([concat(quiet, loud)], fs);
    const timeline = windowedLufsFromSquares(z, fs, 1);
    expect(timeline.length).toBe(2);
    expect(timeline[1]! - timeline[0]!).toBeGreaterThan(20);
  });
});
