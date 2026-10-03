/** 测试夹具：确定性信号合成与 WAV 落盘。 */

import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWav16 } from "../src/dsp/wav.js";

export function makeTempDir(): string {
  return nodeFs.mkdtempSync(path.join(os.tmpdir(), "audio-compare-test-"));
}

export function removeTempDir(dir: string): void {
  nodeFs.rmSync(dir, { recursive: true, force: true });
}

/** mulberry32 确定性伪随机 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSine(freq: number, amp: number, seconds: number, fs: number): Float32Array {
  const n = Math.round(seconds * fs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
}

export function makeNoise(seconds: number, fs: number, seed = 1, amp = 0.3): Float32Array {
  const n = Math.round(seconds * fs);
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (rand() * 2 - 1) * amp;
  return out;
}

export function mix(a: Float32Array, b: Float32Array, offsetSamples = 0): Float32Array {
  const n = Math.max(a.length, offsetSamples + b.length);
  const out = new Float32Array(n);
  out.set(a.subarray(0, Math.min(a.length, n)));
  for (let i = 0; i < b.length; i += 1) {
    const at = offsetSamples + i;
    if (at >= 0 && at < n) out[at] = out[at]! + b[i]!;
  }
  return out;
}

/** 头部补零（候选比参考晚 start 个采样） */
export function delaySignal(x: Float32Array, samples: number): Float32Array {
  const out = new Float32Array(x.length + samples);
  out.set(x, samples);
  return out;
}

export function trimStart(x: Float32Array, samples: number): Float32Array {
  return x.slice(samples);
}

export function applyGainDb(x: Float32Array, gainDb: number): Float32Array {
  const g = Math.pow(10, gainDb / 20);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 1) out[i] = x[i]! * g;
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Float32Array(n);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function writeWav(dir: string, name: string, channels: Float32Array[], fs: number): string {
  const file = path.join(dir, name);
  nodeFs.writeFileSync(file, encodeWav16(channels, fs));
  return file;
}
