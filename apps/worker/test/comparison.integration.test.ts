import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeWavPcm16 } from "../src/lib/pcm.js";

// 内存假 S3，必须在导入 comparison 之前完成 mock
const objectStore = new Map<string, Buffer>();
vi.mock("../src/lib/s3.js", () => ({
  getObjectStream: vi.fn(async (key: string) => {
    const { Readable } = await import("node:stream");
    const body = objectStore.get(key);
    if (!body) throw new Error(`missing object ${key}`);
    return Readable.from(body);
  }),
  putObjectBytes: vi.fn(async (key: string, body: Buffer | Uint8Array) => {
    objectStore.set(key, Buffer.from(body));
  }),
  objectExists: vi.fn(async (key: string) => objectStore.has(key)),
  deleteObjectQuiet: vi.fn(async (key: string) => {
    objectStore.delete(key);
  }),
}));

const { processComparison, cancelComparison } = await import("../src/lib/comparison.js");

const SR = 48000;

function makeWav(seconds: number, frequency: number, amplitude: number, leadMs = 0): Buffer {
  const length = Math.floor(seconds * SR);
  const data = new Float32Array(length + Math.floor((leadMs / 1000) * SR));
  for (let index = 0; index < length; index += 1) {
    const t = index / SR;
    const envelope = Math.min(1, index / 3000) * Math.min(1, (length - index) / 3000);
    data[index + Math.floor((leadMs / 1000) * SR)] =
      amplitude * envelope * (Math.sin(2 * Math.PI * frequency * t) + 0.3 * Math.sin(2 * Math.PI * frequency * 2 * t));
  }
  return encodeWavPcm16({ sampleRate: SR, channels: 1, data });
}

interface Row {
  id: string;
  status: string;
  stage: string;
  progressPct: number;
  cancelRequested: boolean;
  userId: string;
  targetLufs: number;
  truePeakDbTp: number;
  windowMs: number;
  hopMs: number;
  maxOffsetMs: number;
  summary: unknown;
  reportObjectKey: string | null;
  diffObjectKey: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  tracks: TrackRow[];
}

interface TrackRow {
  id: string;
  mediaId: string | null;
  comparisonId: string;
  position: number;
  role: string;
  label: string;
  measuredLufs: number | null;
  gainDb: number | null;
  peakDb: number | null;
  offsetMs: number | null;
  correlation: number | null;
  normalizedObjectKey: string | null;
  normalizedReady: boolean;
}

function fakePrisma(rows: Map<string, Row>) {
  return {
    audioComparison: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        return row ? JSON.parse(JSON.stringify(row, (key, value) => (value instanceof Date ? value : value))) : null;
      }),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("row missing");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; cancelRequested?: boolean; status?: unknown }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.cancelRequested === false && row.cancelRequested) continue;
          if (where.status && typeof where.status === "object" && "not" in (where.status as Record<string, unknown>) && row.status === (where.status as { not: string }).not) continue;
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
        return { count };
      }),
    },
    comparisonTrack: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        for (const row of rows.values()) {
          const track = row.tracks.find((item) => item.id === where.id);
          if (track) {
            Object.assign(track, data);
            return track;
          }
        }
        throw new Error("track missing");
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { comparisonId: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of rows.values()) {
          for (const track of row.tracks) {
            if (track.comparisonId === where.comparisonId) {
              Object.assign(track, data);
              count += 1;
            }
          }
        }
        return { count };
      }),
    },
    mediaAsset: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "media-0") return { id: where.id, objectKey: "src/base.wav", originalName: "base.wav", status: "READY", userId: "user-1" };
        if (where.id === "media-1") return { id: where.id, objectKey: "src/cand.wav", originalName: "cand.wav", status: "READY", userId: "user-1" };
        return null;
      }),
    },
    $transaction: vi.fn(async (work: unknown) => {
      if (typeof work === "function") return (work as (tx: unknown) => Promise<unknown>)(fakePrisma(rows));
      throw new Error("array transactions not supported in fake");
    }),
  };
}

