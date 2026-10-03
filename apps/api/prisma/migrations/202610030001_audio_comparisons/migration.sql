-- CreateEnum
CREATE TYPE "ComparisonStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ComparisonTrackRole" AS ENUM ('BASELINE', 'CANDIDATE');

-- CreateTable
CREATE TABLE "audio_comparisons" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "status" "ComparisonStatus" NOT NULL DEFAULT 'PENDING',
    "stage" VARCHAR(40) NOT NULL DEFAULT 'QUEUED',
    "progress_pct" INTEGER NOT NULL DEFAULT 0,
    "target_lufs" DOUBLE PRECISION NOT NULL DEFAULT -23,
    "true_peak_dbtp" DOUBLE PRECISION NOT NULL DEFAULT -1,
    "window_ms" INTEGER NOT NULL DEFAULT 2000,
    "hop_ms" INTEGER NOT NULL DEFAULT 500,
    "max_offset_ms" INTEGER NOT NULL DEFAULT 1500,
    "summary" JSONB,
    "report_object_key" TEXT,
    "diff_object_key" TEXT,
    "failure_code" VARCHAR(64),
    "failure_message" VARCHAR(500),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audio_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_tracks" (
    "id" UUID NOT NULL,
    "comparison_id" UUID NOT NULL,
    "media_id" UUID,
    "position" INTEGER NOT NULL,
    "role" "ComparisonTrackRole" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "measured_lufs" DOUBLE PRECISION,
    "gain_db" DOUBLE PRECISION,
    "peak_db" DOUBLE PRECISION,
    "offset_ms" INTEGER,
    "correlation" DOUBLE PRECISION,
    "normalized_object_key" TEXT,
    "normalized_ready" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "comparison_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audio_comparisons_group_id_revision_key" ON "audio_comparisons"("group_id", "revision");
CREATE UNIQUE INDEX "audio_comparisons_report_object_key_key" ON "audio_comparisons"("report_object_key");
CREATE INDEX "audio_comparisons_user_id_created_at_idx" ON "audio_comparisons"("user_id", "created_at" DESC);
CREATE INDEX "audio_comparisons_user_id_status_idx" ON "audio_comparisons"("user_id", "status");
CREATE INDEX "audio_comparisons_group_id_idx" ON "audio_comparisons"("group_id");
CREATE INDEX "audio_comparisons_status_cancel_requested_idx" ON "audio_comparisons"("status", "cancel_requested");

-- CreateIndex
CREATE UNIQUE INDEX "comparison_tracks_comparison_id_position_key" ON "comparison_tracks"("comparison_id", "position");
CREATE UNIQUE INDEX "comparison_tracks_normalized_object_key_key" ON "comparison_tracks"("normalized_object_key");
CREATE INDEX "comparison_tracks_media_id_idx" ON "comparison_tracks"("media_id");

-- AddForeignKey
ALTER TABLE "audio_comparisons" ADD CONSTRAINT "audio_comparisons_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comparison_tracks" ADD CONSTRAINT "comparison_tracks_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "audio_comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comparison_tracks" ADD CONSTRAINT "comparison_tracks_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
