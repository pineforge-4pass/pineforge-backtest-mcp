/**
 * The settings of one parity check: the tool's explicit inputs merged with
 * what an XLSX export's Properties sheet states. An explicit input and the
 * export may both state a setting only when they agree.
 */

import { ParityInputError } from "./errors.js";
import type { ExportSettings } from "./export.js";
import { canonicalTimezone, normalizeTimeframe, parseIsoUtc, parseTicker, parseWall } from "./market.js";

export type Scalar = number | string | boolean;

export interface ParityArgs {
  symbol?: string;
  timeframe?: string;
  range_start?: string;
  range_end?: string;
  chart_timezone?: string;
  strategy_overrides?: Record<string, Scalar>;
  runtime?: Record<string, Scalar>;
}

export interface ResolvedSettings {
  /** Canonical ticker, or null when none was given and none is needed. */
  symbol: string | null;
  timeframe: string;
  chartTimezone: string;
  rangeStartMs: number;
  /** null: the export's last row is the range end. */
  rangeEndMs: number | null;
  strategyOverrides: Record<string, Scalar>;
  runtime: Record<string, Scalar>;
  /** Settings taken from the export, for the result text. */
  fromExport: string[];
}

function conflict(name: string, mine: unknown, theirs: unknown): ParityInputError {
  return new ParityInputError(
    "conflicting_setting",
    `${name}: you passed ${JSON.stringify(mine)}, the export's Properties say ${JSON.stringify(theirs)}. ` +
      "Pass the value TradingView ran with, or leave it out.",
  );
}

export function resolveSettings(
  args: ParityArgs,
  exp: ExportSettings,
  opts: { symbolRequired: boolean },
): ResolvedSettings {
  const fromExport: string[] = [];
  const missing: string[] = [];

  let symbol: string | null = null;
  const mySymbol = args.symbol ? parseTicker(args.symbol).ticker : undefined;
  const expSymbol = exp.symbol ? exp.symbol.trim().toUpperCase() : undefined;
  if (mySymbol && expSymbol && mySymbol !== expSymbol) throw conflict("symbol", mySymbol, expSymbol);
  if (mySymbol) symbol = mySymbol;
  else if (expSymbol) {
    symbol = parseTicker(expSymbol).ticker;
    fromExport.push("symbol");
  } else if (opts.symbolRequired) missing.push("symbol (TradingView ticker, e.g. BINANCE:ETHUSDT.P)");

  let timeframe = "";
  const myTf = args.timeframe ? normalizeTimeframe(args.timeframe) : undefined;
  if (myTf && exp.timeframe && myTf !== exp.timeframe) throw conflict("timeframe", myTf, exp.timeframe);
  if (myTf) timeframe = myTf;
  else if (exp.timeframe) {
    timeframe = exp.timeframe;
    fromExport.push("timeframe");
  } else missing.push("timeframe (TradingView resolution, e.g. 15, 60, 1D)");

  let chartTimezone = "";
  const myTz = args.chart_timezone ? canonicalTimezone(args.chart_timezone) : undefined;
  let expTz: string | undefined;
  if (exp.chart_timezone) {
    try { expTz = canonicalTimezone(exp.chart_timezone); } catch { expTz = undefined; }
  }
  if (myTz && expTz && myTz !== expTz) throw conflict("chart_timezone", myTz, expTz);
  if (myTz) chartTimezone = myTz;
  else if (expTz) {
    chartTimezone = expTz;
    fromExport.push("chart_timezone");
  } else missing.push("chart_timezone (the IANA timezone TradingView printed the trade times in, e.g. Asia/Taipei)");

  // The export's range times are wall clock in the chart timezone.
  const wallMs = (w: string | undefined) => (w && chartTimezone ? parseWall(w, chartTimezone) : null);

  let rangeStartMs = NaN;
  const myStart = args.range_start ? parseIsoUtc(args.range_start, "range_start") : undefined;
  const expStart = wallMs(exp.range_start_wall);
  if (myStart !== undefined && expStart !== null && myStart !== expStart) {
    throw conflict("range_start", new Date(myStart).toISOString(), `${exp.range_start_wall} (${chartTimezone})`);
  }
  if (myStart !== undefined) rangeStartMs = myStart;
  else if (expStart !== null) {
    rangeStartMs = expStart;
    fromExport.push("range_start");
  } else missing.push("range_start (ISO date or datetime of the first bar of the backtest, UTC unless it has an offset)");

  let rangeEndMs: number | null = null;
  const myEnd = args.range_end ? parseIsoUtc(args.range_end, "range_end") : undefined;
  const expEnd = wallMs(exp.range_end_wall);
  if (myEnd !== undefined && expEnd !== null && myEnd !== expEnd) {
    throw conflict("range_end", new Date(myEnd).toISOString(), `${exp.range_end_wall} (${chartTimezone})`);
  }
  if (myEnd !== undefined) rangeEndMs = myEnd;
  else if (expEnd !== null) {
    rangeEndMs = expEnd;
    fromExport.push("range_end");
  }

  if (missing.length) {
    throw new ParityInputError(
      "missing_setting",
      `Pass ${missing.join("; ")}. ` +
        (Object.keys(exp).length ? "The export's Properties sheet does not state it." : "A CSV trade list does not state it."),
    );
  }
  if (rangeEndMs !== null && rangeEndMs <= rangeStartMs) {
    throw new ParityInputError("bad_range", "range_end must be after range_start.");
  }

  const strategyOverrides: Record<string, Scalar> = { ...(args.strategy_overrides ?? {}) };
  for (const [k, v] of Object.entries(exp.strategy_overrides ?? {})) {
    if (k in strategyOverrides) {
      if (strategyOverrides[k] !== v) throw conflict(`strategy_overrides.${k}`, strategyOverrides[k], v);
    } else {
      strategyOverrides[k] = v;
      fromExport.push(`strategy_overrides.${k}`);
    }
  }
  const runtime: Record<string, Scalar> = { ...(args.runtime ?? {}) };
  for (const [k, v] of Object.entries(exp.runtime ?? {})) {
    if (v === undefined) continue;
    if (k in runtime) {
      if (runtime[k] !== v) throw conflict(`runtime.${k}`, runtime[k], v);
    } else {
      runtime[k] = v;
      fromExport.push(`runtime.${k}`);
    }
  }
  return { symbol, timeframe, chartTimezone, rangeStartMs, rangeEndMs, strategyOverrides, runtime, fromExport };
}
