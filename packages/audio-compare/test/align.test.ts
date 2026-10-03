import { describe, expect, it } from "vitest";
import { alignSignals, extractOverlap } from "../src/dsp/align.js";
import { delaySignal, makeNoise, trimStart } from "./fixtures.js";

describe("同段对齐", () => {
  const fs = 16000;

  it("正偏移：候选延迟 1234 采样", () => {
    const ref = makeNoise(3, fs, 42);
    const cand = delaySignal(ref, 1234);
    const result = alignSignals(ref, cand, fs);
    expect(Math.abs(result.offsetSamples - 1234)).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.polarityInverted).toBe(false);
  });

  it("负偏移：候选提前 800 采样", () => {
    const ref = makeNoise(3, fs, 7);
    const cand = trimStart(ref, 800);
    const result = alignSignals(ref, cand, fs);
    expect(Math.abs(result.offsetSamples - -800)).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("短信号（直接扫描路径）也能对齐", () => {
    const ref = makeNoise(0.4, fs, 5);
    const cand = delaySignal(ref, 100);
    const result = alignSignals(ref, cand, fs);
    expect(Math.abs(result.offsetSamples - 100)).toBeLessThanOrEqual(1);
  });

  it("内容不相关时置信度低", () => {
    const ref = makeNoise(3, fs, 1);
    const other = makeNoise(3, fs, 2);
    const result = alignSignals(ref, other, fs);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("反相版本标记 polarityInverted", () => {
    const ref = makeNoise(3, fs, 9);
    const inverted = new Float32Array(ref.length);
    for (let i = 0; i < ref.length; i += 1) inverted[i] = -ref[i]!;
    const result = alignSignals(ref, inverted, fs);
    expect(result.polarityInverted).toBe(true);
  });

  it("extractOverlap 抽取的重叠区逐样本一致", () => {
    const ref = makeNoise(2, fs, 11);
    const cand = delaySignal(ref, 500);
    const { refSeg, candSeg, length } = extractOverlap(ref, cand, 500);
    expect(length).toBe(ref.length);
    for (let i = 0; i < length; i += 1) expect(candSeg[i]).toBe(refSeg[i]);
  });
});
