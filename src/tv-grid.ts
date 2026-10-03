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
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BinanceMarket } from "./instrument.js";

export const TV_GRID_SCHEMA = "pineforge-tv-grid/v1";

export interface TvGrid {
  schema: string;
  source: { schema: string; generated_utc: string; sha256: string; venues: Record<string, string> };
  counts: Record<BinanceMarket, number>;
  content_sha256: string;
  spot: Record<string, number>;
  usdt_perp: Record<string, number>;
}

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
  return g;
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

/** When the table was measured, as UTC text ("2026-10-03"), or "unknown". */
export function tvGridDate(): string {
  return tvGrid().grid?.source.generated_utc.slice(0, 10) ?? "unknown";
}
