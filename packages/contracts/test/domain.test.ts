import { describe, expect, it } from "vitest";
import {
  calculateSessionDuration,
  canTransitionSession,
  describeMissingReview,
  isGoalProgressValid,
  validateAnnotationRange,
} from "../src/index.js";

describe("session state machine", () => {
  it("allows the required completion transition", () => {
    expect(canTransitionSession("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransitionSession("DRAFT", "COMPLETED")).toBe(false);
  });
});

describe("annotation range", () => {
  it("rejects ranges under 100ms and outside media", () => {
    expect(validateAnnotationRange(100, 150, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(900, 1100, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(100, 250, 1000)).toEqual({ ok: true });
  });
});

describe("review completion", () => {
  it("returns every missing item instead of a generic failure", () => {
    expect(
      describeMissingReview({
        readyMediaCount: 0,
        annotationCount: 0,
        noIssues: false,
        nextFocus: "",
        openGoalCount: 0,
        newGoalCount: 0,
        progressUpdateCount: 0,
      }),
    ).toHaveLength(4);
  });
});

describe("goal values", () => {
  it("suggests achieved only when actual reaches target", () => {
    expect(isGoalProgressValid(90, 88)).toBe(true);
    expect(isGoalProgressValid(87, 88)).toBe(false);
  });

  it("sums only valid media durations", () => {
    expect(calculateSessionDuration([1000, null, 2500, -1])).toBe(3500);
  });
});

import { buildComparisonDigest, comparisonCreateSchema } from "../src/index.js";

describe("comparison digest", () => {
  it("describes alignment direction and loudness balance", () => {
    const lines = buildComparisonDigest({
      similarityScore: 88,
      overallCorrelation: 0.92,
      meanRmsDeltaDb: 1.8,
      maxRmsDeltaDb: 4.2,
      coveragePct: 82,
      alignment: { offsetMs: 320, correlation: 0.92 },
    });
    expect(lines.join(" ")).toContain("晚 320 ms");
    expect(lines.join(" ")).toContain("1.80 dB");
    expect(lines.join(" ")).toContain("82%");
  });

  it("warns on low coverage", () => {
    const lines = buildComparisonDigest({
      similarityScore: 40,
      overallCorrelation: 0.2,
      meanRmsDeltaDb: null,
      maxRmsDeltaDb: null,
      coveragePct: 35,
    });
    expect(lines.join(" ")).toContain("覆盖率偏低");
  });
});

describe("comparison create schema", () => {
  it("requires exactly two distinct tracks and clamps parameter ranges", () => {
    const ok = comparisonCreateSchema.safeParse({
      title: "周一对周三",
      tracks: [
        { mediaId: "11111111-1111-1111-1111-111111111111" },
        { mediaId: "22222222-2222-2222-2222-222222222222" },
      ],
    });
    expect(ok.success).toBe(true);

    const tooFew = comparisonCreateSchema.safeParse({
      title: "x",
      tracks: [{ mediaId: "11111111-1111-1111-1111-111111111111" }],
    });
    expect(tooFew.success).toBe(false);

    const loudTarget = comparisonCreateSchema.safeParse({
      title: "x",
      targetLufs: 10,
      tracks: [
        { mediaId: "11111111-1111-1111-1111-111111111111" },
        { mediaId: "22222222-2222-2222-2222-222222222222" },
      ],
    });
    expect(loudTarget.success).toBe(false);
  });
});
