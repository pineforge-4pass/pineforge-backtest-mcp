/**
 * check_tradingview_parity for the local MCP: read the user's TradingView
 * export, settle the settings, find bars (the user's own, or Binance's public
 * API), run the grading core through the runner, and shape the answer.
 */

import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { EngineRunner, ParamMap, RuntimeArgsLike } from "./engine.js";
import {
  ParityInputError,
  declaresMagnifier,
  exportSpan,
  magnifierWindow,
  formatParityResult,
  formatWall,
  parseTicker,
  readTradingViewExport,
  resolveSettings,
  timeframeMs,
  RETENTION_LOCAL,
  type InflateFn,
  type Scalar,
} from "./parity/index.js";

export interface ParityToolArgs {
  pine: string;
  tradingview_trades: string;
  symbol?: string;
  timeframe?: string;
  range_start?: string;
  range_end?: string;
  chart_timezone?: string;
  inputs?: ParamMap;
  strategy_overrides?: Record<string, Scalar>;
  runtime?: RuntimeArgsLike;
  max_mismatches?: number;
  ohlcv_csv?: string;
  ohlcv_csv_path?: string;
  magnifier_ohlcv_csv?: string;
  magnifier_ohlcv_csv_path?: string;
}

export interface ParityDeps {
  /** backtest_pine's path rule (cwd-scoped unless PINEFORGE_ALLOW_ANYWHERE=1). */
  resolvePath(p: string, label: string): string;
  /** Binance klines as engine CSV text, [startMs, endMs], at most `limit` bars. */
  fetchBinanceCsv(market: "spot" | "usdt_perp", symbol: string, interval: string,
    startMs: number, endMs: number, limit: number): Promise<{ csv: string; bars: number }>;
}

const MAX_PINE_BYTES = 256 * 1024;
const MAX_INLINE_BARS_CHARS = 64 * 1024 * 1024;
const MAX_FETCH_BARS = 100_000;
const ENGINE_HEADER = "timestamp,open,high,low,close,volume";

const nodeInflate: InflateFn = (data, max) => new Uint8Array(inflateRawSync(data, { maxOutputLength: max }));

// TradingView resolution -> Binance kline interval.
const BINANCE_INTERVAL: Record<string, string> = {
  "1S": "1s", "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
  "60": "1h", "120": "2h", "240": "4h", "360": "6h", "480": "8h", "720": "12h",
  "1D": "1d", "3D": "3d", "1W": "1w", "1M": "1M",
};

function noBars(why: string): ParityInputError {
  return new ParityInputError(
    "no_bars",
    `${why} Pass your own bars: ohlcv_csv (CSV text) or ohlcv_csv_path, with the header ` +
      `${ENGINE_HEADER} (timestamp in epoch ms) or TradingView's chart export time,open,high,low,close,Volume ` +
      "(time in epoch seconds or ISO 8601).",
  );
}

/** Engine CSV text from TradingView's "Export chart data" CSV. */
function fromTradingViewChart(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const [it, io, ih, il, ic, iv] = [col("time"), col("open"), col("high"), col("low"), col("close"), col("volume")];
  const out = [ENGINE_HEADER];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i]!.split(",");
    const t = (f[it] ?? "").trim();
    const ms = /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t) * 1000) : Date.parse(t);
    if (!Number.isFinite(ms)) throw noBars(`Bars row ${i + 1}: the time is neither epoch seconds nor ISO 8601.`);
    const nums = [io, ih, il, ic].map((j) => (f[j] ?? "").trim());
    if (nums.some((v) => !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v))) {
      throw noBars(`Bars row ${i + 1} has a missing or non-numeric price.`);
    }
    const vol = iv >= 0 && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test((f[iv] ?? "").trim()) ? f[iv]!.trim() : "0";
    out.push([ms, ...nums, vol].join(","));
  }
  if (out.length < 2) throw noBars("The bars file has no rows.");
  return out.join("\n") + "\n";
}

type BarsFormat = "engine" | "tradingview";

function barsFormat(firstLine: string): BarsFormat {
  const cols = firstLine.replace(/^﻿/, "").toLowerCase().split(",").map((s) => s.trim());
  if (ENGINE_HEADER.split(",").every((c, i) => cols[i] === c)) return "engine";
  if (["time", "open", "high", "low", "close"].every((c, i) => cols[i] === c)) return "tradingview";
  // The line itself is not echoed: the path may name any readable file.
  throw noBars("The bars file's first line is neither header.");
}

async function firstLine(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)[0] ?? "";
  } finally {
    await fh.close();
  }
}

interface Bars {
  path: string;
  source: string;
  /** Present only for fetched chart bars inside the harness's run bounds. */
  fetched?: { bars: number; firstOpenMs: number; lastOpenMs: number };
}

