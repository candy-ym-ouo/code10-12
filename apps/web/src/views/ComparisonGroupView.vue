<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { listRevisions, type Comparison } from "../api/comparisons.js";
import { ApiError } from "../api/client.js";
import { formatDateTime } from "../utils/format.js";

const route = useRoute();
const revisions = ref<Comparison[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);

const statusLabels: Record<string, { text: string; cls: string }> = {
  PENDING: { text: "排队中", cls: "pending" },
  PROCESSING: { text: "处理中", cls: "processing" },
  READY: { text: "已完成", cls: "ready" },
  FAILED: { text: "失败", cls: "failed" },
  CANCELLED: { text: "已取消", cls: "cancelled" },
};

onMounted(async () => {
  try {
    revisions.value = await listRevisions(String(route.params.groupId));
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "加载失败";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <RouterLink class="back-link" :to="{ name: 'comparisons' }">← 返回对比台</RouterLink>
        <h1>同段历史版本</h1>
        <p>同一组对比的全部历史版本按版本号升序排列，均为只读记录，不可覆盖；新一轮对比会生成新的版本号。</p>
      </div>
    </div>

    <div v-if="loading" class="card muted">加载中…</div>
    <div v-else-if="error" class="card inline-error">{{ error }}</div>
    <div v-else class="stack">
      <RouterLink
        v-for="item in revisions"
        :key="item.id"
        class="card revision-row"
        :to="{ name: 'comparison-detail', params: { id: item.id } }"
      >
        <div class="row-main">
          <span class="revision-no">v{{ item.revision }}</span>
          <span class="status-pill" :class="statusLabels[item.status]?.cls">{{ statusLabels[item.status]?.text ?? item.status }}</span>
          <strong>{{ item.title }}</strong>
          <small>{{ formatDateTime(item.createdAt) }}</small>
        </div>
        <div class="row-metrics">
          <span v-if="item.status === 'READY' && item.summary" class="metric-chip">
            相似度 {{ item.summary.similarityScore }} · 偏移 {{ item.summary.alignment?.offsetMs ?? 0 }} ms ·
            响度差 {{ item.summary.meanRmsDeltaDb === null ? "—" : `${item.summary.meanRmsDeltaDb.toFixed(2)} dB` }}
          </span>
          <span v-else-if="item.status === 'FAILED'" class="metric-chip failed-text">{{ item.failureMessage ?? "处理失败，可续跑" }}</span>
          <span v-else-if="item.status === 'CANCELLED'" class="metric-chip muted-text">已取消并清理临时对象</span>
          <span v-else class="metric-chip muted-text">{{ item.stage }} · {{ item.progressPct }}%</span>
        </div>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.back-link { display: inline-block; margin-bottom: 8px; text-decoration: none; font-weight: 650; }
.revision-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; text-decoration: none; color: inherit; flex-wrap: wrap; }
.revision-row:hover { border-color: var(--primary); }
.row-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.revision-no { font-weight: 800; font-size: 1.05rem; }
.status-pill { font-size: .75rem; font-weight: 700; padding: 2px 10px; border-radius: 999px; }
.status-pill.ready { background: var(--primary-soft); color: var(--primary-strong); }
.status-pill.processing, .status-pill.pending { background: var(--warning-soft); color: var(--warning); }
.status-pill.failed { background: var(--danger-soft); color: var(--danger); }
.status-pill.cancelled { background: var(--surface-soft); color: var(--muted); }
.metric-chip { font-size: .88rem; font-variant-numeric: tabular-nums; }
.failed-text { color: var(--danger); }
.muted-text { color: var(--muted); }
</style>
