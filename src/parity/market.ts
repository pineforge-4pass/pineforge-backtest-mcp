/**
 * Tickers, timeframes, timezones and the time span of a trade list.
 * Intl only (no node: imports): runs in Node 20+ and a Cloudflare Worker.
 */

import { ParityInputError } from "./errors.js";
import { parseCsv } from "./csv.js";

// ─── Ticker ───────────────────────────────────────────────────────────────

export interface Ticker {
  /** As given, upper-cased: "BINANCE:ETHUSDT.P". */
  ticker: string;
  /** "BINANCE", or null when the ticker has no exchange prefix. */
  exchange: string | null;
  /** "ETHUSDT" (without the .P suffix). */
  symbol: string;
  /** TradingView's ".P" suffix: a perpetual swap. */
  perpetual: boolean;
}

export function parseTicker(raw: string): Ticker {
  const s = raw.trim().toUpperCase();
  const m = /^(?:([A-Z0-9_]+):)?([A-Z0-9_!./-]+?)(\.P)?$/.exec(s);
  if (!m || !m[2]) {
    throw new ParityInputError(
      "bad_symbol",
      `'${raw}' is not a TradingView ticker; use the form EXCHANGE:SYMBOL, e.g. BINANCE:ETHUSDT.P.`,
    );
  }
  return { ticker: s, exchange: m[1] ?? null, symbol: m[2], perpetual: m[3] === ".P" };
}

// ─── Timeframe ────────────────────────────────────────────────────────────

/**
 * TradingView resolution in its own spelling: minutes as a number ("1", "15",
 * "240"), seconds with S ("30S"), and "1D", "1W", "1M" (with a multiplier).
 * Also accepts "15m", "1h", "4 hours", "D", "1 day".
 */
export function normalizeTimeframe(raw: string): string {
  const s = raw.trim();
  const m = /^(\d+)?\s*([a-zA-Z]*)$/.exec(s);
  if (!m || (!m[1] && !m[2])) throw badTimeframe(raw);
  const n = m[1] ? Number(m[1]) : 1;
  if (!Number.isInteger(n) || n <= 0) throw badTimeframe(raw);
  // TradingView's "M" is a month; a lower-case "m" (15m) is read as minutes.
  if (m[2] === "M") return `${n}M`;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "" || unit === "m" || unit === "min" || unit === "mins" || unit === "minute" || unit === "minutes") {
    return String(n);
  }
  if (unit === "s" || unit === "sec" || unit === "secs" || unit === "second" || unit === "seconds") return `${n}S`;
  if (unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours") return String(n * 60);
  if (unit === "d" || unit === "day" || unit === "days") return `${n}D`;
  if (unit === "w" || unit === "wk" || unit === "week" || unit === "weeks") return `${n}W`;
  if (unit === "mo" || unit === "month" || unit === "months") return `${n}M`;
  throw badTimeframe(raw);
}

function badTimeframe(raw: string): ParityInputError {
  return new ParityInputError(
    "bad_timeframe",
    `'${raw}' is not a TradingView timeframe; use its resolution, e.g. 1, 5, 15, 60, 240, 1D, 1W.`,
  );
}

/** Bar length in ms for a normalized timeframe (months as 30 days). */
export function timeframeMs(tf: string): number {
  const m = /^(\d+)([SDWM]?)$/.exec(tf);
  if (!m) throw badTimeframe(tf);
  const n = Number(m[1]);
  switch (m[2]) {
    case "S": return n * 1_000;
    case "D": return n * 86_400_000;
    case "W": return n * 7 * 86_400_000;
    case "M": return n * 30 * 86_400_000;
    default: return n * 60_000;
  }
}

// ─── Timezone ─────────────────────────────────────────────────────────────

/**
 * The canonical IANA id for a timezone name, checked with Intl. "UTC+8" and
 * "UTC-5" become "Etc/GMT-8" / "Etc/GMT+5" (IANA inverts the sign). TradingView's
 * "Exchange" setting depends on the symbol and is not guessed.
 */
