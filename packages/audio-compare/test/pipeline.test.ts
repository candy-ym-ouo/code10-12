import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CancelError, CancelToken, CompareError, runCompare, type CompareOptions } from "../src/pipeline/runner.js";
import { readState, STAGES, type StageName } from "../src/pipeline/state.js";
import {
  applyGainDb,
  delaySignal,
  makeNoise,
  makeSine,
  makeTempDir,
  mix,
  removeTempDir,
  writeWav,
} from "./fixtures.js";

const FS = 16000;

interface FixtureSet {
  reference: string;
  candidates: string[];
}

function makeInputs(dir: string): FixtureSet {
  const ref = mix(makeNoise(2.5, FS, 11, 0.25), makeSine(1000, 0.05, 2.5, FS));
  const c1 = applyGainDb(delaySignal(ref, 480), -6); // 晚 30ms、响度低 6 dB
  const c2 = mix(ref, makeSine(2000, 0.35, 0.4, FS), Math.round(1.2 * FS)); // 1.2s 处混入突发音
  const reference = writeWav(dir, "master-a.wav", [ref], FS);
  const candidates = [writeWav(dir, "take-b.wav", [c1], FS), writeWav(dir, "take-c.wav", [c2], FS)];
  return { reference, candidates };
}

describe("对比流水线", () => {
  let dir: string;
  let runsDir: string;
  let inputs: FixtureSet;
  let base: CompareOptions;

  beforeEach(() => {
    dir = makeTempDir();
    runsDir = path.join(dir, "runs");
    inputs = makeInputs(dir);
    base = {
      runsDir,
      version: "v1",
      reference: inputs.reference,
      candidates: inputs.candidates,
    };
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it("完整运行：对齐、响度归一、差异摘要、tmp 清理", async () => {
    const summary = await runCompare(base);
    expect(summary.status).toBe("completed");

    const state = readState(summary.runDir);
    expect(state?.status).toBe("completed");
    for (const stage of STAGES) expect(state?.stages[stage].status).toBe("done");

    // 对齐：take-b 延迟 480 采样（30ms）
    const alignment = JSON.parse(
      fs.readFileSync(path.join(summary.runDir, "artifacts", "alignment.json"), "utf8"),
    ) as { results: Array<{ name: string; offsetSamples: number; confidence: number }> };
    const takeB = alignment.results.find((r) => r.name === "take-b")!;
    expect(Math.abs(takeB.offsetSamples - 480)).toBeLessThanOrEqual(2);
    expect(takeB.confidence).toBeGreaterThan(0.9);

    // 响度归一：take-b 低 6 dB → 增益约 +6 dB
    const loudness = JSON.parse(
      fs.readFileSync(path.join(summary.runDir, "artifacts", "loudness.json"), "utf8"),
    ) as { candidates: Array<{ name: string; gainDb: number; normalizedLufs: number; lufs: number }> };
    const loudB = loudness.candidates.find((c) => c.name === "take-b")!;
    expect(Math.abs(loudB.gainDb - 6)).toBeLessThan(0.5);
    expect(Math.abs(loudB.normalizedLufs - loudness.candidates[1]!.normalizedLufs)).toBeLessThan(1);

    // 差异摘要：take-c 的突发音被定位到 1.2s 附近
    const diffC = JSON.parse(
      fs.readFileSync(path.join(summary.runDir, "artifacts", "diff.cand1.json"), "utf8"),
    ) as { topSegments: Array<{ startSec: number }>; verdict: string };
    expect(diffC.topSegments.length).toBeGreaterThan(0);
    expect(Math.abs(diffC.topSegments[0]!.startSec - 1.2)).toBeLessThanOrEqual(0.5);

    // 报告产物存在；tmp 已清理
    expect(fs.existsSync(summary.reportJsonPath)).toBe(true);
    expect(fs.existsSync(summary.reportMdPath)).toBe(true);
    expect(fs.existsSync(path.join(summary.runDir, "tmp"))).toBe(false);

    const reportMd = fs.readFileSync(summary.reportMdPath, "utf8");
    expect(reportMd).toContain("音频版本对比报告：v1");
    expect(reportMd).toContain("take-b");
  });

  it("历史版本不可覆盖：已完成版本拒绝重跑", async () => {
    await runCompare(base);
    await expect(runCompare(base)).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    // 换候选数量也不行
    await expect(runCompare({ ...base, candidates: [inputs.candidates[0]!] })).rejects.toMatchObject({
      code: "VERSION_IMMUTABLE",
    });
  });

  it("失败可续跑：已完成阶段不重复执行，tmp 现场保留", async () => {
    const started: StageName[] = [];
    await expect(
      runCompare(base, {
        onStageStart: (stage) => {
          started.push(stage);
          if (stage === "diff") throw new Error("注入故障");
        },
      }),
    ).rejects.toThrow("注入故障");

    const failedState = readState(path.join(runsDir, "v1"));
    expect(failedState?.status).toBe("failed");
    // 失败保留 tmp 现场
    expect(fs.existsSync(path.join(runsDir, "v1", "tmp", "pcm"))).toBe(true);

    const resumed: StageName[] = [];
    const summary = await runCompare(base, { onStageStart: (stage) => resumed.push(stage) });
    expect(summary.status).toBe("completed");
    // decode/align/normalize 产物仍在，不重复执行
    expect(resumed).not.toContain("decode");
    expect(resumed).not.toContain("align");
    expect(resumed).not.toContain("normalize");
    expect(resumed).toContain("diff");
    expect(resumed).toContain("report");
  });

  it("取消后清理临时对象，且可从断点续跑", async () => {
    const token = new CancelToken();
    await expect(
      runCompare(
        { ...base, cancelToken: token },
        {
          // align 完成后取消 → 取消落在 normalize 边界
          onStageDone: (stage) => {
            if (stage === "align") token.cancel();
          },
        },
      ),
    ).rejects.toBeInstanceOf(CancelError);

    const state = readState(path.join(runsDir, "v1"));
    expect(state?.status).toBe("cancelled");
    // 取消后临时对象已清理
    expect(fs.existsSync(path.join(runsDir, "v1", "tmp"))).toBe(false);

    // 续跑：decode 因 tmp 被清理而重跑，align 产物在 artifacts 中保留则跳过
    const resumed: StageName[] = [];
    const summary = await runCompare(base, { onStageStart: (stage) => resumed.push(stage) });
    expect(summary.status).toBe("completed");
    expect(resumed).toContain("decode");
    expect(resumed).not.toContain("align");
  });

  it("CANCEL 文件触发取消（供 cancel 命令/运维使用）", async () => {
    const runDir = path.join(runsDir, "v1");
    await expect(
      runCompare(base, {
        onStageStart: (stage) => {
          if (stage === "decode") fs.writeFileSync(path.join(runDir, "CANCEL"), "stop");
        },
      }),
    ).rejects.toBeInstanceOf(CancelError);
    const state = readState(runDir);
    expect(state?.status).toBe("cancelled");
    expect(fs.existsSync(path.join(runDir, "tmp"))).toBe(false);
    // 取消信号文件随清理移除，不会误伤下一次续跑
    expect(fs.existsSync(path.join(runDir, "CANCEL"))).toBe(false);
  });

  it("输入变更后拒绝续跑（INPUT_CHANGED）", async () => {
    await expect(
      runCompare(base, {
        onStageStart: (stage) => {
          if (stage === "diff") throw new Error("注入故障");
        },
      }),
    ).rejects.toThrow("注入故障");
    // 同路径重写不同内容
    writeWav(dir, "take-b.wav", [makeNoise(2.5, FS, 99)], FS);
    await expect(runCompare(base)).rejects.toMatchObject({ code: "INPUT_CHANGED" });
  });

  it("运行锁：活跃进程占用时拒绝并发运行", async () => {
    const runDir = path.join(runsDir, "v1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, ".lock"), String(process.pid));
    await expect(runCompare(base)).rejects.toMatchObject({ code: "RUN_LOCKED" });
  });

  it("不支持的格式给出明确错误", async () => {
    const fake = path.join(dir, "song.mp3");
    fs.writeFileSync(fake, Buffer.from("not audio"));
    await expect(runCompare({ ...base, candidates: [fake] })).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("静音参考且无显式目标时给出明确错误", async () => {
    const silent = writeWav(dir, "silent.wav", [new Float32Array(FS)], FS);
    await expect(
      runCompare({ ...base, version: "v2", reference: silent }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
