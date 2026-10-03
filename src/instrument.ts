/**
 * The instrument a backtest runs on: lot size, tick size, point value, type and currencies.
 *
 * The engine knows nothing of the instrument unless it is told: with no lot grid
 * (`qty_step`) a 100%-of-equity order can overshoot margin by a hair and the engine
 * books a sub-lot margin-call row that TradingView does not. This module builds the
 * `pineforge-instrument/v1` object that docker/pf_run_json.py applies through the
 * engine's C ABI. The lot size is the user's own, else TradingView's own reading for that
 * Binance symbol (the embedded table, src/tv-grid.ts), else for a symbol TradingView does not
 * list Binance's LOT_SIZE.stepSize, else for a listing newer than the table TradingView's usual
 * 0.001 (a market the table has no usual lot size for takes Binance's step); the tick size and
 * currencies come from Binance's public exchangeInfo, or from the sidecar file
 * fetch_binance_ohlcv writes next to the CSV.
 *
 * Every number is finite and within 1e-12..1e12 and every string is at most 64
 * printable ASCII characters, or it is dropped (and named in `source.dropped`).
 * A run is never refused for want of an instrument: it goes ahead, says so in
 * `applied_runtime.syminfo`, and carries a warning.
 */

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { tvDefaultLot, tvGrid, tvLotStep, tvNotListed } from "./tv-grid.js";

export type BinanceMarket = "spot" | "usdt_perp";

export const INSTRUMENT_SCHEMA = "pineforge-instrument/v1" as const;
export const NUMBER_MIN = 1e-12;
export const NUMBER_MAX = 1e12;
export const STRING_MAX = 64;
const REASON_MAX = 200;
const SIDECAR_MAX_BYTES = 64 * 1024;

export const NUMBER_KEYS = ["qty_step", "mincontract", "mintick", "pointvalue"] as const;
export const STRING_KEYS = ["type", "currency", "basecurrency"] as const;

/**
 * Where the lot size came from: a TradingView reading in the table, Binance's exchangeInfo, TradingView's
 * usual lot size for a listing newer than the table, or the user.
 */
export type LotOrigin = "tradingview" | "exchange" | "default" | "user";

export interface InstrumentSource {
  kind: LotOrigin;
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

/**
 * A name from a file or a server (an asset, a symbol, a type): letters, digits and _ . : - only, at most 32
 * characters. It ends up in text the model reads, so free text is not carried.
 */
export function cleanToken(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,32}$/.test(v) ? v : undefined;
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
}).strict();

export type UserSyminfo = z.infer<typeof SyminfoArgSchema>;

// ─── Building the instrument ──────────────────────────────────────────────

export function unresolvedInstrument(reason: string, source?: InstrumentSource): Instrument {
  return { schema: INSTRUMENT_SCHEMA, resolved: false, reason: reasonText(reason), ...(source ? { source } : {}) };
}

/** Whether the instrument holds anything the engine can be given: a run without one is the image's own. */
export function hasApplicableField(i: Instrument): boolean {
  return [i.qty_step, i.mincontract, i.mintick, i.pointvalue, i.type, i.currency, i.basecurrency].some((v) => v !== undefined);
}

/** What the result says when nothing was applied: no instrument resolved or given, so the run is the image's own. */
export const NOT_APPLIED_WARNING =
  "no instrument was applied: the engine ran with its defaults (no lot size, tick 0.01, point value 1)";

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
 * What the embedded table says of a symbol's lot size: TradingView's own reading, else the market's usual lot
 * size (a listing newer than the readings), unless the table says TradingView does not list the symbol. Neither
 * means the exchange's lot step is the only one there is (so also for a table that has no such sections).
 * `reading` is where the readings come from (the tests pass their own).
 */
export function tvLotFor(
  market: BinanceMarket,
  symbol: string,
  reading: (market: BinanceMarket, symbol: string) => number | undefined = tvLotStep,
): { reading?: number; usual?: number } {
  const own = reading(market, symbol);
  if (own !== undefined) return { reading: own };
  if (tvNotListed(market, symbol)) return {};
  const usual = tvDefaultLot(market)?.mincontract;
  return usual === undefined ? {} : { usual };
}

