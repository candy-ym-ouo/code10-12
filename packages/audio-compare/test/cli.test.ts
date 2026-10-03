import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyGainDb, delaySignal, makeNoise, makeTempDir, removeTempDir, writeWav } from "./fixtures.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "src", "cli.ts");
const FS = 16000;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("audio-compare CLI", () => {
  let dir: string;
  let runsDir: string;
  let reference: string;
  let candidate: string;

  beforeEach(() => {
    dir = makeTempDir();
    runsDir = path.join(dir, "runs");
    const ref = makeNoise(1.5, FS, 21, 0.25);
    reference = writeWav(dir, "ref.wav", [ref], FS);
    candidate = writeWav(dir, "cand.wav", [applyGainDb(delaySignal(ref, 320), -3)], FS);
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it(
    "run → 不可覆盖 → list/show/cancel 全流程",
    async () => {
      const run = await runCli([
        "run",
        "--version",
        "v1",
        "--reference",
        reference,
        "--candidate",
        candidate,
        "--runs-dir",
        runsDir,
      ]);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("对比完成：v1");
      expect(fs.existsSync(path.join(runsDir, "v1", "artifacts", "report.md"))).toBe(true);
      // 完成后临时对象已清理
      expect(fs.existsSync(path.join(runsDir, "v1", "tmp"))).toBe(false);

      // 历史版本不可覆盖
      const rerun = await runCli([
        "run",
        "--version",
        "v1",
        "--reference",
        reference,
        "--candidate",
        candidate,
        "--runs-dir",
        runsDir,
      ]);
      expect(rerun.code).toBe(3);
      expect(rerun.stderr).toContain("VERSION_IMMUTABLE");

      const list = await runCli(["list", "--runs-dir", runsDir]);
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("v1");
      expect(list.stdout).toContain("completed");

      const show = await runCli(["show", "--version", "v1", "--runs-dir", runsDir]);
      expect(show.code).toBe(0);
      expect(show.stdout).toContain("音频版本对比报告：v1");

      // 已完成的版本无需取消
      const cancel = await runCli(["cancel", "--version", "v1", "--runs-dir", runsDir]);
      expect(cancel.code).toBe(0);
      expect(cancel.stdout).toContain("无需取消");

      // resume 已完成版本同样拒绝
      const resume = await runCli(["resume", "--version", "v1", "--runs-dir", runsDir]);
      expect(resume.code).toBe(3);
    },
    60000,
  );

  it(
    "参数错误返回退出码 2",
    async () => {
      const missing = await runCli(["run", "--version", "v9", "--runs-dir", runsDir]);
      expect(missing.code).toBe(2);
      const unknown = await runCli(["frobnicate"]);
      expect(unknown.code).toBe(2);
    },
    30000,
  );
});
