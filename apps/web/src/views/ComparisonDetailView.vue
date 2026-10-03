<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  cancelComparison,
  deleteComparison,
  fallbackDigest,
  getArtifactUrl,
  getComparison,
  resumeComparison,
  type Comparison,
} from "../api/comparisons.js";
import { ApiError } from "../api/client.js";
import { formatDateTime, formatTimeMs } from "../utils/format.js";
import SyncedComparePlayer from "../components/SyncedComparePlayer.vue";

const route = useRoute();
const router = useRouter();
const comparison = ref<Comparison | null>(null);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const working = ref(false);
const baselineUrl = ref<string | null>(null);
const candidateUrl = ref<string | null>(null);
const diffUrl = ref<string | null>(null);
let pollHandle: ReturnType<typeof setTimeout> | null = null;

const statusLabels: Record<string, { text: string; cls: string }> = {
  PENDING: { text: "排队中", cls: "pending" },
  PROCESSING: { text: "处理中", cls: "processing" },
  READY: { text: "已完成", cls: "ready" },
  FAILED: { text: "失败", cls: "failed" },
  CANCELLED: { text: "已取消", cls: "cancelled" },
};

const stageLabels: Record<string, string> = {
  QUEUED: "排队等待",
  DECODING: "下载与解码",
  LOUDNESS: "响度测量与归一规划",
  ALIGNING: "同段对齐",
  DIFFING: "逐窗差异分析",
  RENDERING: "渲染对齐/差异音频",
  UPLOADING: "上传产物",
  FINALIZING: "结果落库",
  DONE: "完成",
};

const digest = computed<string[]>(() => {
  if (!comparison.value?.summary) return [];
  return fallbackDigest(comparison.value.summary);
});

const failureHint = computed<string | null>(() => {
  const code = comparison.value?.failureCode;
  if (!code) return null;
  const hints: Record<string, string> = {
    DECODE_FAILED: "音频解码失败。点击“续跑”可从检查点重试；若反复失败请重新上传该音频。",
    FFMPEG_UNAVAILABLE: "服务器暂未安装 ffmpeg，压缩格式无法解析；请改用 WAV 音频后续跑。",
    SILENT_TRACK: "其中一轨为静音或响度过低，无法完成对比。",
    MEDIA_NOT_READY: "引用的音频尚未就绪或已被删除。",
    COMPARISON_RUN_FAILED: "处理过程出现临时错误，已保留检查点，可直接续跑。",
  };
  return hints[code] ?? "发生未知错误，可尝试续跑。";
});

const trackRows = computed(() => {
  if (!comparison.value) return [];
  return comparison.value.tracks.map((track) => ({
    label: track.label,
    role: track.role === "BASELINE" ? "基线" : "候选",
    measuredLufs: track.measuredLufs == null ? "—" : track.measuredLufs.toFixed(2),
    gainDb: track.gainDb == null ? "—" : `${track.gainDb >= 0 ? "+" : ""}${track.gainDb.toFixed(2)} dB`,
    peakDb: track.peakDb == null ? "—" : `${track.peakDb.toFixed(2)} dBTP`,
    offsetMs: track.offsetMs == null ? "—" : `${track.offsetMs > 0 ? "+" : ""}${track.offsetMs} ms`,
    correlation: track.correlation == null ? "—" : track.correlation.toFixed(3),
  }));
});

const worstWindows = computed(() => comparison.value?.summary?.worstWindows ?? []);

async function loadArtifacts(): Promise<void> {
  if (comparison.value?.status !== "READY") return;
  try {
    const [base, cand, diff] = await Promise.all([
      getArtifactUrl(comparison.value.id, "aligned-0"),
      getArtifactUrl(comparison.value.id, "aligned-1"),
      getArtifactUrl(comparison.value.id, "diff"),
    ]);
    baselineUrl.value = base;
    candidateUrl.value = cand;
    diffUrl.value = diff;
  } catch {
    actionError.value = "产物播放地址获取失败，请稍后刷新页面";
  }
}

async function refresh(): Promise<void> {
  const id = String(route.params.id);
  try {
    comparison.value = await getComparison(id);
    if (["PENDING", "PROCESSING"].includes(comparison.value.status) && comparison.value.status !== "CANCELLED") {
      pollHandle = setTimeout(() => void refresh(), 2000);
    } else if (comparison.value.status === "READY" && !baselineUrl.value) {
      await loadArtifacts();
    }
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "加载失败";
  }
}

async function resume(): Promise<void> {
  if (!comparison.value) return;
  working.value = true;
  actionError.value = null;
  try {
    await resumeComparison(comparison.value.id);
    await refresh();
  } catch (caught) {
    actionError.value = caught instanceof ApiError ? caught.message : "续跑失败";
  } finally {
    working.value = false;
  }
}

