import { describe, expect, it } from "vitest";
import { computeDiff } from "../src/dsp/diff.js";
import { makeNoise, makeSine, mix } from "./fixtures.js";

describe("差异摘要", () => {
  const fs = 16000;

  it("相同信号：相关 1，残余 -∞", () => {
    const ref = makeNoise(2, fs, 3);
    const metrics = computeDiff(ref, ref, fs);
    expect(metrics.correlation).toBeCloseTo(1, 5);
    expect(metrics.diffRmsDb).toBeLessThan(-120);
    expect(metrics.residualToRefDb).toBeLessThan(-120);
    expect(metrics.verdict).toContain("高度一致");
  });

  it("局部突发能被区段排名定位", () => {
    const ref = makeNoise(3, fs, 4, 0.2);
    const burst = makeSine(2000, 0.4, 0.5, fs);
    const cand = mix(ref, burst, Math.round(1.0 * fs));
    const metrics = computeDiff(ref, cand, fs);
    expect(metrics.topSegments.length).toBeGreaterThan(0);
    const top = metrics.topSegments[0]!;
    expect(top.startSec).toBeGreaterThanOrEqual(0.5);
    expect(top.startSec).toBeLessThanOrEqual(2.0);
    expect(metrics.correlation).toBeLessThan(0.999);
  });

  it("额外单音反映到对应频段差异", () => {
    const ref = makeNoise(3, fs, 8, 0.2);
    const tone = makeSine(4000, 0.5, 3, fs);
    const cand = mix(ref, tone);
    const metrics = computeDiff(ref, cand, fs);
    // 单音落在 2-6k 频带 → 该频带平均幅度明显上升；其余频带内容一致 → 差异≈0
    expect(metrics.bandDeltaDb["2000-6000"]).toBeGreaterThan(0.8);
    expect(metrics.bandDeltaDb["2000-6000"]!).toBeGreaterThan((metrics.bandDeltaDb["120-500"] ?? 0) + 0.5);
    expect(Math.abs(metrics.bandDeltaDb["120-500"] ?? 99)).toBeLessThan(0.2);
  });

  it("整体电平差（未归一时）体现在残余电平", () => {
    const ref = makeNoise(2, fs, 12, 0.2);
    const quieter = new Float32Array(ref.length);
    for (let i = 0; i < ref.length; i += 1) quieter[i] = ref[i]! * 0.5;
    const metrics = computeDiff(ref, quieter, fs);
    expect(metrics.correlation).toBeCloseTo(1, 3);
    // 残余 = ref - 0.5·ref = 0.5·ref → 相对参考 -6 dB
    expect(Math.abs(metrics.residualToRefDb - -6)).toBeLessThan(0.2);
  });
});
