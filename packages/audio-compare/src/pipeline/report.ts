/** 汇总各阶段产物，生成机器可读 report.json 与人读 report.md。 */

import type { DiffMetrics } from "../dsp/diff.js";

export interface AlignmentArtifact {
  sampleRate: number;
  reference: string;
  results: Array<{
    key: string;
    name: string;
    offsetSamples: number;
    offsetSeconds: number;
    subSampleOffsetSamples: number;
    confidence: number;
    polarityInverted: boolean;
    overlapSamples: number;
  }>;
}

export interface LoudnessArtifact {
  targetLufs: number;
  reference: { key: string; name: string; lufs: number; gainDb: number; peakDb: number; peakDbAfterGain: number };
  candidates: Array<{
    key: string;
    name: string;
    lufs: number;
    gainDb: number;
    normalizedLufs: number;
    peakDb: number;
    peakDbAfterGain: number;
    clipRisk: boolean;
    silent: boolean;
  }>;
}

export interface DiffArtifact extends DiffMetrics {
  key: string;
  name: string;
}

export interface InputsArtifactForReport {
  reference: { key: string; name: string; path: string; sha256: string };
  candidates: Array<{ key: string; name: string; path: string; sha256: string }>;
}

export interface ComposeInput {
  version: string;
  createdAt: string;
  inputs: InputsArtifactForReport;
  alignment: AlignmentArtifact;
  loudness: LoudnessArtifact;
  diffs: DiffArtifact[];
}

function fmtLufs(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(2)} LUFS` : "-∞ LUFS";
}

function fmtDb(v: number): string {
  if (!Number.isFinite(v)) return v < 0 ? "-∞ dB" : "+∞ dB";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)} dB`;
}

function fmtPlainDb(v: number): string {
  if (!Number.isFinite(v)) return v < 0 ? "-∞ dB" : "+∞ dB";
  return `${v.toFixed(2)} dB`;
}

function fmtOffset(samples: number, seconds: number): string {
  const sign = samples > 0 ? "+" : samples < 0 ? "-" : "±";
  return `${sign}${Math.abs(samples)} 采样（${sign}${Math.abs(seconds * 1000).toFixed(1)} ms）`;
}

export function composeReport(input: ComposeInput): { json: unknown; markdown: string } {
  const { version, createdAt, inputs, alignment, loudness, diffs } = input;
  const generatedAt = new Date().toISOString();
  const alignByKey = new Map(alignment.results.map((r) => [r.key, r]));
  const loudByKey = new Map(loudness.candidates.map((c) => [c.key, c]));
  const diffByKey = new Map(diffs.map((d) => [d.key, d]));

  const candidates = inputs.candidates.map((meta) => ({
    name: meta.name,
    path: meta.path,
    sha256: meta.sha256,
    alignment: alignByKey.get(meta.key) ?? null,
    loudness: loudByKey.get(meta.key) ?? null,
    diff: diffByKey.get(meta.key) ?? null,
  }));

  const json = {
    version,
    createdAt,
    generatedAt,
    reference: {
      name: inputs.reference.name,
      path: inputs.reference.path,
      sha256: inputs.reference.sha256,
      lufs: loudness.reference.lufs,
      peakDb: loudness.reference.peakDb,
    },
    normalization: {
      targetLufs: loudness.targetLufs,
      mode: loudness.reference.gainDb === 0 ? "to-reference" : "explicit-target",
    },
    candidates,
  };

  const lines: string[] = [];
  lines.push(`# 音频版本对比报告：${version}`);
  lines.push("");
  lines.push(`- 创建时间：${createdAt}`);
  lines.push(`- 参考版本：${inputs.reference.name}（${fmtLufs(loudness.reference.lufs)}，峰值 ${fmtPlainDb(loudness.reference.peakDb)}）`);
  lines.push(`- 响度归一目标：${fmtLufs(loudness.targetLufs)}（${loudness.reference.gainDb === 0 ? "跟随参考版本" : "显式指定"}）`);
  lines.push(`- 候选数量：${candidates.length}`);
  lines.push("");
  lines.push("## 总体结论");
  lines.push("");
  lines.push("| 版本 | 对齐偏移 | 置信度 | 原始响度 | 归一增益 | 相关系数 | 残余电平 | 结论 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const cand of candidates) {
    const a = cand.alignment;
    const l = cand.loudness;
    const d = cand.diff;
    if (!a || !l || !d) continue;
    lines.push(
      `| ${cand.name} | ${fmtOffset(a.offsetSamples, a.offsetSeconds)} | ${a.confidence.toFixed(3)} | ${fmtLufs(l.lufs)} | ${fmtDb(l.gainDb)} | ${d.correlation.toFixed(4)} | ${fmtPlainDb(d.residualToRefDb)} | ${d.verdict} |`,
    );
  }
  lines.push("");

  for (const cand of candidates) {
    const a = cand.alignment;
    const l = cand.loudness;
    const d = cand.diff;
    if (!a || !l || !d) continue;
    lines.push(`## 候选详情：${cand.name}`);
    lines.push("");
    lines.push(`- 文件：${cand.path}`);
    lines.push(`- SHA-256：${cand.sha256}`);
    lines.push(
      `- 对齐：偏移 ${fmtOffset(a.offsetSamples, a.offsetSeconds)}，置信度 ${a.confidence.toFixed(3)}${a.polarityInverted ? "，疑似反相" : ""}`,
    );
    lines.push(
      `- 响度：原始 ${fmtLufs(l.lufs)} → 归一 ${fmtLufs(l.normalizedLufs)}（增益 ${fmtDb(l.gainDb)}），归一后峰值 ${fmtPlainDb(l.peakDbAfterGain)}${l.clipRisk ? "（超过 0 dBFS，存在削波风险）" : ""}`,
    );
    lines.push(`- 差异：相关系数 ${d.correlation.toFixed(6)}，残余电平 ${fmtPlainDb(d.residualToRefDb)}（相对参考）`);
    const bands = Object.entries(d.bandDeltaDb);
    if (bands.length > 0) {
      lines.push(`- 频段差异（候选-参考）：${bands.map(([band, delta]) => `${band}Hz ${fmtDb(delta)}`).join("，")}`);
    }
    if (d.topSegments.length > 0) {
      lines.push("");
      lines.push("最显著差异区段：");
      lines.push("");
      lines.push("| 区段 | 电平差 | 相关度 |");
      lines.push("|---|---|---|");
      for (const seg of d.topSegments) {
        lines.push(`| ${seg.startSec}s – ${seg.endSec}s | ${fmtDb(seg.deltaDb)} | ${seg.correlation.toFixed(3)} |`);
      }
    }
    lines.push("");
    lines.push(`结论：${d.verdict}`);
    lines.push("");
  }

  return { json, markdown: `${lines.join("\n")}\n` };
}
