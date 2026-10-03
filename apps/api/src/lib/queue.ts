import { Queue } from "bullmq";
import { getConfig } from "../config/env.js";
import { getRedis } from "./redis.js";

let queue: Queue | undefined;

export function getMediaQueue(): Queue {
  if (!queue) {
    queue = new Queue("media-processing", { connection: getRedis().duplicate() });
  }
  return queue;
}

export async function enqueueProbe(mediaId: string): Promise<void> {
  await getMediaQueue().add(
    "probe-media",
    { mediaId },
    {
      jobId: `probe:${mediaId}:${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueCleanup(sessionId: string): Promise<void> {
  await getMediaQueue().add(
    "cleanup-session",
    { sessionId },
    {
      jobId: `cleanup:${sessionId}:${Date.now()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueExport(exportId: string): Promise<void> {
  await getMediaQueue().add(
    "export-data",
    { exportId },
    {
      jobId: `export:${exportId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueComparison(comparisonId: string): Promise<void> {
  const queue = getMediaQueue();
  // 续跑时旧作业可能仍以 failed 状态保留（相同 jobId），先清理再入队
  const existing = await queue.getJob(`compare:${comparisonId}`);
  if (existing) await existing.remove().catch(() => undefined);
  await queue.add(
    "compare-audio",
    { comparisonId },
    {
      // 固定 jobId：失败重试/BullMQ 重试共用同一作业，绝不产生重复跑
      jobId: `compare:${comparisonId}`,
      attempts: 4,
      backoff: { type: "exponential", delay: 4000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  );
}

export async function enqueueComparisonCancel(comparisonId: string): Promise<"CANCEL_REQUESTED" | "ALREADY_TERMINAL"> {
  const queue = getMediaQueue();
  // 丢弃等待中的对比作业；正在执行的作业靠协作取消自行退出
  const job = await queue.getJob(`compare:${comparisonId}`);
  if (job) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") await job.remove();
  }
  await queue.add(
    "cancel-comparison",
    { comparisonId },
    {
      jobId: `compare-cancel:${comparisonId}:${Date.now()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  );
  return "CANCEL_REQUESTED";
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
