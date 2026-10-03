/**
 * The instrument a backtest runs on: lot size, tick size and the symbol's names.
 *
 * The engine knows nothing of the instrument unless it is told: with no lot grid
 * (`qty_step`) a 100%-of-equity order can overshoot margin by a hair and the engine
 * books a sub-lot margin-call row that TradingView does not. This module builds the
 * `pineforge-instrument/v1` object that docker/pf_run_json.py applies through the
 * engine's C ABI, from Binance's public exchangeInfo, from the user's own values, or
 * from the sidecar file fetch_binance_ohlcv writes next to the CSV.
 *
 * Every number is finite and within 1e-12..1e12 and every string is at most 64
 * printable ASCII characters, or it is dropped (and named in `source.dropped`).
 * A run is never refused for want of an instrument: it goes ahead, says so in
 * `applied_runtime.syminfo`, and carries a warning.
 */

import { createHash } from "node:crypto";
import { lstat, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";

export type BinanceMarket = "spot" | "usdt_perp";

export const INSTRUMENT_SCHEMA = "pineforge-instrument/v1" as const;
export const NUMBER_MIN = 1e-12;
export const NUMBER_MAX = 1e12;
export const STRING_MAX = 64;
const REASON_MAX = 200;
const SIDECAR_MAX_BYTES = 64 * 1024;

export const NUMBER_KEYS = ["qty_step", "mincontract", "mintick", "pointvalue"] as const;
export const STRING_KEYS = ["type", "ticker", "tickerid", "currency", "basecurrency"] as const;

export interface InstrumentSource {
  kind: "binance_exchange_info" | "user";
  market?: BinanceMarket;
  symbol?: string;
  /** How a Binance instrument reached this run: resolved now from `symbol`, or read from the CSV's sidecar. */
  via?: "symbol" | "sidecar";
  /** Only in a sidecar and in fetch_binance_ohlcv's result; never in what a run applies (it would change the fingerprint). */
  fetched_at?: string;
  dropped?: string[];
  overridden?: string[];
  base?: InstrumentSource;
}

export interface Instrument {
  schema: typeof INSTRUMENT_SCHEMA;
  /** True when the lot grid (qty_step) is known; the other fields may be set either way. */
  resolved: boolean;
  reason?: string;
  qty_step?: number;
  mincontract?: number;
  mintick?: number;
  pointvalue?: number;
  type?: string;
  ticker?: string;
  tickerid?: string;
  currency?: string;
  basecurrency?: string;
  source?: InstrumentSource;
}

// ─── Validation ───────────────────────────────────────────────────────────

/** The number when it is finite and within 1e-12..1e12, else undefined. */
export function cleanNumber(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v >= NUMBER_MIN && v <= NUMBER_MAX ? v : undefined;
}

/** The string when it is 1..limit printable ASCII characters, else undefined. */
export function cleanString(v: unknown, limit = STRING_MAX): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > limit) return undefined;
  return /^[\x20-\x7e]+$/.test(v) ? v : undefined;
}

/** A Binance filter value ("0.00001000", or a number) as a clean number. */
function binanceNumber(v: unknown): number | undefined {
  if (typeof v === "string" && /^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return cleanNumber(Number(v));
  return cleanNumber(v);
}

/** Free text for `reason`, made printable ASCII and at most 200 characters. */
export function reasonText(text: string): string {
  return text.replace(/[^\x20-\x7e]+/g, "?").trim().slice(0, REASON_MAX) || "unknown";
}

/** Error text without the credentials of any URL in it (user:password@host). */
export function redactCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]*@/g, "//");
}

// ─── The `syminfo` tool argument ──────────────────────────────────────────

const stepNumber = z.number().min(NUMBER_MIN).max(NUMBER_MAX);
const shortText = z.string().min(1).max(STRING_MAX).regex(/^[\x20-\x7e]+$/, "printable ASCII only");

