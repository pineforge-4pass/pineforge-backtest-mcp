/**
 * Shared TypeScript half of check_tradingview_parity. This directory is copied
 * byte for byte into the hosted MCP: no imports outside it, no node: modules,
 * no zod (it runs in Node 20+ and in a Cloudflare Worker).
 */

export { ParityInputError } from "./errors.js";
export { declaresMagnifier, magnifierNotRun, magnifierEndMs, magnifierWindow } from "./magnifier.js";
export { parseCsv, toCsv, csvCell } from "./csv.js";
export {
  readTradingViewExport,
  settingsFromProperties,
  excelSerialToWall,
  parseWallText,
  DEFAULT_EXPORT_LIMITS,
  type InflateFn,
  type ExportLimits,
  type ExportSettings,
  type PropertyRow,
  type TradingViewExport,
} from "./export.js";
export {
  parseTicker,
  normalizeTimeframe,
  timeframeMs,
  canonicalTimezone,
  tzOffsetMs,
  wallToUtcMs,
  formatWall,
  parseWall,
  parseIsoUtc,
  exportSpan,
  type Ticker,
  type ExportSpan,
} from "./market.js";
export {
  formatParityResult,
  METHODOLOGY_URL,
  RETENTION_LOCAL,
  RETENTION_HOSTED,
  type FormatOptions,
} from "./format.js";
export { resolveSettings, type ParityArgs, type ResolvedSettings, type Scalar } from "./settings.js";
