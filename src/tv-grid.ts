/**
 * TradingView's own lot size (`syminfo.mincontract`) for Binance symbols.
 *
 * Binance's `LOT_SIZE.stepSize` is not what TradingView reports: on a measurement of
 * every Binance symbol TradingView lists it differs for 1,188 of 1,366 spot symbols and
 * 510 of 523 USD-M ones, and TradingView's own default is 0.001 (90.6% of spot, 97.5%
 * of USD-M), so the exchange step floors an order differently from TradingView's.
 * The measured values ship in src/tv-grid.generated.json, written by
 * `node scripts/sync-tv-grid.mjs <tv-grid-table.json>` (see the README maintenance
 * note); they are looked up here by market and native symbol, nothing is inferred.
 *
 * Besides the readings the table says, per market, which Binance symbols TradingView does not
 * list (`not_on_tv`) and, where at least 80% of the readings agree, TradingView's usual lot size
 * (`defaults`): what a listing newer than the readings most likely reads. A table written before
 * those two sections still loads; it simply has neither.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BinanceMarket } from "./instrument.js";

export const TV_GRID_SCHEMA = "pineforge-tv-grid/v1";

/** TradingView's usual lot size on a market, with the share of the readings that are it and how many readings that is. */
export interface TvDefault {
  mincontract: number;
  share: number;
  n: number;
}

export interface TvGrid {
  schema: string;
  source: { schema: string; generated_utc: string; sha256: string; venues: Record<string, string> };
  counts: Record<BinanceMarket, number>;
  content_sha256: string;
  spot: Record<string, number>;
  usdt_perp: Record<string, number>;
  /** Per market, the symbols the exchange lists and TradingView does not. Absent in a table that predates it. */
  not_on_tv?: Partial<Record<BinanceMarket, string[]>>;
  /** Per market, TradingView's usual lot size, only where at least 80% of the readings are it. Absent in a table that predates it. */
  defaults?: Partial<Record<BinanceMarket, TvDefault>>;
}

/** The share of a market's readings that must agree before their value is called TradingView's usual one (sync-tv-grid.mjs applies the same line). */
export const TV_DEFAULT_MIN_SHARE = 0.8;
const MARKETS: readonly BinanceMarket[] = ["spot", "usdt_perp"];

/** src/tv-grid.generated.json at the package root (npm `files` and the Docker image ship it). */
export function tvGridPath(): string {
  return process.env.PINEFORGE_TV_GRID ?? fileURLToPath(new URL("../src/tv-grid.generated.json", import.meta.url));
}

/** Parse and check a generated table; throws on anything that is not one. */
export function parseTvGrid(text: string): TvGrid {
  const g = JSON.parse(text) as TvGrid;
  const isMap = (m: unknown): m is Record<string, number> =>
    typeof m === "object" && m !== null && !Array.isArray(m) && Object.keys(m).length > 0 &&
    Object.values(m).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 1e-12 && v <= 1e12);
  if (g?.schema !== TV_GRID_SCHEMA) throw new Error(`not a ${TV_GRID_SCHEMA} file`);
  if (!isMap(g.spot) || !isMap(g.usdt_perp)) throw new Error("the spot or usdt_perp map is missing, empty or holds a bad value");
  if (typeof g.source?.generated_utc !== "string" || !/^[0-9a-f]{64}$/.test(String(g.source?.sha256))) {
    throw new Error("the source block is incomplete");
  }
  checkNotOnTv(g.not_on_tv);
  checkDefaults(g.defaults);
  // A usual lot size without the list of unlisted symbols would give a symbol TradingView does not list the "new listing" default.
  if (g.defaults !== undefined && g.not_on_tv === undefined) throw new Error("defaults without not_on_tv");
  return g;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `not_on_tv`, when the table has it: an object whose market entries are lists of symbols. */
function checkNotOnTv(section: unknown): void {
  if (section === undefined) return;
  if (!isObject(section)) throw new Error("not_on_tv is not an object of symbol lists");
  for (const m of MARKETS) {
    const list = section[m];
    if (list !== undefined && !(Array.isArray(list) && list.every((s) => typeof s === "string" && /^[\x21-\x7e]{1,64}$/.test(s)))) {
      throw new Error(`not_on_tv.${m} is not a list of symbols`);
    }
  }
}

/** `defaults`, when the table has it: per market a lot size in range, a share of at least 0.8 and at most 1, and a count. */
function checkDefaults(section: unknown): void {
  if (section === undefined) return;
  if (!isObject(section)) throw new Error("defaults is not an object");
  for (const m of MARKETS) {
    const d = section[m];
    if (d === undefined) continue;
    const e = isObject(d) ? d : {};
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (!num(e.mincontract) || e.mincontract < 1e-12 || e.mincontract > 1e12) throw new Error(`defaults.${m} has a bad mincontract`);
    if (!num(e.share) || e.share < TV_DEFAULT_MIN_SHARE || e.share > 1) throw new Error(`defaults.${m} has a bad share`);
    if (!num(e.n) || !Number.isInteger(e.n) || e.n < 1) throw new Error(`defaults.${m} has a bad n`);
  }
}

let loaded: { grid?: TvGrid; error?: string } | undefined;

/** The embedded table, read once; `error` says why there is none. */
export function tvGrid(): { grid?: TvGrid; error?: string } {
  if (!loaded) {
    try {
      loaded = { grid: parseTvGrid(readFileSync(tvGridPath(), "utf8")) };
    } catch (e) {
      loaded = { error: `the embedded TradingView lot-size table cannot be read (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  return loaded;
}

/** Forget the table read so far (the tests point PINEFORGE_TV_GRID elsewhere). */
export function resetTvGrid(): void {
  loaded = undefined;
}

/** TradingView's lot size of a Binance symbol in a market, or undefined when the table has none. */
export function tvLotStep(market: BinanceMarket, symbol: string): number | undefined {
  const map = tvGrid().grid?.[market];
  const key = symbol.toUpperCase();
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Whether the table says TradingView does not list this symbol on that Binance market (never, for a table without the list). */
export function tvNotListed(market: BinanceMarket, symbol: string): boolean {
  return tvGrid().grid?.not_on_tv?.[market]?.includes(symbol.toUpperCase()) === true;
}

/** TradingView's usual lot size on a market, when the table has one (at least 80% of its readings are it). */
export function tvDefaultLot(market: BinanceMarket): TvDefault | undefined {
  return tvGrid().grid?.defaults?.[market];
}

