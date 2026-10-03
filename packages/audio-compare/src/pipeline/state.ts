/** 运行状态机与原子持久化：所有状态/产物写入均“临时文件 + rename”，崩溃不留半截文件。 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STAGES = ["validate", "decode", "align", "normalize", "diff", "report"] as const;
export type StageName = (typeof STAGES)[number];

export type StageStatus = "pending" | "running" | "done" | "failed";
export type RunStatus = "running" | "failed" | "cancelled" | "completed";

export interface InputFingerprint {
  path: string;
  sha256: string;
  bytes: number;
}

export interface StageRecord {
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** 产物路径（相对运行目录），续跑时逐个校验存在性 */
  outputs: string[];
  error: string | null;
}

export interface CompareOptionsSnapshot {
  reference: string;
  candidates: string[];
  /** null 表示归一到参考版本响度 */
  targetLufs: number | null;
  maxOffsetSeconds: number;
}

export interface RunState {
  version: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  options: CompareOptionsSnapshot;
  inputs: { reference: InputFingerprint; candidates: InputFingerprint[] } | null;
  stages: Record<StageName, StageRecord>;
  error: string | null;
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertValidVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`INVALID_VERSION:${version}`);
  }
}

function initialStageRecord(): StageRecord {
  return { status: "pending", startedAt: null, finishedAt: null, outputs: [], error: null };
}

export function initialState(version: string, options: CompareOptionsSnapshot): RunState {
  const now = new Date().toISOString();
  const stages = {} as Record<StageName, StageRecord>;
  for (const name of STAGES) stages[name] = initialStageRecord();
  return {
    version,
    status: "running",
    createdAt: now,
    updatedAt: now,
    options,
    inputs: null,
    stages,
    error: null,
  };
}

export function stateFilePath(runDir: string): string {
  return path.join(runDir, "state.json");
}

export function readState(runDir: string): RunState | null {
  const file = stateFilePath(runDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as RunState;
}

/** 原子写入：先写同目录临时文件再 rename，state 的临时文件不放在 tmp/（避免被取消清理误删）。 */
export function writeStateAtomic(runDir: string, state: RunState): void {
  state.updatedAt = new Date().toISOString();
  const file = stateFilePath(runDir);
  const tmp = path.join(runDir, `.state.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), bytes };
}
