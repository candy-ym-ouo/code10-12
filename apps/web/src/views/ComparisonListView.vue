<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  cancelComparison,
  createComparison,
  deleteComparison,
  listComparisons,
  listReadyMedia,
  resumeComparison,
  type Comparison,
  type MediaOption,
} from "../api/comparisons.js";
import { ApiError } from "../api/client.js";
import { formatDateTime, formatDuration } from "../utils/format.js";

const router = useRouter();
const route = useRoute();
const loading = ref(true);
const error = ref<string | null>(null);
const comparisons = ref<Comparison[]>([]);
const mediaOptions = ref<MediaOption[]>([]);
const showCreate = ref(false);
const submitting = ref(false);
const formError = ref<string | null>(null);

const form = ref({
  title: "",
  groupId: "" as string,
  baselineMediaId: "",
  candidateMediaId: "",
  baselineLabel: "基线版本",
  candidateLabel: "候选版本",
  targetLufs: -23,
  truePeakDbTp: -1,
  windowMs: 2000,
  hopMs: 500,
  maxOffsetMs: 1500,
});

const statusLabels: Record<string, { text: string; cls: string }> = {
  PENDING: { text: "排队中", cls: "pending" },
  PROCESSING: { text: "处理中", cls: "processing" },
  READY: { text: "已完成", cls: "ready" },
  FAILED: { text: "失败", cls: "failed" },
  CANCELLED: { text: "已取消", cls: "cancelled" },
};

