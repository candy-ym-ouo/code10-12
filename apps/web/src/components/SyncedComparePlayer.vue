<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { formatTimeMs } from "../utils/format.js";
import { ApiError } from "../api/client.js";

const props = defineProps<{
  baselineUrl: string | null;
  candidateUrl: string | null;
  diffUrl: string | null;
}>();

type Mode = "MIX" | "BASELINE" | "CANDIDATE" | "DIFF";

const mode = ref<Mode>("MIX");
const loading = ref(false);
const loadError = ref<string | null>(null);
const playing = ref(false);
const currentMs = ref(0);
const durationMs = ref(0);
const canvasRefs = {
  baseline: ref<HTMLCanvasElement | null>(null),
  candidate: ref<HTMLCanvasElement | null>(null),
  diff: ref<HTMLCanvasElement | null>(null),
};

interface LoadedTrack {
  buffer: AudioBuffer;
  peaks: number[];
}

const tracks = new Map<Mode, LoadedTrack>();
const order: Array<{ mode: Mode; key: "baseline" | "candidate" | "diff"; label: string }> = [
  { mode: "BASELINE", key: "baseline", label: "基线（归一后）" },
  { mode: "CANDIDATE", key: "candidate", label: "候选（归一后）" },
  { mode: "DIFF", key: "diff", label: "差异（基线 − 候选）" },
];

let audioContext: AudioContext | null = null;
let sources: AudioBufferSourceNode[] = [];
let gains: Record<Mode, GainNode | null> = { MIX: null, BASELINE: null, CANDIDATE: null, DIFF: null };
let startedAtContextTime = 0;
let startedAtOffsetMs = 0;
let rafHandle: number | null = null;

const modes: Array<{ value: Mode; label: string }> = [
  { value: "MIX", label: "混合同听" },
  { value: "BASELINE", label: "仅基线" },
  { value: "CANDIDATE", label: "仅候选" },
  { value: "DIFF", label: "听差异" },
];

const progressPct = computed(() => (durationMs.value ? (currentMs.value / durationMs.value) * 100 : 0));

function computePeaks(buffer: AudioBuffer, bucketCount: number): number[] {
  const channel = buffer.getChannelData(0);
  const buckets = Math.min(bucketCount, channel.length);
  const size = Math.floor(channel.length / buckets);
  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    let max = 0;
    const end = bucket === buckets - 1 ? channel.length : (bucket + 1) * size;
    for (let index = bucket * size; index < end; index += 1) {
      const abs = Math.abs(channel[index] ?? 0);
      if (abs > max) max = abs;
    }
    peaks.push(max);
  }
  return peaks;
}

function drawWave(canvas: HTMLCanvasElement | null, peaks: number[], color: string): void {
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const barWidth = width / peaks.length;
  context.fillStyle = color;
  const mid = height / 2;
  for (let index = 0; index < peaks.length; index += 1) {
    const barHeight = Math.max(1, (peaks[index] ?? 0) * height * 0.92);
    context.fillRect(index * barWidth, mid - barHeight / 2, Math.max(1, barWidth * 0.7), barHeight);
  }
}

function drawPlayheads(): void {
  for (const item of order) {
    const canvas = canvasRefs[item.key].value;
    if (!canvas) continue;
    const context = canvas.getContext("2d");
    if (!context) continue;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const x = (progressPct.value / 100) * width;
    context.save();
    context.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    context.strokeStyle = "#132823";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
    context.restore();
  }
}

async function fetchDecode(url: string, signal?: AbortSignal): Promise<AudioBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载失败：${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(arrayBuffer);
  void context.close();
  return buffer;
}

async function load(): Promise<void> {
  if (!props.baselineUrl || !props.candidateUrl || !props.diffUrl || tracks.size > 0 || loading.value) return;
  loading.value = true;
  loadError.value = null;
  try {
    const entries: Array<[Mode, string | null, "baseline" | "candidate" | "diff", string]> = [
      ["BASELINE", props.baselineUrl, "baseline", "#145c55"],
      ["CANDIDATE", props.candidateUrl, "candidate", "#3778b7"],
      ["DIFF", props.diffUrl, "diff", "#a53b32"],
    ];
    for (const [trackMode, url, canvasKey, color] of entries) {
      if (!url) continue;
      const buffer = await fetchDecode(url);
      const peaks = computePeaks(buffer, 600);
      tracks.set(trackMode, { buffer, peaks });
      drawWave(canvasRefs[canvasKey].value, peaks, color);
    }
    durationMs.value = Math.max(0, ...[...tracks.values()].map((track) => track.buffer.duration * 1000));
  } catch (error) {
    loadError.value = error instanceof ApiError ? error.message : "对比音频加载失败，请重试";
  } finally {
    loading.value = false;
  }
}

function ensureContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

function modeGains(): { baseline: number; candidate: number; diff: number } {
  switch (mode.value) {
    case "BASELINE": return { baseline: 1, candidate: 0, diff: 0 };
    case "CANDIDATE": return { baseline: 0, candidate: 1, diff: 0 };
    case "DIFF": return { baseline: 0, candidate: 0, diff: 1 };
    default: return { baseline: 0.85, candidate: 0.85, diff: 0 };
  }
}

function stopSources(): void {
  for (const source of sources) {
    try { source.onended = null; source.stop(); } catch { /* 已停止 */ }
    source.disconnect();
  }
  sources = [];
}

