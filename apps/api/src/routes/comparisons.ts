import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import {
  comparisonCreateSchema,
  comparisonListQuerySchema,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { parseOrThrow } from "../lib/validation.js";
import { enqueueComparison, enqueueComparisonCancel } from "../lib/queue.js";
import { createPlaybackUrl, deleteObject } from "../lib/s3.js";
import { getConfig } from "../config/env.js";
import { audit } from "../lib/audit.js";

const comparisonSelect = {
  id: true,
  groupId: true,
  revision: true,
  title: true,
  status: true,
  stage: true,
  progressPct: true,
  targetLufs: true,
  truePeakDbTp: true,
  windowMs: true,
  hopMs: true,
  maxOffsetMs: true,
  summary: true,
  failureCode: true,
  failureMessage: true,
  attempts: true,
  cancelRequested: true,
  cancelledAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  tracks: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      role: true,
      label: true,
      mediaId: true,
      measuredLufs: true,
      gainDb: true,
      peakDb: true,
      offsetMs: true,
      correlation: true,
      normalizedReady: true,
      media: { select: { id: true, originalName: true, durationMs: true, status: true } },
    },
  },
} satisfies Prisma.AudioComparisonSelect;

const comparisonRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // 创建对比（同 groupId 下 revision 单调递增；历史 revision 永不可覆盖）
  app.post("/comparisons", async (request, reply) => {
    const input = parseOrThrow(comparisonCreateSchema, request.body);
    const userId = request.authUser!.id;

    const mediaIds = input.tracks.map((track) => track.mediaId);
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new AppError(400, "DUPLICATE_TRACK", "基线与候选必须是两个不同的音频");
    }
    if (input.hopMs > input.windowMs) {
      throw new AppError(400, "WINDOW_CONFIG_INVALID", "窗口步长不能大于窗口长度");
    }
    const media = await prisma.mediaAsset.findMany({
      where: { id: { in: mediaIds }, userId },
      select: {
        id: true,
        originalName: true,
        status: true,
        sessionId: true,
        durationMs: true,
        sizeBytes: true,
      },
    });
    if (media.length !== mediaIds.length) throw new AppError(400, "MEDIA_NOT_FOUND", "选择的音频不存在或无权访问");
    const notReady = media.filter((item) => item.status !== "READY");
    if (notReady.length > 0) {
      throw new AppError(409, "MEDIA_NOT_READY", `《${notReady[0]!.originalName}》尚未解析完成，请稍后再试`);
    }
    const durations = media.map((item) => item.durationMs).filter((value): value is bigint => value != null);
    if (durations.length === 2) {
      const ratio = Number(durations[0]!) / Number(durations[1]!);
      if (ratio > 3 || ratio < 1 / 3) {
        throw new AppError(400, "LENGTH_TOO_DIFFERENT", "两段音频时长相差过大（超过 3 倍），无法同段对齐");
      }
    }

    const groupId = input.groupId ?? randomUUID();
    const comparisonId = randomUUID();
    let created: Prisma.AudioComparisonGetPayload<{ select: typeof comparisonSelect }> | null = null;

    // 并发创建时靠 (group_id, revision) 唯一约束串行化；冲突则读取最大 revision 后重试
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      const latest = await prisma.audioComparison.findFirst({
        where: { groupId, userId },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      const revision = (latest?.revision ?? 0) + 1;
      try {
        created = await prisma.audioComparison.create({
          data: {
            id: comparisonId,
            groupId,
            revision,
            userId,
            title: input.title,
            targetLufs: input.targetLufs,
            truePeakDbTp: input.truePeakDbTp,
            windowMs: input.windowMs,
            hopMs: input.hopMs,
            maxOffsetMs: input.maxOffsetMs,
            tracks: {
              create: input.tracks.map((track, index) => ({
                mediaId: track.mediaId,
                position: index,
                role: index === 0 ? "BASELINE" : "CANDIDATE",
                label: track.label?.trim() || (index === 0 ? "基线版本" : "候选版本"),
              })),
            },
          },
          select: comparisonSelect,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && attempt < 2) continue;
        throw error;
      }
    }
    if (!created) throw new AppError(409, "REVISION_CONFLICT", "同组版本创建冲突，请重试");

    try {
      await enqueueComparison(comparisonId);
    } catch {
      throw new AppError(503, "PROCESSING_UNAVAILABLE", "对比任务暂未入队，请稍后重试");
    }
    await audit(request, "COMPARISON_CREATED", "AUDIO_COMPARISON", comparisonId, "SUCCESS", {
      groupId,
      revision: created.revision,
    });
    return reply.status(201).send({ comparison: created, groupId });
  });

  app.get("/comparisons", async (request) => {
    const query = parseOrThrow(comparisonListQuerySchema, request.query);
    const userId = request.authUser!.id;
    const where: Prisma.AudioComparisonWhereInput = { userId };
    if (query.groupId) where.groupId = query.groupId;
    if (query.status) where.status = query.status;
    if (query.cursor) where.id = { lt: query.cursor };

    const items = await prisma.audioComparison.findMany({
      where,
      orderBy: [{ groupId: "asc" }, { revision: "desc" }, { createdAt: "desc" }],
      take: query.limit + 1,
      select: comparisonSelect,
    });
    const hasMore = items.length > query.limit;
    const page = hasMore ? items.slice(0, query.limit) : items;
    return {
      comparisons: page,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  });

  // 同段对齐的全部历史版本（只读，revision 升序）
  app.get("/comparisons/groups/:groupId/revisions", async (request) => {
    const { groupId } = request.params as { groupId: string };
    const revisions = await prisma.audioComparison.findMany({
      where: { groupId, userId: request.authUser!.id },
      orderBy: { revision: "asc" },
      select: comparisonSelect,
    });
    if (revisions.length === 0) throw notFound();
    return { groupId, revisions };
  });

  app.get("/comparisons/:id", async (request) => {
    const { id } = request.params as { id: string };
    const comparison = await prisma.audioComparison.findFirst({
      where: { id, userId: request.authUser!.id },
      select: comparisonSelect,
    });
    if (!comparison) throw notFound();
    return { comparison };
  });

  // 失败续跑：重新入队同一作业（固定 jobId，已完成/已取消/进行中拒绝）
  app.post("/comparisons/:id/resume", async (request) => {
    const { id } = request.params as { id: string };
    const comparison = await prisma.audioComparison.findFirst({
      where: { id, userId: request.authUser!.id },
      select: { id: true, status: true, revision: true, groupId: true },
    });
    if (!comparison) throw notFound();
    if (comparison.status !== "FAILED") {
      throw new AppError(409, "INVALID_COMPARISON_STATE", "只有失败的对比可以续跑；历史版本不可覆盖");
    }
    await prisma.audioComparison.update({
      where: { id },
      data: {
        status: "PENDING",
        stage: "QUEUED",
        progressPct: 0,
        failureCode: null,
        failureMessage: null,
        cancelRequested: false,
      },
    });
    await enqueueComparison(id);
    await audit(request, "COMPARISON_RESUMED", "AUDIO_COMPARISON", id, "SUCCESS", {
      groupId: comparison.groupId,
      revision: comparison.revision,
    });
    return { success: true, status: "PENDING" };
  });

  // 协作取消：处理循环在阶段边界退出并清理对象/临时目录
  app.post("/comparisons/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    const comparison = await prisma.audioComparison.findFirst({
      where: { id, userId: request.authUser!.id },
      select: { id: true, status: true },
    });
    if (!comparison) throw notFound();
    if (["READY", "CANCELLED"].includes(comparison.status)) {
      throw new AppError(409, "INVALID_COMPARISON_STATE", "当前状态不能取消");
    }
    // 原子置位：仅非终态行受影响，消除“检查状态后 worker 恰好完成”的竞态
    const marked = await prisma.audioComparison.updateMany({
      where: { id, status: { in: ["PENDING", "PROCESSING", "FAILED"] }, cancelRequested: false },
      data: { cancelRequested: true },
    });
    if (marked.count === 0) throw new AppError(409, "INVALID_COMPARISON_STATE", "当前状态不能取消");
    await enqueueComparisonCancel(id);
    await audit(request, "COMPARISON_CANCEL_REQUESTED", "AUDIO_COMPARISON", id, "SUCCESS");
    return { success: true, cancelRequested: true };
  });

  app.delete("/comparisons/:id", async (request) => {
    const { id } = request.params as { id: string };
    const comparison = await prisma.audioComparison.findFirst({
      where: { id, userId: request.authUser!.id },
      select: {
        id: true,
        status: true,
        cancelRequested: true,
        reportObjectKey: true,
        diffObjectKey: true,
        tracks: { select: { normalizedObjectKey: true } },
      },
    });
    if (!comparison) throw notFound();

    if (["PENDING", "PROCESSING"].includes(comparison.status) && !comparison.cancelRequested) {
      const marked = await prisma.audioComparison.updateMany({
        where: { id, status: { in: ["PENDING", "PROCESSING"] }, cancelRequested: false },
        data: { cancelRequested: true },
      });
      if (marked.count > 0) await enqueueComparisonCancel(id).catch(() => undefined);
    } else if (!["PENDING", "PROCESSING"].includes(comparison.status)) {
      // 终态记录：直接删除派生对象（源音频不属于本对比，绝不动）
      const keys = new Set<string>();
      if (comparison.reportObjectKey) keys.add(comparison.reportObjectKey);
      if (comparison.diffObjectKey) keys.add(comparison.diffObjectKey);
      for (const track of comparison.tracks) {
        if (track.normalizedObjectKey) keys.add(track.normalizedObjectKey);
      }
      await Promise.all([...keys].map((key) => deleteObject(key).catch(() => undefined)));
    }
    await prisma.audioComparison.delete({ where: { id } });
    await audit(request, "COMPARISON_DELETED", "AUDIO_COMPARISON", id, "SUCCESS");
    return { success: true };
  });

  // 产物播放地址（aligned-0 / aligned-1 / diff），仅允许访问自己对比的派生对象
  app.get("/comparisons/:id/artifacts/:kind(aligned-0|aligned-1|diff)/playback-url", async (request) => {
    const { id, kind } = request.params as { id: string; kind: string };
    const comparison = await prisma.audioComparison.findFirst({
      where: { id, userId: request.authUser!.id },
      select: {
        status: true,
        diffObjectKey: true,
        tracks: { orderBy: { position: "asc" }, select: { normalizedObjectKey: true } },
      },
    });
    if (!comparison) throw notFound();
    if (comparison.status !== "READY") throw new AppError(409, "COMPARISON_NOT_READY", "对比尚未完成");
    const objectKey =
      kind === "diff" ? comparison.diffObjectKey : comparison.tracks[kind === "aligned-0" ? 0 : 1]?.normalizedObjectKey;
    if (!objectKey) throw notFound();
    const url = await createPlaybackUrl(objectKey, `${kind}.wav`, "audio/wav");
    return { url, expiresIn: getConfig().PLAYBACK_URL_TTL_SECONDS };
  });
};

export default comparisonRoutes;