const stageLabels: Record<string, string> = {
  QUEUED: "排队",
  DECODING: "下载与解码",
  LOUDNESS: "响度测量",
  ALIGNING: "同段对齐",
  DIFFING: "差异分析",
  RENDERING: "渲染产物",
  UPLOADING: "上传产物",
  FINALIZING: "落库",
  DONE: "完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

interface Group {
  groupId: string;
  title: string;
  revisions: Comparison[];
}

const groups = computed<Group[]>(() => {
  const map = new Map<string, Group>();
  for (const comparison of comparisons.value) {
    let group = map.get(comparison.groupId);
    if (!group) {
      group = { groupId: comparison.groupId, title: comparison.title, revisions: [] };
      map.set(comparison.groupId, group);
    }
    group.revisions.push(comparison);
  }
  return [...map.values()].sort((a, b) => {
    const aTime = Date.parse(a.revisions[0]?.createdAt ?? "");
    const bTime = Date.parse(b.revisions[0]?.createdAt ?? "");
    return bTime - aTime;
  });
});

async function refresh(): Promise<void> {
  try {
    const result = await listComparisons({ limit: 50 });
    comparisons.value = result.comparisons;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function openCreate(): Promise<void> {
  formError.value = null;
  form.value.groupId = typeof route.query.groupId === "string" ? route.query.groupId : "";
  if (typeof route.query.groupId === "string") {
    form.value.title = typeof route.query.title === "string" ? route.query.title : form.value.title;
  }
  if (mediaOptions.value.length === 0) {
    try {
      mediaOptions.value = await listReadyMedia();
    } catch (caught) {
      formError.value = caught instanceof ApiError ? caught.message : "音频列表加载失败";
      return;
    }
  }
  showCreate.value = true;
}

function mediaLabel(item: MediaOption): string {
  return `${item.session.title} · ${item.originalName}`;
}

async function submitCreate(): Promise<void> {
  formError.value = null;
  if (!form.value.title.trim()) {
    formError.value = "请填写对比标题";
    return;
  }
  if (!form.value.baselineMediaId || !form.value.candidateMediaId) {
    formError.value = "请分别选择基线和候选音频";
    return;
  }
  if (form.value.baselineMediaId === form.value.candidateMediaId) {
    formError.value = "基线与候选必须是两段不同的音频";
    return;
  }
  submitting.value = true;
  try {
    const { comparison } = await createComparison({
      title: form.value.title.trim(),
      ...(form.value.groupId ? { groupId: form.value.groupId } : {}),
      tracks: [
        { mediaId: form.value.baselineMediaId, label: form.value.baselineLabel.trim() || "基线版本" },
        { mediaId: form.value.candidateMediaId, label: form.value.candidateLabel.trim() || "候选版本" },
      ],
      targetLufs: Number(form.value.targetLufs),
      truePeakDbTp: Number(form.value.truePeakDbTp),
      windowMs: Number(form.value.windowMs),
      hopMs: Number(form.value.hopMs),
      maxOffsetMs: Number(form.value.maxOffsetMs),
    });
    showCreate.value = false;
    await router.push({ name: "comparison-detail", params: { id: comparison.id } });
  } catch (caught) {
    formError.value = caught instanceof ApiError ? caught.message : "创建失败，请重试";
  } finally {
    submitting.value = false;
  }
}

async function resume(id: string, event: Event): Promise<void> {
  event.stopPropagation();
  await resumeComparison(id);
  await refresh();
}

async function cancel(id: string, event: Event): Promise<void> {
  event.stopPropagation();
  await cancelComparison(id);
  await refresh();
}

async function remove(id: string, event: Event): Promise<void> {
  event.stopPropagation();
  if (!window.confirm("确定删除该对比记录及其产物？此操作不可恢复。")) return;
  await deleteComparison(id);
  await refresh();
}

onMounted(async () => {
  await refresh();
  if (typeof route.query.groupId === "string") await openCreate();
});
</script>

<template>
  <div class="page comparison-list-page">
    <div class="page-header">
      <div>
        <h1>多版本音频对比台</h1>
        <p>选择同一段练习的两个版本，服务端完成同段对齐、EBU R128 响度归一与差异摘要。历史版本按版本号只读保留，失败可从检查点续跑，取消会清理全部临时产物。</p>
      </div>
      <button class="button" type="button" @click="openCreate">＋ 新建对比</button>
    </div>

    <div v-if="loading" class="card muted">加载中…</div>
    <div v-else-if="error" class="card inline-error">{{ error }}</div>
    <div v-else-if="groups.length === 0" class="card empty-state">
      <p>还没有任何对比记录。</p>
      <button class="button" type="button" @click="openCreate">创建第一次对比</button>
    </div>

    <div v-else class="stack">
      <article v-for="group in groups" :key="group.groupId" class="card comparison-group">
        <header class="group-head">
          <div>
            <h2>{{ group.title }}</h2>
            <small>同段版本组 · {{ group.revisions.length }} 个历史版本（不可覆盖）</small>
          </div>
          <RouterLink class="button small ghost" :to="{ name: 'comparison-group', params: { groupId: group.groupId } }">查看全部版本</RouterLink>
        </header>
        <div class="revision-grid">
          <button
            v-for="item in group.revisions"
            :key="item.id"
            type="button"
            class="revision-card"
            @click="router.push({ name: 'comparison-detail', params: { id: item.id } })"
          >
            <div class="revision-top">
              <span class="revision-no">v{{ item.revision }}</span>
              <span class="status-pill" :class="statusLabels[item.status]?.cls">{{ statusLabels[item.status]?.text ?? item.status }}</span>
            </div>
            <div class="revision-meta">
              <strong v-if="item.status === 'READY' && item.summary">相似度 {{ item.summary.similarityScore }}</strong>
              <span v-else-if="item.status === 'PROCESSING'">{{ stageLabels[item.stage] ?? item.stage }} · {{ item.progressPct }}%</span>
              <span v-else-if="item.failureMessage" class="muted">{{ item.failureMessage }}</span>
              <span v-else class="muted">{{ stageLabels[item.stage] ?? item.stage }}</span>
            </div>
            <small>{{ formatDateTime(item.createdAt) }}</small>
            <div class="revision-actions" @click.stop>
              <button v-if="item.status === 'FAILED'" type="button" class="button small" @click="resume(item.id, $event)">续跑</button>
              <button v-if="['PENDING', 'PROCESSING'].includes(item.status)" type="button" class="button small ghost" :disabled="item.cancelRequested" @click="cancel(item.id, $event)">
                {{ item.cancelRequested ? "取消中…" : "取消" }}
              </button>
              <button type="button" class="button small danger-ghost" @click="remove(item.id, $event)">删除</button>
            </div>
          </button>
        </div>
      </article>
    </div>

    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
      <div class="modal card">
        <div class="card-title">
          <h2>新建音频对比</h2>
          <button type="button" class="button small ghost" @click="showCreate = false">关闭</button>
        </div>
        <form class="stack" @submit.prevent="submitCreate">
          <div v-if="form.groupId" class="revision-banner">
            将作为同段对比组 <code>{{ form.groupId.slice(0, 8) }}…</code> 的新版本提交，历史版本保持只读。
          </div>
          <label class="field">
            <span>对比标题</span>
            <input v-model="form.title" maxlength="120" placeholder="例如：第 12 小节连奏 · 周一 vs 周三" />
          </label>
          <div class="grid grid-2">
            <label class="field">
              <span>基线版本（参考）</span>
              <select v-model="form.baselineMediaId">
                <option value="" disabled>选择已就绪音频</option>
                <option v-for="item in mediaOptions" :key="item.id" :value="item.id">{{ mediaLabel(item) }}（{{ formatDuration(item.durationMs === null ? null : Number(item.durationMs)) }}）</option>
              </select>
              <input v-model="form.baselineLabel" class="label-input" maxlength="120" placeholder="显示名：基线版本" />
            </label>
            <label class="field">
              <span>候选版本（对比）</span>
              <select v-model="form.candidateMediaId">
                <option value="" disabled>选择已就绪音频</option>
                <option v-for="item in mediaOptions" :key="item.id" :value="item.id">{{ mediaLabel(item) }}（{{ formatDuration(item.durationMs === null ? null : Number(item.durationMs)) }}）</option>
              </select>
              <input v-model="form.candidateLabel" class="label-input" maxlength="120" placeholder="显示名：候选版本" />
            </label>
          </div>
          <details class="advanced">
            <summary>高级参数（响度/对齐/窗口）</summary>
            <div class="grid grid-3 adv-grid">
              <label class="field"><span>目标响度 LUFS（-40 ~ -5）</span><input v-model.number="form.targetLufs" type="number" min="-40" max="-5" step="0.5" /></label>
              <label class="field"><span>真峰值上限 dBTP</span><input v-model.number="form.truePeakDbTp" type="number" min="-9" max="0" step="0.1" /></label>
              <label class="field"><span>最大对齐偏移 ms</span><input v-model.number="form.maxOffsetMs" type="number" min="0" max="5000" step="50" /></label>
              <label class="field"><span>差异窗口 ms</span><input v-model.number="form.windowMs" type="number" min="500" max="10000" step="100" /></label>
              <label class="field"><span>窗口步长 ms</span><input v-model.number="form.hopMs" type="number" min="100" max="5000" step="50" /></label>
            </div>
          </details>
          <div v-if="formError" class="inline-error">{{ formError }}</div>
          <div class="modal-actions">
            <button type="button" class="button ghost" @click="showCreate = false">取消</button>
            <button type="submit" class="button" :disabled="submitting">{{ submitting ? "提交中…" : "开始对比" }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comparison-group { display: grid; gap: 14px; }
.group-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.group-head h2 { margin: 0 0 2px; }
.revision-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.revision-card { text-align: left; display: grid; gap: 8px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: #fbfcfb; cursor: pointer; transition: border-color .15s, transform .15s; }
.revision-card:hover { border-color: var(--primary); transform: translateY(-1px); }
.revision-top { display: flex; align-items: center; justify-content: space-between; }
.revision-no { font-weight: 800; letter-spacing: -0.02em; }
.revision-meta { min-height: 20px; font-size: .92rem; }
.revision-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.status-pill { font-size: .72rem; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
.status-pill.ready { background: var(--primary-soft); color: var(--primary-strong); }
.status-pill.processing, .status-pill.pending { background: var(--warning-soft); color: var(--warning); }
.status-pill.failed { background: var(--danger-soft); color: var(--danger); }
.status-pill.cancelled { background: var(--surface-soft); color: var(--muted); }
.modal-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: rgb(21 32 30 / 45%); }
.modal { width: min(720px, 100%); max-height: 90vh; overflow: auto; }
.field { display: grid; gap: 6px; font-size: .9rem; font-weight: 650; }
.field input, .field select { padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: #fff; }
.label-input { font-weight: 400; }
.advanced summary { cursor: pointer; font-weight: 650; margin-bottom: 10px; }
.adv-grid { gap: 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
.revision-banner { padding: 10px 14px; border-radius: 10px; background: var(--primary-soft); color: var(--primary-strong); font-size: .86rem; }
.revision-banner code { background: rgb(255 255 255 / 60%); }
.danger-ghost { color: var(--danger); border-color: rgb(165 59 50 / 35%); }
.empty-state { display: grid; gap: 12px; place-items: center; padding: 60px 20px; text-align: center; }
</style>