export const SyminfoArgSchema = z.object({
  qty_step: stepNumber.describe(
    "Lot size in base units: order quantities are floored to a multiple of it. This is what removes " +
    "sub-lot rows. Defaults to mincontract when only that is given."
  ).optional(),
  mincontract: stepNumber.describe(
    "syminfo.mincontract: the smallest tradable quantity step (TradingView reports the lot size here). " +
    "Defaults to qty_step when only that is given."
  ).optional(),
  mintick: stepNumber.describe("Price tick size (syminfo.mintick). Fills round to it. Engine default 0.01.").optional(),
  pointvalue: stepNumber.describe("Money per price point per contract (syminfo.pointvalue). Engine default 1.").optional(),
  type: shortText.describe("syminfo.type, e.g. 'crypto', 'forex', 'stock'.").optional(),
  currency: shortText.describe("syminfo.currency, e.g. 'USDT'.").optional(),
  basecurrency: shortText.describe("syminfo.basecurrency, e.g. 'BTC'.").optional(),
  ticker: shortText.describe("syminfo.ticker, e.g. 'BTCUSDT'.").optional(),
  tickerid: shortText.describe("syminfo.tickerid, e.g. 'BINANCE:BTCUSDT'.").optional(),
}).strict();

export type UserSyminfo = z.infer<typeof SyminfoArgSchema>;

// ─── Building the instrument ──────────────────────────────────────────────

export function unresolvedInstrument(reason: string, source?: InstrumentSource): Instrument {
  return { schema: INSTRUMENT_SCHEMA, resolved: false, reason: reasonText(reason), ...(source ? { source } : {}) };
}

/** One symbol of Binance's exchangeInfo (spot /api/v3 or USD-M /fapi/v1). */
export interface BinanceSymbolInfo {
  symbol: string;
  status?: string;
  contractType?: string;
  baseAsset?: string;
  quoteAsset?: string;
  filters?: unknown;
}

function filterOf(info: BinanceSymbolInfo, type: string): Record<string, unknown> | undefined {
  if (!Array.isArray(info.filters)) return undefined;
  const found = info.filters.find((f) => typeof f === "object" && f !== null && (f as { filterType?: unknown }).filterType === type);
  return found as Record<string, unknown> | undefined;
}

/**
 * The instrument of one Binance symbol: lot size = LOT_SIZE.stepSize (also
 * mincontract), tick = PRICE_FILTER.tickSize, point value 1, type crypto.
 */
export function instrumentFromBinance(info: BinanceSymbolInfo, market: BinanceMarket): Instrument {
  const symbol = info.symbol.toUpperCase();
  const step = binanceNumber(filterOf(info, "LOT_SIZE")?.stepSize);
  const tick = binanceNumber(filterOf(info, "PRICE_FILTER")?.tickSize);
  const perpetual = market === "usdt_perp" && /PERPETUAL/.test(info.contractType ?? "");
  const ticker = `${symbol}${perpetual ? ".P" : ""}`;
  const out: Instrument = {
    schema: INSTRUMENT_SCHEMA,
    resolved: step !== undefined,
    ...(step === undefined ? { reason: reasonText(`Binance ${market} exchangeInfo has no usable LOT_SIZE.stepSize for ${symbol}`) } : {}),
  };
  // TradingView names a perpetual BTCUSDT.P in both syminfo.ticker and syminfo.tickerid.
  const text = {
    type: "crypto",
    ticker,
    tickerid: `BINANCE:${ticker}`,
    currency: info.quoteAsset,
    basecurrency: info.baseAsset,
  };
  const numbers = { qty_step: step, mincontract: step, mintick: tick, pointvalue: 1 };
  const dropped = NUMBER_KEYS.filter((k) => numbers[k] === undefined);
  for (const k of NUMBER_KEYS) if (numbers[k] !== undefined) out[k] = numbers[k];
  for (const k of STRING_KEYS) {
    const v = cleanString(text[k]);
    if (v !== undefined) out[k] = v;
  }
  out.source = { kind: "binance_exchange_info", market, symbol, ...(dropped.length ? { dropped } : {}) };
  return out;
}

/**
 * The user's values over `base` (explicit values win). qty_step and mincontract
 * move together: a user value for either one replaces both, the other defaulting
 * to it, so a changed lot size never keeps a stale mincontract.
 */