const logger = () => () => undefined;
let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "compare-int-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("processComparison end-to-end", () => {
  it("runs the full pipeline: decode -> loudness -> align -> diff -> artifacts", async () => {
    const baseWav = makeWav(6, 440, 0.25, 0);
    const candWav = makeWav(6, 440, 0.5, 300); // 更响 + 晚 300ms
    objectStore.set("src/base.wav", baseWav);
    objectStore.set("src/cand.wav", candWav);

    const rows = new Map<string, Row>();
    const row: Row = {
      id: "cmp-1",
      status: "PENDING",
      stage: "QUEUED",
      progressPct: 0,
      cancelRequested: false,
      userId: "user-1",
      targetLufs: -23,
      truePeakDbTp: -1,
      windowMs: 2000,
      hopMs: 500,
      maxOffsetMs: 1500,
      summary: null,
      reportObjectKey: null,
      diffObjectKey: null,
      failureCode: null,
      failureMessage: null,
      cancelledAt: null,
      completedAt: null,
      updatedAt: new Date(),
      tracks: [
        { id: "t0", mediaId: "media-0", comparisonId: "cmp-1", position: 0, role: "BASELINE", label: "基线", measuredLufs: null, gainDb: null, peakDb: null, offsetMs: null, correlation: null, normalizedObjectKey: null, normalizedReady: false },
        { id: "t1", mediaId: "media-1", comparisonId: "cmp-1", position: 1, role: "CANDIDATE", label: "候选", measuredLufs: null, gainDb: null, peakDb: null, offsetMs: null, correlation: null, normalizedObjectKey: null, normalizedReady: false },
      ],
    };
    rows.set("cmp-1", row);
    const prisma = fakePrisma(rows);

    await processComparison(prisma as never, "cmp-1", logger());

    expect(row.status).toBe("READY");
    expect(row.progressPct).toBe(100);
    expect(row.failureCode).toBeNull();
    const summary = row.summary as { similarityScore: number; alignment: { offsetMs: number }; meanRmsDeltaDb: number | null };
    expect(summary.similarityScore).toBeGreaterThan(85);
    expect(Math.abs(summary.alignment.offsetMs - 300)).toBeLessThanOrEqual(6);
    expect(summary.meanRmsDeltaDb).not.toBeNull();
    expect(Math.abs(summary.meanRmsDeltaDb ?? 99)).toBeLessThan(0.8); // 响度归一后应基本一致

    // 候选更响，因此归一增益应小于基线（两者都向 -23 LUFS 靠拢）
    const baselineTrack = row.tracks[0]!;
    const candidateTrack = row.tracks[1]!;
    expect(candidateTrack.gainDb!).toBeLessThan(baselineTrack.gainDb!);
    expect(Math.abs(candidateTrack.offsetMs! - 300)).toBeLessThanOrEqual(6);

    // 4 个派生对象已上传
    expect(objectStore.has(row.reportObjectKey!)).toBe(true);
    expect(objectStore.has(row.diffObjectKey!)).toBe(true);
    expect(objectStore.has(row.tracks[0]!.normalizedObjectKey!)).toBe(true);
    expect(objectStore.has(row.tracks[1]!.normalizedObjectKey!)).toBe(true);

    // 产物是可解析的 WAV
    const diffWav = objectStore.get(row.diffObjectKey!);
    expect(diffWav?.subarray(0, 4).toString("latin1")).toBe("RIFF");

    // 临时目录已清理
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(tmpdir(), "practice-compare-cmp-1"))).toBe(false);
  });

  it("resumes from checkpoint after a simulated mid-run failure", async () => {
    objectStore.set("src/base.wav", makeWav(4, 520, 0.3));
    objectStore.set("src/cand.wav", makeWav(4, 520, 0.3, 120));

    const makeRow = (id: string): Row => ({
      id, status: "FAILED", stage: "FAILED", progressPct: 40, cancelRequested: false, userId: "user-1",
      targetLufs: -23, truePeakDbTp: -1, windowMs: 2000, hopMs: 500, maxOffsetMs: 1500,
      summary: null, reportObjectKey: null, diffObjectKey: null, failureCode: "COMPARISON_RUN_FAILED", failureMessage: "boom",
      cancelledAt: null, completedAt: null, updatedAt: new Date(),
      tracks: [
        { id: `${id}-t0`, mediaId: "media-0", comparisonId: id, position: 0, role: "BASELINE", label: "基线", measuredLufs: null, gainDb: null, peakDb: null, offsetMs: null, correlation: null, normalizedObjectKey: null, normalizedReady: false },
        { id: `${id}-t1`, mediaId: "media-1", comparisonId: id, position: 1, role: "CANDIDATE", label: "候选", measuredLufs: null, gainDb: null, peakDb: null, offsetMs: null, correlation: null, normalizedObjectKey: null, normalizedReady: false },
      ],
    });
    const rows = new Map<string, Row>([["cmp-resume", makeRow("cmp-resume")]]);
    const prisma = fakePrisma(rows);

    await processComparison(prisma as never, "cmp-resume", logger());
    const row = rows.get("cmp-resume")!;
    expect(row.status).toBe("READY");
    expect(row.failureCode).toBeNull();
    expect(Math.abs((row.summary as { alignment: { offsetMs: number } }).alignment.offsetMs - 120)).toBeLessThanOrEqual(6);
  });

  it("cancels a running comparison and deletes all derived artifacts", async () => {
    objectStore.set("src/base.wav", makeWav(4, 660, 0.3));
    objectStore.set("src/cand.wav", makeWav(4, 660, 0.3, 200));
    objectStore.set("users/user-1/comparisons/cmp-cancel/aligned-0.wav", Buffer.from("stale"));
    objectStore.set("users/user-1/comparisons/cmp-cancel/report.json", Buffer.from("stale"));

    const row: Row = {
      id: "cmp-cancel", status: "PROCESSING", stage: "DIFFING", progressPct: 60, cancelRequested: true, userId: "user-1",
      targetLufs: -23, truePeakDbTp: -1, windowMs: 2000, hopMs: 500, maxOffsetMs: 1500,
      summary: null,
      reportObjectKey: "users/user-1/comparisons/cmp-cancel/report.json",
      diffObjectKey: null,
      failureCode: null, failureMessage: null, cancelledAt: null, completedAt: null, updatedAt: new Date(),
      tracks: [
        { id: "ct0", mediaId: "media-0", comparisonId: "cmp-cancel", position: 0, role: "BASELINE", label: "基线", measuredLufs: -24, gainDb: 1, peakDb: -2, offsetMs: 0, correlation: 0.9, normalizedObjectKey: "users/user-1/comparisons/cmp-cancel/aligned-0.wav", normalizedReady: true },
        { id: "ct1", mediaId: "media-1", comparisonId: "cmp-cancel", position: 1, role: "CANDIDATE", label: "候选", measuredLufs: -24, gainDb: 1, peakDb: -2, offsetMs: 200, correlation: 0.9, normalizedObjectKey: null, normalizedReady: false },
      ],
    };
    const rows = new Map<string, Row>([["cmp-cancel", row]]);
    const prisma = fakePrisma(rows);

    await processComparison(prisma as never, "cmp-cancel", logger());

    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(row.reportObjectKey).toBeNull();
    // 假 prisma 原样存入 Prisma.DbNull（空对象标记），真实 PG 中对应 SQL NULL
    expect(row.summary).toMatchObject({});
    expect(row.stage).toBe("CANCELLED");
    expect(row.tracks[0]!.normalizedObjectKey).toBeNull();
    expect(row.tracks[0]!.measuredLufs).toBeNull();
    expect(row.tracks[0]!.normalizedReady).toBe(false);
    // 派生对象（含陈旧对象）全部删除；源音频不动
    expect(objectStore.has("users/user-1/comparisons/cmp-cancel/aligned-0.wav")).toBe(false);
    expect(objectStore.has("users/user-1/comparisons/cmp-cancel/report.json")).toBe(false);
    expect(objectStore.has("src/base.wav")).toBe(true);
    expect(objectStore.has("src/cand.wav")).toBe(true);
  });
});