/**
 * The instrument of one Binance symbol. Lot size (also mincontract): `tvStep`, TradingView's own reading
 * for the symbol, when given, else `usualStep`, TradingView's usual lot size for a listing newer than its
 * readings, when given, else the exchange's LOT_SIZE.stepSize. Tick = PRICE_FILTER.tickSize, point value 1,
 * type crypto, currencies from the exchange record.
 */
export function instrumentFromBinance(
  info: BinanceSymbolInfo,
  market: BinanceMarket,
  tvStep?: number,
  usualStep?: number,
): Instrument {
  const symbol = info.symbol.toUpperCase();
  const tv = cleanNumber(tvStep);
  const usual = tv === undefined ? cleanNumber(usualStep) : undefined;
  const step = tv ?? usual ?? binanceNumber(filterOf(info, "LOT_SIZE")?.stepSize);
  const tick = binanceNumber(filterOf(info, "PRICE_FILTER")?.tickSize);
  const out: Instrument = {
    schema: INSTRUMENT_SCHEMA,
    resolved: step !== undefined,
    ...(step === undefined ? { reason: reasonText(`Binance ${market} exchangeInfo has no usable LOT_SIZE.stepSize for ${symbol}`) } : {}),
  };
  const text = { type: "crypto", currency: info.quoteAsset, basecurrency: info.baseAsset };
  const numbers = { qty_step: step, mincontract: step, mintick: tick, pointvalue: 1 };
  const dropped = NUMBER_KEYS.filter((k) => numbers[k] === undefined);
  for (const k of NUMBER_KEYS) if (numbers[k] !== undefined) out[k] = numbers[k];
  for (const k of STRING_KEYS) {
    const v = cleanToken(text[k]);
    if (v !== undefined) out[k] = v;
  }
  const kind: LotOrigin = tv !== undefined ? "tradingview" : usual !== undefined ? "default" : "exchange";
  out.source = { kind, market, symbol, ...(dropped.length ? { dropped } : {}) };
  return out;
}

/**
 * The instrument of a Binance symbol the table has and the exchange does not give (unreachable, or no
 * longer listed): TradingView's lot size, point value 1, type crypto; no tick size, no currencies.
 */
export function instrumentFromTable(market: BinanceMarket, symbol: string, tvStep: number): Instrument {
  return {
    schema: INSTRUMENT_SCHEMA,
    resolved: true,
    qty_step: tvStep,
    mincontract: tvStep,
    pointvalue: 1,
    type: "crypto",
    source: { kind: "tradingview", market, symbol: symbol.toUpperCase() },
  };
}

/** Where the instrument's lot size came from, if it has one. */
export function lotOrigin(i: Instrument): LotOrigin | undefined {
  const s = i.source;
  if (!s || i.qty_step === undefined) return undefined;
  if (s.kind !== "user") return s.kind;
  return !s.base || s.overridden?.includes("qty_step") ? "user" : s.base.kind;
}

const ORIGIN_TEXT: Record<LotOrigin, string> = {
  tradingview: "TradingView's",
  exchange: "Binance's",
  default: "TradingView's usual default",
  user: "your syminfo",
};

/** One line for the result text: what instrument the run has and where its lot size is from. */
export function describeInstrument(i: Instrument): string {
  const s = i.source?.kind === "user" ? (i.source.base ?? i.source) : i.source;
  const what = s?.symbol ? `${s.symbol} ${s.market === "usdt_perp" ? "USDT-M perpetual" : "spot"}: ` : "";
  if (!i.resolved) return `${what}no lot size (${i.reason ?? "unknown"}), so order quantity is not floored`;
  return `${what}lot size ${i.qty_step} (${ORIGIN_TEXT[lotOrigin(i)!]}), tick ${i.mintick ?? "0.01 (the engine's default)"}, point value ${i.pointvalue ?? 1}.`;
}