export function layerUserSyminfo(base: Instrument | undefined, user: UserSyminfo): Instrument {
  const out: Instrument = { schema: INSTRUMENT_SCHEMA, resolved: false };
  const overridden: string[] = [];
  const dropped: string[] = [];
  const fields = { ...user } as Record<string, unknown>;
  if (fields.qty_step !== undefined || fields.mincontract !== undefined) {
    fields.qty_step ??= fields.mincontract;
    fields.mincontract ??= fields.qty_step;
  }
  const o = out as unknown as Record<string, unknown>;
  const b = (base ?? {}) as unknown as Record<string, unknown>;
  for (const k of [...NUMBER_KEYS, ...STRING_KEYS]) {
    const mine = (NUMBER_KEYS as readonly string[]).includes(k) ? cleanNumber(fields[k]) : cleanString(fields[k]);
    if (fields[k] !== undefined && mine === undefined) dropped.push(k);
    if (mine !== undefined) {
      o[k] = mine;
      if (b[k] !== undefined && b[k] !== mine) overridden.push(k);
    } else if (b[k] !== undefined) {
      o[k] = b[k];
    }
  }
  out.resolved = out.qty_step !== undefined;
  if (!out.resolved) {
    out.reason = reasonText(base?.reason ?? "syminfo has no qty_step or mincontract");
  }
  // What the base could not provide and the user did not either is still dropped.
  for (const k of base?.source?.dropped ?? []) if (o[k] === undefined && !dropped.includes(k)) dropped.push(k);
  out.source = {
    kind: "user",
    ...(base?.source ? { base: base.source } : {}),
    ...(overridden.length ? { overridden } : {}),
    ...(dropped.length ? { dropped } : {}),
  };
  return out;
}

// ─── Warnings ─────────────────────────────────────────────────────────────

/** The warning for an instrument whose lot grid is unknown (docs: "what unresolved means"). */
export function unresolvedWarning(label: string, reason: string, detail?: string): string {
  return (
    `instrument grid unavailable for ${label} (${reason}${detail ? `: ${detail}` : ""}): order quantity is not floored to a lot size, ` +
    "so the run can contain sub-lot margin-call rows that TradingView does not book. " +
    "Pass `symbol` (a Binance symbol) or `syminfo` (qty_step, mintick, ...), or fetch the CSV with " +
    "fetch_binance_ohlcv, which records the instrument next to it."
  );
}

/**
 * What the engine says it applied against what was asked for. An image whose
 * entrypoint ignores the instrument, or a library without the setters, must not
 * leave the result claiming a lot grid that was never set.
 */
export function appliedWarnings(asked: Instrument, report: unknown): string[] {
  const runtime = (report as { applied_runtime?: { syminfo?: unknown } } | null)?.applied_runtime;
  const applied = runtime?.syminfo as { resolved?: unknown; reason?: unknown; skipped?: unknown } | undefined;
  if (typeof applied !== "object" || applied === null) {
    return [
      "the engine did not report the instrument it applied (applied_runtime.syminfo is missing): " +
      "its image may be too old to take one, so the lot grid was probably not applied",
    ];
  }
  const out: string[] = [];
  if (asked.resolved && applied.resolved !== true) {
    out.push(`the engine did not apply the instrument's lot grid (${typeof applied.reason === "string" ? applied.reason : "no reason given"})`);
  }
  if (Array.isArray(applied.skipped) && applied.skipped.length > 0) {
    out.push(`the engine library could not set ${applied.skipped.filter((k) => typeof k === "string").join(", ")} from the instrument`);
  }
  return out;
}

// ─── The sidecar next to a fetched CSV ────────────────────────────────────

export function sidecarPath(csvPath: string): string {
  return `${csvPath}.instrument.json`;
}

export interface SidecarFeed {
  interval: string;
  first_open_time: number;
  last_open_time: number;
  bars: number;
}