async function cancel(): Promise<void> {
  if (!comparison.value) return;
  if (!window.confirm("取消后会清理本次生成的临时音频对象和本地临时文件，确定继续？")) return;
  working.value = true;
  actionError.value = null;
  try {
    await cancelComparison(comparison.value.id);
    await refresh();
  } catch (caught) {
    actionError.value = caught instanceof ApiError ? caught.message : "取消失败";
  } finally {
    working.value = false;
  }
}

async function remove(): Promise<void> {
  if (!comparison.value) return;
  if (!window.confirm("确定删除该对比记录？此操作不可恢复。")) return;
  await deleteComparison(comparison.value.id);
  await router.push({ name: "comparisons" });
}

const inProgress = computed(() => ["PENDING", "PROCESSING"].includes(comparison.value?.status ?? ""));

onMounted(() => void refresh());
onBeforeUnmount(() => {
  if (pollHandle) clearTimeout(pollHandle);
});
</script>

<template>
  <div class="page comparison-detail-page">
    <div v-if="error" class="card inline-error">{{ error }}</div>
    <template v-else-if="comparison">
      <div class="page-header">
        <div>
          <RouterLink class="back-link" :to="{ name: 'comparisons' }">← 返回对比台</RouterLink>
          <h1>{{ comparison.title }}</h1>
          <p>
            版本组 <code>{{ comparison.groupId }}</code> · 第 {{ comparison.revision }} 版 ·
            创建于 {{ formatDateTime(comparison.createdAt) }}
          </p>
        </div>
        <div class="header-actions">
          <span class="status-pill" :class="statusLabels[comparison.status]?.cls">{{ statusLabels[comparison.status]?.text ?? comparison.status }}</span>
          <RouterLink
            class="button small ghost"
            :to="{ name: 'comparison-new-revision', query: { groupId: comparison.groupId, title: comparison.title } }"
          >
            同段再对比一版
          </RouterLink>
          <button v-if="comparison.status === 'FAILED'" type="button" class="button" :disabled="working" @click="resume">失败续跑</button>
          <button v-if="inProgress" type="button" class="button ghost" :disabled="working || comparison.cancelRequested" @click="cancel">
            {{ comparison.cancelRequested ? "正在取消…" : "取消并清理" }}
          </button>
          <button type="button" class="button danger-ghost" :disabled="working" @click="remove">删除</button>
        </div>
      </div>

      <div v-if="actionError" class="card inline-error">{{ actionError }}</div>

      <div v-if="inProgress" class="card progress-card">
        <div class="progress-head">
          <strong>{{ stageLabels[comparison.stage] ?? comparison.stage }}</strong>
          <span>{{ comparison.progressPct }}%</span>
        </div>
        <div class="progress-track"><div class="progress-bar" :style="{ width: `${comparison.progressPct}%` }" /></div>
        <small class="muted">处理在后台进行，关闭页面也不会中断；取消请求会在下一个阶段边界生效并清理临时对象。</small>
      </div>

      <div v-else-if="comparison.status === 'FAILED'" class="card failure-card">
        <h2>对比失败</h2>
        <p>{{ failureHint }}</p>
        <small class="muted">失败码：{{ comparison.failureCode }}；{{ comparison.failureMessage }}</small>
        <div class="failure-actions">
          <button type="button" class="button" :disabled="working" @click="resume">从检查点续跑</button>
        </div>
      </div>

      <div v-else-if="comparison.status === 'CANCELLED'" class="card cancelled-card">
        <h2>已取消</h2>
        <p>本次对比已取消，生成的临时音频对象与本地临时目录均已清理。历史记录保留只读视图，不可覆盖。</p>
      </div>

      <template v-else-if="comparison.status === 'READY' && comparison.summary">
        <div class="grid grid-4 metrics-row">
          <div class="card metric"><strong>{{ comparison.summary.similarityScore }}<small>/100</small></strong><span>综合相似度</span></div>
          <div class="card metric"><strong>{{ comparison.summary.overallCorrelation.toFixed(3) }}</strong><span>对齐后波形相关系数</span></div>
          <div class="card metric">
            <strong>{{ comparison.summary.meanRmsDeltaDb === null ? "—" : comparison.summary.meanRmsDeltaDb.toFixed(2) }}<small> dB</small></strong>
            <span>候选相对基线平均响度差</span>
          </div>
          <div class="card metric"><strong>{{ comparison.summary.alignment?.offsetMs ?? 0 }}<small> ms</small></strong><span>同段对齐偏移（候选 − 基线）</span></div>
        </div>

        <div class="grid grid-2 detail-grid">
          <section class="card">
            <div class="card-title"><h2>差异摘要</h2></div>
            <ul class="digest-list">
              <li v-for="(line, index) in digest" :key="index">{{ line }}</li>
            </ul>
            <dl class="extra-stats">
              <div><dt>逐窗最大响度偏差</dt><dd>{{ comparison.summary.maxRmsDeltaDb?.toFixed(2) ?? "—" }} dB</dd></div>
              <div><dt>平均绝对样本差</dt><dd>{{ comparison.summary.meanAbsDelta.toFixed(5) }}</dd></div>
              <div><dt>有效重叠覆盖率</dt><dd>{{ comparison.summary.coveragePct }}%</dd></div>
              <div><dt>对齐后时长</dt><dd>{{ formatTimeMs(comparison.summary.alignedDurationMs) }}</dd></div>
              <div><dt>分析窗口数</dt><dd>{{ comparison.summary.windowCount ?? "—" }}</dd></div>
              <div><dt>对齐置信相关</dt><dd>{{ comparison.summary.alignment?.correlation?.toFixed(3) ?? "—" }}</dd></div>
            </dl>
          </section>

          <section class="card">
            <div class="card-title"><h2>各版本响度归一参数</h2></div>
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>版本</th><th>角色</th><th>测量 LUFS</th><th>补偿增益</th><th>真峰值</th><th>偏移</th><th>相关</th></tr>
                </thead>
                <tbody>
                  <tr v-for="row in trackRows" :key="row.label">
                    <td>{{ row.label }}</td>
                    <td>{{ row.role }}</td>
                    <td>{{ row.measuredLufs }}</td>
                    <td>{{ row.gainDb }}</td>
                    <td>{{ row.peakDb }}</td>
                    <td>{{ row.offsetMs }}</td>
                    <td>{{ row.correlation }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <small class="muted">所有版本统一归一到 {{ comparison.targetLufs }} LUFS，真峰值不超过 {{ comparison.truePeakDbTp }} dBTP 后再做对齐与差异计算。</small>
          </section>
        </div>

        <SyncedComparePlayer :baseline-url="baselineUrl" :candidate-url="candidateUrl" :diff-url="diffUrl" />

        <section class="card">
          <div class="card-title">
            <h2>差异最大的片段</h2>
            <small>按窗口平均绝对差排序，最多展示 5 段</small>
          </div>
          <div v-if="worstWindows.length === 0" class="muted">没有明显差异片段。</div>
          <div v-else class="table-wrap">
            <table class="data-table">
              <thead>
                <tr><th>#</th><th>时间范围</th><th>基线 RMS</th><th>候选 RMS</th><th>响度差</th><th>相关系数</th></tr>
              </thead>
              <tbody>
                <tr v-for="(window, index) in worstWindows" :key="`${window.startMs}-${window.endMs}`">
                  <td>{{ index + 1 }}</td>
                  <td>{{ formatTimeMs(window.startMs) }} – {{ formatTimeMs(window.endMs) }}</td>
                  <td>{{ window.baselineRmsDb === null ? "—" : `${window.baselineRmsDb.toFixed(1)} dB` }}</td>
                  <td>{{ window.candidateRmsDb === null ? "—" : `${window.candidateRmsDb.toFixed(1)} dB` }}</td>
                  <td :class="{ 'delta-large': window.rmsDeltaDb !== null && Math.abs(window.rmsDeltaDb) >= 3 }">
                    {{ window.rmsDeltaDb === null ? "—" : `${window.rmsDeltaDb > 0 ? "+" : ""}${window.rmsDeltaDb.toFixed(2)} dB` }}
                  </td>
                  <td :class="{ 'correlation-low': window.correlation < 0.5 }">{{ window.correlation.toFixed(3) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.back-link { display: inline-block; margin-bottom: 8px; text-decoration: none; font-weight: 650; }
.header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.status-pill { font-size: .8rem; font-weight: 700; padding: 4px 12px; border-radius: 999px; }
.status-pill.ready { background: var(--primary-soft); color: var(--primary-strong); }
.status-pill.processing, .status-pill.pending { background: var(--warning-soft); color: var(--warning); }
.status-pill.failed { background: var(--danger-soft); color: var(--danger); }
.status-pill.cancelled { background: var(--surface-soft); color: var(--muted); }
.metrics-row { margin-bottom: 18px; }
.metric small { font-size: .9rem; letter-spacing: 0; }
.detail-grid { margin-bottom: 18px; }
.progress-card { display: grid; gap: 10px; margin-bottom: 18px; }
.progress-head { display: flex; justify-content: space-between; }
.progress-track { height: 10px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.progress-bar { height: 100%; background: var(--primary); border-radius: 999px; transition: width .4s ease; }
.digest-list { display: grid; gap: 8px; padding-left: 20px; margin-bottom: 18px; }
.extra-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 20px; margin: 0; }
.extra-stats div { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.extra-stats dt { color: var(--muted); }
.extra-stats dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
.data-table th, .data-table td { padding: 9px 10px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
.data-table th { color: var(--muted); font-weight: 700; }
.delta-large { color: var(--warning); font-weight: 700; }
.correlation-low { color: var(--danger); font-weight: 700; }
.failure-card, .cancelled-card { display: grid; gap: 10px; }
.failure-actions { margin-top: 6px; }
.danger-ghost { color: var(--danger); border-color: rgb(165 59 50 / 35%); }
code { font-size: .76rem; background: var(--surface-soft); padding: 2px 6px; border-radius: 6px; }
</style>
