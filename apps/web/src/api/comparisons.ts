import { apiFetch } from "./client.js";

export type ComparisonStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED" | "CANCELLED";

export interface ComparisonTrack {
  id: string;
  position: number;
  role: "BASELINE" | "CANDIDATE";
  label: string;
  mediaId: string | null;
  measuredLufs: number | null;
  gainDb: number | null;
  peakDb: number | null;
  offsetMs: number | null;
  correlation: number | null;
  normalizedReady: boolean;
  media: { id: string; originalName: string; durationMs: string | null; status: string };
}

export interface WorstWindow {
  startMs: number;
  endMs: number;
  baselineRmsDb: number | null;
  candidateRmsDb: number | null;
  rmsDeltaDb: number | null;
  correlation: number;
  meanAbsDelta: number;
  voiced: boolean;
}

export interface ComparisonSummary {
  alignment?: { offsetMs: number; correlation: number | null };
  overallCorrelation: number;
  similarityScore: number;
  meanRmsDeltaDb: number | null;
  maxRmsDeltaDb: number | null;
  meanAbsDelta: number;
  coveragePct: number;
  alignedDurationMs: number;
  worstWindows?: WorstWindow[];
  windowCount?: number;
  tracks?: Array<{
    position: number;
    role: string;
    label: string;
    mediaId: string;
    measuredLufs: number | null;
    gainDb: number | null;
    truePeakDb: number | null;
    truePeakLimited: boolean;
  }>;
}

export interface Comparison {
  id: string;
  groupId: string;
  revision: number;
  title: string;
  status: ComparisonStatus;
  stage: string;
  progressPct: number;
  targetLufs: number;
  truePeakDbTp: number;
  windowMs: number;
  hopMs: number;
  maxOffsetMs: number;
  summary: ComparisonSummary | null;
  failureCode: string | null;
  failureMessage: string | null;
  cancelRequested: boolean;
  cancelledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tracks: ComparisonTrack[];
}

export interface MediaOption {
  id: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  durationMs: string | null;
  processedAt: string | null;
  peaks: number[] | null;
  session: { title: string; instrument: string; startedAt: string };
}

export interface CreateComparisonInput {
  title: string;
  tracks: Array<{ mediaId: string; label?: string }>;
  groupId?: string;
  targetLufs?: number;
  truePeakDbTp?: number;
  windowMs?: number;
  hopMs?: number;
  maxOffsetMs?: number;
}

export async function listReadyMedia(): Promise<MediaOption[]> {
  return (await apiFetch<{ media: MediaOption[] }>("/api/v1/media")).media;
}

export async function listComparisons(params: { groupId?: string; status?: string; limit?: number } = {}): Promise<{
  comparisons: Comparison[];
  nextCursor: string | null;
}> {
  const search = new URLSearchParams();
  if (params.groupId) search.set("groupId", params.groupId);
  if (params.status) search.set("status", params.status);
  if (params.limit) search.set("limit", String(params.limit));
  const query = search.toString();
  return apiFetch(`/api/v1/comparisons${query ? `?${query}` : ""}`);
}

export async function getComparison(id: string): Promise<Comparison> {
  return (await apiFetch<{ comparison: Comparison }>(`/api/v1/comparisons/${id}`)).comparison;
}

export async function listRevisions(groupId: string): Promise<Comparison[]> {
  return (await apiFetch<{ revisions: Comparison[] }>(`/api/v1/comparisons/groups/${groupId}/revisions`)).revisions;
}

export async function createComparison(input: CreateComparisonInput): Promise<{ comparison: Comparison; groupId: string }> {
  return apiFetch("/api/v1/comparisons", { method: "POST", body: JSON.stringify(input) });
}

export async function resumeComparison(id: string): Promise<{ success: boolean; status: string }> {
  return apiFetch(`/api/v1/comparisons/${id}/resume`, { method: "POST", body: "{}" });
}

export async function cancelComparison(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/v1/comparisons/${id}/cancel`, { method: "POST", body: "{}" });
}

export async function deleteComparison(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/v1/comparisons/${id}`, { method: "DELETE" });
}

export async function getArtifactUrl(id: string, kind: "aligned-0" | "aligned-1" | "diff"): Promise<string> {
  return (await apiFetch<{ url: string }>(`/api/v1/comparisons/${id}/artifacts/${kind}/playback-url`)).url;
}

/** 用 buildComparisonDigest 的口径在前端兜底生成摘要行（保持与服务端文案一致）。 */
export function fallbackDigest(summary: ComparisonSummary): string[] {
  const lines: string[] = [];
  const verdict =
    summary.similarityScore >= 90 ? "高度一致"
      : summary.similarityScore >= 75 ? "整体接近、局部有差异"
        : summary.similarityScore >= 55 ? "存在明显差异"
          : "差异很大，疑似非同一演奏段落";
  lines.push(`综合相似度 ${summary.similarityScore}/100（${verdict}），波形相关系数 ${summary.overallCorrelation.toFixed(3)}。`);
  if (summary.alignment) {
    const offset = summary.alignment.offsetMs;
    lines.push(offset === 0
      ? `同段对齐：两版本起点一致（对齐相关 ${(summary.alignment.correlation ?? 0).toFixed(3)}）。`
      : `同段对齐：候选版本相对基线${offset > 0 ? "晚" : "早"} ${Math.abs(offset)} ms（对齐相关 ${(summary.alignment.correlation ?? 0).toFixed(3)}）。`);
  }
  if (summary.meanRmsDeltaDb !== null) {
    const delta = summary.meanRmsDeltaDb;
    lines.push(`响度归一后：${Math.abs(delta) < 0.3 ? "响度基本一致" : `候选版本平均${delta > 0 ? "响" : "轻"} ${Math.abs(delta).toFixed(2)} dB`}，逐窗最大偏差 ${(summary.maxRmsDeltaDb ?? 0).toFixed(2)} dB。`);
  }
  lines.push(`双方有效重叠覆盖率 ${summary.coveragePct}%。`);
  if (summary.coveragePct < 60) lines.push("提示：覆盖率偏低，两版本时长或内容差异较大，结论仅供参考。");
  return lines;
}