/** Opening times of a CSV's first and last bar, reading only its two ends. */
export async function csvBarRange(csvPath: string): Promise<{ first: number; last: number } | undefined> {
  const fh = await open(csvPath, "r");
  try {
    const { size } = await fh.stat();
    const span = Math.min(size, 8192);
    const head = Buffer.alloc(span);
    const tail = Buffer.alloc(span);
    await fh.read(head, 0, span, 0);
    await fh.read(tail, 0, span, size - span);
    const rows = (b: Buffer) => b.toString("utf8").split(/\r?\n/).filter((l) => /^\d+,/.test(l));
    const first = Number(rows(head)[0]?.split(",")[0]);
    const last = Number(rows(tail).pop()?.split(",")[0]);
    return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : undefined;
  } finally {
    await fh.close();
  }
}

/**
 * Write the sidecar of `csvPath`: the instrument, plus the bar range it was fetched for.
 * The CSV's path was scoped by the caller; the sidecar sits beside it, so what is already
 * at its name is removed first (a symbolic link itself, never its target) and the file is
 * created exclusively: nothing is ever written through a link.
 */
export async function writeSidecar(csvPath: string, instrument: Instrument, feed: SidecarFeed): Promise<string> {
  const path = sidecarPath(csvPath);
  const sha256 = await sha256Of(csvPath);
  await rm(path, { force: true });
  await writeFile(path, JSON.stringify({ ...instrument, csv: { ...feed, sha256 } }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return path;
}

async function sha256Of(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function removeSidecar(csvPath: string): Promise<void> {
  await rm(sidecarPath(csvPath), { force: true });
}

/** An instrument read from untrusted JSON: known keys only, every value validated. */
function sanitize(raw: Record<string, unknown>): Instrument {
  const out: Instrument = { schema: INSTRUMENT_SCHEMA, resolved: false };
  const o = out as unknown as Record<string, unknown>;
  for (const k of NUMBER_KEYS) {
    const v = cleanNumber(raw[k]);
    if (v !== undefined) o[k] = v;
  }
  for (const k of STRING_KEYS) {
    const v = cleanString(raw[k]);
    if (v !== undefined) o[k] = v;
  }
  // As for the user's values: either one is the lot size.
  if (out.qty_step === undefined && out.mincontract !== undefined) out.qty_step = out.mincontract;
  if (out.mincontract === undefined && out.qty_step !== undefined) out.mincontract = out.qty_step;
  out.resolved = out.qty_step !== undefined;
  if (!out.resolved) out.reason = reasonText(typeof raw.reason === "string" ? raw.reason : "the sidecar has no usable qty_step");
  const src = (typeof raw.source === "object" && raw.source !== null ? raw.source : {}) as Record<string, unknown>;
  const market = src.market === "spot" || src.market === "usdt_perp" ? src.market : undefined;
  const symbol = cleanString(src.symbol);
  out.source = {
    kind: src.kind === "binance_exchange_info" ? "binance_exchange_info" : "user",
    ...(market ? { market } : {}),
    ...(symbol ? { symbol } : {}),
    via: "sidecar",
  };
  return out;
}

export interface SidecarRead {
  instrument?: Instrument;
  /** Why a sidecar that exists was not used. */
  ignored?: string;
}

/** The instrument recorded next to `csvPath`, if there is one and the CSV does not contradict it. */
export async function readSidecar(csvPath: string): Promise<SidecarRead> {
  const path = sidecarPath(csvPath);
  const st = await lstat(path).catch(() => null);
  if (!st) return {};
  const name = basename(path);
  if (!st.isFile() || st.size > SIDECAR_MAX_BYTES) return { ignored: `${name} is not a small regular file` };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { ignored: `${name} is not valid JSON` };
  }
  if (typeof raw !== "object" || raw === null || (raw as { schema?: unknown }).schema !== INSTRUMENT_SCHEMA) {
    return { ignored: `${name} is not a ${INSTRUMENT_SCHEMA} file` };
  }
  const rec = raw as Record<string, unknown>;
  const csv = rec.csv as (Partial<SidecarFeed> & { sha256?: unknown }) | undefined;
  if (csv && typeof csv === "object") {
    const range = await csvBarRange(csvPath).catch(() => undefined);
    if (!range || range.first !== csv.first_open_time || range.last !== csv.last_open_time) {
      // The sidecar is a file anyone may have written: only numbers go into text the model reads.
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
      return {
        ignored: reasonText(
          `${name} was written for bars ${num(csv.first_open_time)}..${num(csv.last_open_time)} and the CSV now holds ` +
          `${range ? `${range.first}..${range.last}` : "no readable bars"}`,
        ),
      };
    }
    if (typeof csv.sha256 === "string" && csv.sha256 !== (await sha256Of(csvPath).catch(() => ""))) {
      return { ignored: `${name} was written for a different CSV (the bars' range is the same, the content differs)` };
    }
  }
  return { instrument: sanitize(rec) };
}

// ─── Resolution ───────────────────────────────────────────────────────────

export interface InstrumentRequest {
  symbol?: string;
  market?: BinanceMarket;
  syminfo?: UserSyminfo;
}

export interface Resolution {
  instrument: Instrument;
  warnings: string[];
}

/**
 * Settle the instrument of one run. The base is `symbol` resolved from Binance's
 * exchangeInfo (`lookup`) or, without a symbol, the sidecar next to the CSV;
 * `syminfo` is the user's own values and wins over it. Nothing resolvable is not
 * an error: the result is an unresolved instrument and a warning.
 */
export async function resolveInstrument(
  req: InstrumentRequest,
  csvPath: string,
  lookup: (market: BinanceMarket, symbol: string) => Promise<BinanceSymbolInfo | undefined>,
): Promise<Resolution> {
  const market = req.market ?? "spot";
  const symbol = req.symbol?.trim().toUpperCase();
  // `syminfo: {}` says nothing.
  const user = req.syminfo && Object.keys(req.syminfo).length > 0 ? req.syminfo : undefined;
  let base: Instrument | undefined;
  let label = basename(csvPath);
  // What the warning adds to the short reason in the instrument. The reason is part of the
  // fingerprint, so it is fixed text; error text, which varies, is not.
  let detail: string | undefined;

  if (symbol) {
    label = `Binance ${market} ${symbol}`;
    const source: InstrumentSource = { kind: "binance_exchange_info", market, symbol, via: "symbol" };
    try {
      const info = await lookup(market, symbol);
      if (info) {
        const found = instrumentFromBinance(info, market);
        base = { ...found, source: { ...found.source!, via: "symbol" } };
      } else {
        base = unresolvedInstrument(`${symbol} is not in Binance ${market} exchangeInfo`, source);
      }
    } catch (e) {
      base = unresolvedInstrument(`Binance ${market} exchangeInfo unavailable`, source);
      detail = reasonText(redactCredentials(e instanceof Error ? e.message : String(e)));
    }
  } else {
    // The CSV's own instrument; the user's values, if any, go over it.
    const read = await readSidecar(csvPath);
    if (read.instrument) {
      base = read.instrument;
      const s = base.source;
      if (s?.symbol) label = `Binance ${s.market ?? "spot"} ${s.symbol}`;
    } else if (user) {
      detail = read.ignored && reasonText(read.ignored); // the user's values are the instrument; why the sidecar was not used goes in the warning
    } else if (read.ignored) {
      base = unresolvedInstrument("sidecar ignored");
      detail = reasonText(read.ignored);
    } else {
      base = unresolvedInstrument("no symbol, syminfo or sidecar was given");
    }
  }

  const instrument = user ? layerUserSyminfo(base, user) : base!;
  const warnings: string[] = [];
  if (!instrument.resolved) warnings.push(unresolvedWarning(label, instrument.reason ?? "unknown", detail));
  const dropped = instrument.source?.dropped;
  if (dropped?.length) {
    warnings.push(
      `instrument values dropped (not finite numbers within ${NUMBER_MIN}..${NUMBER_MAX}, or not printable ASCII): ` +
      `${dropped.join(", ")}; the engine's default applies to them`,
    );
  }
  if (instrument.resolved && instrument.mintick === undefined) {
    warnings.push(
      "the instrument has no mintick, so the engine's default tick of 0.01 applies and rounds every fill to it " +
      "(a price below 0.01 fills at 0): pass `syminfo.mintick`",
    );
  }
  return { instrument, warnings };
}
