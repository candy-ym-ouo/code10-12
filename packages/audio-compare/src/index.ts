/** @practice/audio-compare 公共出口：多版本音频对比（对齐 / 响度归一 / 差异摘要）。 */

export { alignSignals, extractOverlap, type AlignmentResult, type AlignOptions } from "./dsp/align.js";
export { computeDiff, type DiffMetrics, type DiffOptions, type SegmentDivergence } from "./dsp/diff.js";
export {
  integratedLufs,
  integratedLufsFromSquares,
  kWeightedSquares,
  peakDbfs,
  windowedLufsFromSquares,
  applyGainDb,
} from "./dsp/loudness.js";
export { decodeWav, encodeWav16, downmixToMono, resampleLinear, type WavData } from "./dsp/wav.js";
export {
  runCompare,
  CancelError,
  CancelToken,
  CompareError,
  type CompareOptions,
  type CompareErrorCode,
  type RunHooks,
  type RunSummary,
} from "./pipeline/runner.js";
export {
  STAGES,
  readState,
  type RunState,
  type RunStatus,
  type StageName,
  type StageRecord,
} from "./pipeline/state.js";