/**
 * The user's values over `base` (explicit values win). qty_step and mincontract
 * move together: a user value for either one replaces both, the other defaulting
 * to it, so a changed lot size never keeps a stale mincontract. `source.overridden`
 * names what the user gave that the base lacked or had differently.
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
      if (base && b[k] !== mine) overridden.push(k);
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

const BACKTEST_HINT =
  "Pass `symbol` (a Binance symbol) or `syminfo` (qty_step, mintick, ...), or fetch the CSV with " +
  "fetch_binance_ohlcv, which records the instrument next to it.";

/** The warning for an instrument whose lot grid is unknown (docs: "what unresolved means"). */
export function unresolvedWarning(label: string, reason: string, detail?: string, hint = BACKTEST_HINT): string {
  return (
    `instrument grid unavailable for ${label} (${reason}${detail ? `: ${detail}` : ""}): order quantity is not floored to a lot size, ` +
    `so the run can contain sub-lot margin-call rows that TradingView does not book. ${hint}`
  );
}

/** The provenance warning for a lot size that is the exchange's lot step, not a TradingView reading. */
export function exchangeLotWarning(label: string): string {
  return `lot size for ${label} is the exchange's lot step, not a TradingView reading: order quantities may differ from TradingView's`;
}

/** The provenance warning for TradingView's usual lot size, applied to a listing newer than the readings. */
export function defaultLotWarning(label: string, step: number): string {
  return (
    `lot size for ${label} is TradingView's usual default (${String(step)}), not a reading for this symbol ` +
    "(a listing newer than the readings): order quantities may differ from TradingView's"
  );
}

/** Trade quantities that are not multiples of the lot step (tolerance: 1e-6 of one step, or float rounding of the quantity). */
function lotMismatches(report: unknown, step: number): { bad: number; total: number; onlyRangeEnd: boolean } | undefined {
  const trades = (report as { trades?: unknown } | null)?.trades;
  if (!Array.isArray(trades)) return undefined;
  let total = 0;
  const bad: boolean[] = []; // one entry per mismatch: whether it is the range-end mark
  for (const t of trades) {
    const q = (t as { qty?: unknown } | null)?.qty;
    if (typeof q !== "number" || !Number.isFinite(q)) continue;
    total++;
    const tolerance = Math.max(1e-6 * step, 8 * Number.EPSILON * Math.abs(q));
    if (Math.abs(q - Math.round(q / step) * step) > tolerance) bad.push((t as { open_at_end?: unknown }).open_at_end === true);
  }
  return { bad: bad.length, total, onlyRangeEnd: bad.length === 1 && bad[0] === true };
}

/**
 * What the engine says it applied against what was asked for, and whether its trades bear it out. An image
 * whose entrypoint ignores the instrument, or a library without the setters, must not leave the result
 * claiming a lot grid that was never set; an engine that predates the lot grid accepts the setter and
 * ignores it, which only the trade quantities show (`quantities`: false skips that check).
 */
export function appliedWarnings(asked: Instrument, report: unknown, quantities = true): string[] {
  const runtime = (report as { applied_runtime?: { syminfo?: unknown } } | null)?.applied_runtime;
  const applied = runtime?.syminfo as { resolved?: unknown; reason?: unknown; skipped?: unknown; qty_step?: unknown } | undefined;
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
  const step = cleanNumber(applied.qty_step);
  if (quantities && applied.resolved === true && step !== undefined) {
    const m = lotMismatches(report, step);
    if (m && m.bad > 0 && !m.onlyRangeEnd) {
      out.push(
        `the engine reported the lot size applied, but ${m.bad} of ${m.total} trade quantities are not multiples of it ` +
        "(an older engine ignores it)",
      );
    }
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

/** sha256 of a file, read in chunks (a CSV can be large). */
async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function removeSidecar(csvPath: string): Promise<void> {
  await rm(sidecarPath(csvPath), { force: true });
}

/** The reasons this module itself writes for an unresolved instrument: all a sidecar may carry; anything else is "unspecified". */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "no symbol, syminfo or sidecar was given",
  "sidecar ignored",
  "syminfo has no qty_step or mincontract",
  "the sidecar has no usable qty_step",
]);