async function suppliedBars(
  csvText: string | undefined,
  csvPath: string | undefined,
  kind: "ohlcv" | "magnifier_ohlcv",
  work: string,
  deps: ParityDeps,
): Promise<Bars | undefined> {
  if (csvText !== undefined && csvPath !== undefined) {
    throw new ParityInputError("bad_request", `Pass ${kind}_csv or ${kind}_csv_path, not both.`);
  }
  if (csvText !== undefined) {
    if (csvText.length > MAX_INLINE_BARS_CHARS) {
      throw noBars(`${kind}_csv is larger than ${MAX_INLINE_BARS_CHARS} characters; pass ${kind}_csv_path instead.`);
    }
    const text = csvText.replace(/^\uFEFF/, "");
    const csv = barsFormat(text.split(/\r?\n/)[0] ?? "") === "engine" ? text : fromTradingViewChart(text);
    const path = join(work, `${kind}.csv`);
    await writeFile(path, csv, "utf8");
    return { path, source: `the ${kind}_csv you passed` };
  }
  if (csvPath !== undefined) {
    let abs: string;
    try {
      abs = deps.resolvePath(csvPath, kind === "ohlcv" ? "OHLCV" : "Magnifier OHLCV");
    } catch (e) {
      throw new ParityInputError("no_bars", (e as Error).message);
    }
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new ParityInputError("no_bars", `OHLCV file not found: ${abs}`);
    const head = await firstLine(abs);
    const path = join(work, `${kind}.csv`);
    if (barsFormat(head) === "engine") {
      if (!head.startsWith("\uFEFF")) return { path: abs, source: `your file ${abs}` };
      // The grading core reads the header without a byte-order mark.
      await writeFile(path, (await readFile(abs, "utf8")).replace(/^\uFEFF/, ""), "utf8");
      return { path, source: `your file ${abs}` };
    }
    await writeFile(path, fromTradingViewChart(await readFile(abs, "utf8")), "utf8");
    return { path, source: `your file ${abs} (TradingView chart export, converted)` };
  }
  return undefined;
}

async function findBars(
  args: ParityToolArgs,
  symbol: string | null,
  timeframe: string,
  startMs: number,
  endMs: number,
  work: string,
  deps: ParityDeps,
): Promise<Bars> {
  const supplied = await suppliedBars(args.ohlcv_csv, args.ohlcv_csv_path, "ohlcv", work, deps);
  if (supplied) return supplied;
  if (!symbol) throw noBars("No bars and no symbol.");
  const t = parseTicker(symbol);
  if (t.exchange !== "BINANCE") {
    throw noBars(`${t.ticker} has no bars source here: only BINANCE spot and BINANCE .P perpetual bars are fetched.`);
  }
  const interval = BINANCE_INTERVAL[timeframe];
  if (!interval || (interval === "1s" && t.perpetual)) {
    throw noBars(`Binance has no ${timeframe} klines for ${t.perpetual ? "perpetuals" : "spot"}.`);
  }
  const bar = timeframeMs(timeframe);
  const fetchEndMs = endMs + bar; // Preserve the chart feed padding; the harness trims to endMs.
  const need = Math.floor((fetchEndMs - startMs) / bar) + 1;
  if (need > MAX_FETCH_BARS) {
    throw noBars(`The range needs about ${need} bars at timeframe ${timeframe} from Binance; the fetch limit is ${MAX_FETCH_BARS}.`);
  }
  const market = t.perpetual ? "usdt_perp" : "spot";
  let fetched: { csv: string; bars: number };
  try {
    fetched = await deps.fetchBinanceCsv(market, t.symbol, interval, startMs, fetchEndMs, need);
  } catch (e) {
    throw noBars(`Fetching ${t.ticker} ${interval} klines from Binance failed: ${(e as Error).message.slice(0, 300)}.`);
  }
  const { csv, bars } = fetched;
  const opens = csv.trim().split(/\r?\n/).slice(1).map((row) => Number(row.split(",", 1)[0]))
    .filter((ms) => Number.isFinite(ms) && ms >= startMs && ms <= endMs);
  if (!opens.length) throw noBars("Binance returned no chart bars inside the run's range.");
  const path = join(work, "ohlcv.csv");
  await writeFile(path, csv, "utf8");
  return {
    path,
    fetched: { bars, firstOpenMs: opens[0]!, lastOpenMs: opens[opens.length - 1]! },
    source: `Binance ${market === "spot" ? "spot" : "USDT-M perpetual"} ${t.symbol} ${interval} klines ` +
      `(${bars} bars, fetched from the public API)`,
  };
}