function startPlayback(offsetMs: number): void {
  const context = ensureContext();
  stopSources();
  const preset = modeGains();
  const routing: Array<[Mode, number]> = [
    ["BASELINE", preset.baseline],
    ["CANDIDATE", preset.candidate],
    ["DIFF", preset.diff],
  ];
  const offsetSeconds = offsetMs / 1000;
  startedAtContextTime = context.currentTime + 0.05;
  startedAtOffsetMs = offsetMs;
  for (const [trackMode, level] of routing) {
    const loaded = tracks.get(trackMode);
    if (!loaded) continue;
    const source = context.createBufferSource();
    source.buffer = loaded.buffer;
    const gain = context.createGain();
    gain.gain.value = level;
    source.connect(gain);
    gain.connect(context.destination);
    source.start(startedAtContextTime, Math.min(offsetSeconds, loaded.buffer.duration - 0.02));
    source.onended = () => {
      // 自然结束（非手动停止）
      if (sources.includes(source)) {
        playing.value = false;
        currentMs.value = durationMs.value;
      }
    };
    sources.push(source);
  }
  playing.value = true;
  tick();
}

function tick(): void {
  if (!audioContext) return;
  const elapsedMs = (audioContext.currentTime - startedAtContextTime) * 1000 + startedAtOffsetMs;
  currentMs.value = Math.min(durationMs.value, Math.max(0, elapsedMs));
  for (const item of order) {
    const canvas = canvasRefs[item.key].value;
    if (canvas) {
      const context = canvas.getContext("2d");
      if (context) {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const ratio = window.devicePixelRatio || 1;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, width * ratio, height * ratio);
        const loaded = tracks.get(item.mode);
        const color = item.key === "baseline" ? "#145c55" : item.key === "candidate" ? "#3778b7" : "#a53b32";
        if (loaded) drawWave(canvas, loaded.peaks, color);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.strokeStyle = "#132823";
        context.lineWidth = 1.5;
        const x = (currentMs.value / Math.max(1, durationMs.value)) * width;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
    }
  }
  if (playing.value && currentMs.value < durationMs.value) {
    rafHandle = requestAnimationFrame(tick);
  } else {
    drawPlayheads();
  }
}

function pause(): void {
  if (!audioContext) return;
  const position = (audioContext.currentTime - startedAtContextTime) * 1000 + startedAtOffsetMs;
  currentMs.value = Math.min(durationMs.value, Math.max(0, position));
  stopSources();
  playing.value = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  drawPlayheads();
}

function playPause(): void {
  if (tracks.size === 0) return;
  if (audioContext?.state === "suspended") void audioContext.resume();
  if (playing.value) pause();
  else startPlayback(currentMs.value >= durationMs.value ? 0 : currentMs.value);
}

function seek(event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  currentMs.value = ratio * durationMs.value;
  if (playing.value) startPlayback(currentMs.value);
  else drawPlayheads();
}

watch(mode, () => {
  if (playing.value) startPlayback(currentMs.value);
});

watch(
  () => [props.baselineUrl, props.candidateUrl, props.diffUrl],
  () => void load(),
  { immediate: true },
);

onBeforeUnmount(() => {
  stopSources();
  if (rafHandle) cancelAnimationFrame(rafHandle);
  if (audioContext) void audioContext.close();
});
</script>

<template>
  <section class="sync-player card">
    <div class="card-title">
      <h3>同步对比试听</h3>
      <div class="mode-switch" role="group" aria-label="试听模式">
        <button
          v-for="item in modes"
          :key="item.value"
          type="button"
          class="button small"
          :class="{ active: mode === item.value }"
          @click="mode = item.value"
        >
          {{ item.label }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="inline-error">{{ loadError }}</div>
    <div v-if="loading" class="muted">正在加载对齐后的音频…</div>

    <div v-for="item in order" :key="item.mode" class="lane">
      <div class="lane-head">
        <span class="lane-label" :class="item.key">{{ item.label }}</span>
      </div>
      <canvas
        :ref="(el) => { canvasRefs[item.key].value = el as HTMLCanvasElement | null; }"
        class="lane-canvas"
        :class="item.key"
        @click="seek"
      />
    </div>

    <div class="transport">
      <button type="button" class="button" :disabled="tracks.size === 0" @click="playPause">
        {{ playing ? "⏸ 暂停" : "▶ 播放" }}
      </button>
      <span class="time-display">{{ formatTimeMs(currentMs) }} / {{ formatTimeMs(durationMs) }}</span>
      <small class="muted">三条音轨共享同一时间轴；“听差异”仅保留两版本相减后的成分，便于定位不一致的片段。</small>
    </div>
  </section>
</template>

<style scoped>
.sync-player { display: grid; gap: 12px; }
.mode-switch { display: flex; gap: 6px; flex-wrap: wrap; }
.mode-switch .active { background: var(--primary); color: #fff; border-color: var(--primary); }
.lane { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 12px; }
.lane-head { min-width: 0; }
.lane-label { font-size: .82rem; font-weight: 700; padding: 3px 8px; border-radius: 999px; color: #fff; }
.lane-label.baseline { background: var(--primary); }
.lane-label.candidate { background: var(--fingering); }
.lane-label.diff { background: var(--danger); }
.lane-canvas { width: 100%; height: 64px; border: 1px solid var(--line); border-radius: 8px; background: #fbfcfb; cursor: pointer; }
.transport { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding-top: 4px; }
.time-display { font-variant-numeric: tabular-nums; font-weight: 700; }
@media (max-width: 760px) {
  .lane { grid-template-columns: 1fr; gap: 4px; }
}
</style>