/** A sidecar's `reason` is text anyone may have written, and it ends up in text a model reads: fixed text only. */
function sidecarReason(raw: unknown): string {
  if (raw === undefined) return "the sidecar has no usable qty_step";
  return typeof raw === "string" && KNOWN_REASONS.has(raw) ? raw : "unspecified";
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
    const v = cleanToken(raw[k]);
    if (v !== undefined) o[k] = v;
  }
  // As for the user's values: either one is the lot size.
  if (out.qty_step === undefined && out.mincontract !== undefined) out.qty_step = out.mincontract;
  if (out.mincontract === undefined && out.qty_step !== undefined) out.mincontract = out.qty_step;
  out.resolved = out.qty_step !== undefined;
  if (!out.resolved) out.reason = sidecarReason(raw.reason);
  const src = (typeof raw.source === "object" && raw.source !== null ? raw.source : {}) as Record<string, unknown>;
  const market = src.market === "spot" || src.market === "usdt_perp" ? src.market : undefined;
  const symbol = typeof src.symbol === "string" && /^[A-Z0-9_]{2,40}$/.test(src.symbol) ? src.symbol : undefined;
  out.source = {
    kind: src.kind === "tradingview" ? "tradingview"
      : src.kind === "default" ? "default"
      : src.kind === "exchange" || src.kind === "binance_exchange_info" ? "exchange"
      : "user",
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

/**
 * The sidecar's bytes, or why not: opened without following a symbolic link, checked on the open file
 * (a regular file), and read up to the size limit and no further.
 */
async function readSmallFile(path: string): Promise<{ text?: string; missing?: boolean; notSmall?: boolean; unreadable?: boolean }> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    if (code === "ELOOP" || code === "EMLINK" || code === "ENOTDIR") return { notSmall: true };
    return { unreadable: true };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > SIDECAR_MAX_BYTES) return { notSmall: true };
    const buf = Buffer.alloc(SIDECAR_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > SIDECAR_MAX_BYTES) return { notSmall: true };
    return { text: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await fh.close();
  }
}

/** The instrument recorded next to `csvPath`, if there is one and the CSV does not contradict it. */
export async function readSidecar(csvPath: string): Promise<SidecarRead> {
  const path = sidecarPath(csvPath);
  const name = basename(path);
  const file = await readSmallFile(path);
  if (file.missing) return {};
  if (file.notSmall) return { ignored: `${name} is not a small regular file` };
  if (file.text === undefined) return { ignored: `${name} cannot be read` };
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
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
  /** What an unresolved warning tells the caller to pass (default: backtest_pine's arguments). */
  hint?: string;
}

export interface Resolution {
  instrument: Instrument;
  warnings: string[];
}

/** `syminfo: {}` says nothing. */
export function givenSyminfo(syminfo: UserSyminfo | undefined): UserSyminfo | undefined {
  return syminfo && Object.keys(syminfo).length > 0 ? syminfo : undefined;
}

/**
 * The user's values over `base`, then the warnings the result carries. `detail` is what
 * the unresolved warning adds to the short reason in the instrument (the reason is part
 * of the fingerprint, so it is fixed text; error text, which varies, is not). `notes` go in as they are.
 */