/** The core's response for one call; user problems come back as ok:false. */
export async function checkParity(
  runner: EngineRunner,
  args: ParityToolArgs,
  deps: ParityDeps,
  notes: string[],
): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(args.pine, "utf8") > MAX_PINE_BYTES) {
    throw new ParityInputError("bad_request", "The Pine source is larger than 256 KiB.");
  }
  const exp = await readTradingViewExport(args.tradingview_trades, nodeInflate);
  const barsGiven = args.ohlcv_csv !== undefined || args.ohlcv_csv_path !== undefined;
  const s = resolveSettings(
    {
      symbol: args.symbol,
      timeframe: args.timeframe,
      range_start: args.range_start,
      range_end: args.range_end,
      chart_timezone: args.chart_timezone,
      strategy_overrides: args.strategy_overrides,
      runtime: args.runtime as Record<string, Scalar> | undefined,
    },
    exp.settings,
    { symbolRequired: !barsGiven },
  );
  const span = exportSpan(exp.csv, s.chartTimezone);
  if (span.firstEntryMs < s.rangeStartMs) {
    throw new ParityInputError(
      "trades_before_range_start",
      `TradingView's first entry (${span.firstEntry} ${s.chartTimezone}) is before the range start ` +
        `(${formatWall(s.rangeStartMs, s.chartTimezone)}): set range_start to the first bar of the TradingView backtest.`,
    );
  }
  const endMs = s.rangeEndMs ?? span.lastRowMs;
  const work = await mkdtemp(join(tmpdir(), "pineforge-pt-"));
  try {
    let magnifier = await suppliedBars(args.magnifier_ohlcv_csv, args.magnifier_ohlcv_csv_path,
      "magnifier_ohlcv", work, deps);
    const bars = await findBars(args, s.symbol, s.timeframe, s.rangeStartMs, endMs, work, deps);
    if (!magnifier && bars.fetched && declaresMagnifier(args.pine)) {
      const duration = timeframeMs(String(s.runtime.script_tf || s.timeframe));
      const window = magnifierWindow(bars.fetched.firstOpenMs, bars.fetched.lastOpenMs, duration);
      const need = Math.floor((window.endMs - window.startMs) / 60_000) + 1;
      if (bars.fetched.bars + need > MAX_FETCH_BARS) {
        throw noBars(`The range needs ${bars.fetched.bars} chart bars plus ${need} 1-minute magnifier bars; ` +
          `the Binance fetch limit is ${MAX_FETCH_BARS} bars in total. Shorten the range or pass both feeds.`);
      }
      const t = parseTicker(s.symbol!);
      const market = t.perpetual ? "usdt_perp" : "spot";
      let fine: { csv: string; bars: number };
      try {
        fine = await deps.fetchBinanceCsv(market, t.symbol, "1m", window.startMs, window.endMs, need);
      } catch (e) {
        throw noBars(`Fetching ${t.ticker} 1m magnifier bars from Binance failed: ${(e as Error).message.slice(0, 300)}.`);
      }
      const path = join(work, "magnifier_ohlcv.csv");
      await writeFile(path, fine.csv, "utf8");
      magnifier = { path, source: `Binance ${market === "spot" ? "spot" : "USDT-M perpetual"} ${t.symbol} 1m klines ` +
        `(${fine.bars} bars, fetched from the public API)` };
    }
    const request: Record<string, unknown> = {
      pine: args.pine,
      tradingview_trades_csv: exp.csv,
      chart_timezone: s.chartTimezone,
      timeframe: s.timeframe,
      range_start_ms: s.rangeStartMs,
      range_end_ms: s.rangeEndMs,
      inputs: args.inputs ?? {},
      strategy_overrides: s.strategyOverrides,
      runtime: s.runtime,
      max_mismatches: args.max_mismatches ?? 10,
    };
    const response = await runner.parity({ request, barsPath: bars.path, magnifierBarsPath: magnifier?.path });
    notes.push(`Bars: ${bars.source}.`);
    if (magnifier) notes.push(`Magnifier bars: ${magnifier.source}.`);
    if (s.rangeEndMs === null) {
      notes.push(`Range end: not given, so the export's last row (${span.lastRow} ${s.chartTimezone}) ends the run.`);
    }
    if (s.fromExport.length) notes.push(`From the export's Properties: ${s.fromExport.join(", ")}.`);
    if (exp.warnings.length && Array.isArray(response.warnings)) {
      response.warnings = [...exp.warnings, ...(response.warnings as unknown[])];
    } else if (exp.warnings.length) {
      response.warnings = exp.warnings;
    }
    response.export = {
      format: exp.format,
      rows: exp.rows,
      closed_trades: exp.closedTrades,
      settings_from_export: s.fromExport,
      ...(exp.format === "xlsx" ? { properties: exp.properties } : {}),
    };
    response.bars_source = bars.source;
    if (magnifier) response.magnifier_bars_source = magnifier.source;
    return response;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** MCP tool result: the plain-text block, the JSON, and structured content. */
export async function parityToolResult(runner: EngineRunner, args: ParityToolArgs, deps: ParityDeps) {
  const notes: string[] = [];
  let response: Record<string, unknown>;
  try {
    response = await checkParity(runner, args, deps, notes);
  } catch (e) {
    response = e instanceof ParityInputError
      ? { ok: false, error: e.kind, message: e.message }
      : { ok: false, error: "internal", message: e instanceof Error ? e.message : String(e) };
  }
  const text = formatParityResult(response, { retention: RETENTION_LOCAL, notes });
  return {
    content: [
      { type: "text" as const, text },
      { type: "text" as const, text: JSON.stringify(response) },
    ],
    structuredContent: response,
    isError: response.ok !== true,
  };
}