export function canonicalTimezone(raw: string): string {
  const s = raw.trim();
  if (/^exchange$/i.test(s)) {
    throw new ParityInputError(
      "bad_timezone",
      "chart_timezone 'Exchange' depends on the symbol; pass the IANA name of the timezone your chart showed, e.g. Asia/Taipei or America/New_York.",
    );
  }
  if (/^(utc|gmt|z|etc\/utc|etc\/gmt)$/i.test(s)) return "UTC";
  const off = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
  if (off) {
    const h = Number(off[2]);
    const mins = off[3] ? Number(off[3]) : 0;
    if (mins !== 0 || h > 14) {
      throw new ParityInputError(
        "bad_timezone",
        `'${raw}' has no fixed-offset IANA zone; pass a city zone with that offset, e.g. Asia/Kolkata for UTC+5:30.`,
      );
    }
    if (h === 0) return "UTC";
    return `Etc/GMT${off[1] === "+" ? "-" : "+"}${h}`;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    throw new ParityInputError(
      "bad_timezone",
      `'${raw}' is not an IANA timezone; pass the name your chart showed its times in, e.g. Asia/Taipei, Europe/London, UTC.`,
    );
  }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function wallParts(ms: number, tz: string): number[] {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return [out.year!, out.month!, out.day!, out.hour!, out.minute!, out.second!];
}

/** Offset of `tz` from UTC at instant `ms`, in ms (Asia/Taipei: +8 h). */
export function tzOffsetMs(ms: number, tz: string): number {
  const [y, mo, d, h, mi, s] = wallParts(ms, tz);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The instant of a wall-clock time in `tz` (the earlier one in a DST overlap). */
export function wallToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffsetMs(guess, tz);
  const t2 = guess - tzOffsetMs(t, tz);
  if (t2 !== t) t = Math.min(t, t2);
  return t;
}

/** "YYYY-MM-DD HH:MM" wall clock of instant `ms` in `tz`. */
export function formatWall(ms: number, tz: string): string {
  const [y, mo, d, h, mi] = wallParts(ms, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo!)}-${p(d!)} ${p(h!)}:${p(mi!)}`;
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

export function parseWall(s: string, tz: string): number | null {
  const m = WALL_RE.exec(s.trim());
  if (!m) return null;
  return wallToUtcMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
}

/**
 * ISO 8601 date or datetime to epoch ms; UTC when no offset is given.
 * "2025-04-01", "2025-04-01T08:00", "2025-04-01 08:00:00Z", "2025-04-01T08:00+08:00".
 */
export function parseIsoUtc(raw: string, field: string): number {
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) {
    throw new ParityInputError(
      "bad_range",
      `${field} '${raw}' is not an ISO 8601 date or datetime (e.g. 2025-04-01 or 2025-04-01T08:00:00Z).`,
    );
  }
  let ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), Number((m[7] ?? "0").padEnd(3, "0")),
  );
  const z = m[8];
  if (z && z.toUpperCase() !== "Z") {
    const sign = z[0] === "-" ? -1 : 1;
    const digits = z.slice(1).replace(":", "");
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  if (!Number.isFinite(ms)) {
    throw new ParityInputError("bad_range", `${field} '${raw}' is not a valid date.`);
  }
  return ms;
}

// ─── Export span ──────────────────────────────────────────────────────────

export interface ExportSpan {
  /** Closed trades (trade numbers with an entry and an exit row). */
  trades: number;
  firstEntryMs: number;
  lastRowMs: number;
  firstEntry: string;
  lastRow: string;
}

/**
 * First entry and last row of a canonical trade list, as instants (the list's
 * wall-clock times read in `tz`): the data window a run needs.
 */
export function exportSpan(csv: string, tz: string): ExportSpan {
  const rows = parseCsv(csv.replace(/^﻿/, ""));
  const header = rows[0] ?? [];
  const iNum = header.findIndex((h) => h === "Trade #" || h === "Trade number");
  const iType = header.indexOf("Type");
  const iTime = header.indexOf("Date and time");
  let firstEntry = "";
  let firstEntryMs = Infinity;
  let lastRow = "";
  let lastRowMs = -Infinity;
  const entries = new Set<string>();
  const exits = new Set<string>();
  for (const r of rows.slice(1)) {
    const t = r[iTime] ?? "";
    const ms = parseWall(t, tz);
    if (ms === null) continue;
    const kind = r[iType] ?? "";
    const num = r[iNum] ?? "";
    if (kind.startsWith("Entry")) {
      entries.add(num);
      if (ms < firstEntryMs) { firstEntryMs = ms; firstEntry = t; }
    } else {
      exits.add(num);
    }
    if (ms > lastRowMs) { lastRowMs = ms; lastRow = t; }
  }
  let trades = 0;
  for (const n of entries) if (exits.has(n)) trades++;
  if (!Number.isFinite(firstEntryMs) || !Number.isFinite(lastRowMs)) {
    throw new ParityInputError("no_closed_trades", "The trade list has no entry rows with a readable date.");
  }
  return { trades, firstEntryMs, lastRowMs, firstEntry, lastRow };
}