export function settleInstrument(input: {
  base: Instrument | undefined;
  user?: UserSyminfo;
  label: string;
  detail?: string;
  notes?: string[];
  hint?: string;
}): Resolution {
  const user = givenSyminfo(input.user);
  const instrument = user ? layerUserSyminfo(input.base, user) : input.base!;
  const warnings: string[] = [];
  if (!instrument.resolved) warnings.push(unresolvedWarning(input.label, instrument.reason ?? "unknown", input.detail, input.hint));
  warnings.push(...(input.notes ?? []));
  // A lot size the user gave is theirs, even when it equals the base's (a user who confirms TradingView's usual
  // 0.001 must be able to silence the warning that says it is only the usual one).
  const userLot = user !== undefined && (cleanNumber(user.qty_step) !== undefined || cleanNumber(user.mincontract) !== undefined);
  const origin = userLot ? "user" : lotOrigin(instrument);
  if (origin === "exchange") warnings.push(exchangeLotWarning(input.label));
  else if (origin === "default") warnings.push(defaultLotWarning(input.label, instrument.qty_step!));
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

/**
 * Settle the instrument of one run. The base is the Binance `symbol`, or without one the sidecar
 * next to the CSV; `syminfo` is the user's own values and goes over it. For a symbol the lot size
 * is TradingView's reading from the embedded table (`tv`); for a symbol the table says TradingView
 * does not list, Binance's exchangeInfo (`lookup`), which also gives the tick size and currencies;
 * for one in neither, TradingView's usual lot size of the market (the table's `defaults`), or
 * Binance's where the table has none. Without Binance's record (and no reading) there is no lot
 * size: nothing resolvable is not an error, the result is an unresolved instrument and a warning.
 */
export async function resolveInstrument(
  req: InstrumentRequest,
  csvPath: string | undefined,
  lookup: (market: BinanceMarket, symbol: string) => Promise<BinanceSymbolInfo | undefined>,
  tv: (market: BinanceMarket, symbol: string) => number | undefined = tvLotStep,
): Promise<Resolution> {
  const symbol = req.symbol?.trim().toUpperCase();
  const user = givenSyminfo(req.syminfo);
  const notes: string[] = [];
  // Without `market`, a CSV fetched for a symbol keeps its market: the sidecar that names this symbol says which.
  let market: BinanceMarket = req.market ?? "spot";
  let marketKnown = req.market !== undefined;
  if (symbol && csvPath) {
    const recorded = (await readSidecar(csvPath)).instrument?.source;
    if (recorded?.symbol === symbol && recorded.market) {
      if (req.market === undefined) {
        market = recorded.market;
        marketKnown = true;
      } else if (req.market !== recorded.market) {
        notes.push(
          `the CSV was fetched for ${recorded.market} (its sidecar says so), but market ${req.market} was given: ` +
          `the instrument is ${symbol} on ${req.market}`,
        );
      }
    }
  }
  if (symbol && !marketKnown) {
    notes.push(`market not given: spot assumed for ${symbol} (pass market "usdt_perp" for a USD-M perpetual)`);
  }
  let base: Instrument | undefined;
  let label = csvPath ? basename(csvPath) : "the instrument";
  let detail: string | undefined;

  if (symbol) {
    label = `Binance ${market} ${symbol}`;
    const table = tvGrid();
    if (table.error) notes.push(table.error);
    const lot: { reading?: number; usual?: number } = table.grid ? tvLotFor(market, symbol, tv) : {};
    const { reading, usual } = lot;
    const source: InstrumentSource = { kind: reading !== undefined ? "tradingview" : "exchange", market, symbol, via: "symbol" };
    let info: BinanceSymbolInfo | undefined;
    let unavailable: string | undefined;
    try {
      info = await lookup(market, symbol);
    } catch (e) {
      unavailable = reasonText(redactCredentials(e instanceof Error ? e.message : String(e)));
    }
    const why = unavailable !== undefined ? `Binance ${market} exchangeInfo unavailable` : `${symbol} is not in Binance ${market} exchangeInfo`;
    if (info) {
      const found = instrumentFromBinance(info, market, reading, usual);
      base = { ...found, source: { ...found.source!, via: "symbol" } };
    } else if (reading !== undefined) {
      const found = instrumentFromTable(market, symbol, reading);
      base = { ...found, source: { ...found.source!, via: "symbol" } };
      notes.push(
        `${why}${unavailable ? ` (${unavailable})` : ""}: the lot size is TradingView's, from the embedded table, ` +
        "but the tick size and currencies are not known",
      );
    } else {
      base = unresolvedInstrument(why, source);
      detail = unavailable;
    }
  } else {
    // The CSV's own instrument; the user's values, if any, go over it.
    const read = csvPath ? await readSidecar(csvPath) : {};
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
  return settleInstrument({ base, user, label, detail, notes, hint: req.hint });
}
