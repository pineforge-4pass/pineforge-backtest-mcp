/**
 * stdio E2E for check_tradingview_parity and the instrument: a real MCP client spawns the server and
 * grades a TradingView export against PineForge through the real engine image: BTCUSDT 4h, an SMA 5/20
 * crossover, long only, 100% of equity, 0.1% commission, 62 TradingView trades (61 closed ones and the
 * range-end mark). Without an instrument the engine books 18 sub-lot margin-call rows TradingView does not
 * and sizes its orders without a lot grid; the grader's pairing (direction, entry within an hour, price
 * within $3) still pairs all 62, so the tier is excellent either way. With BINANCE:BTCUSDT's lot size
 * (TradingView's 0.00001) every paired quantity equals TradingView's exactly and the engine books 62 rows.
 * The one deviating pair is the range-end mark: the frozen feed ends one bar before TradingView's range.
 *
 *   PF_E2E_SYMINFO_CSV    the frozen 2188-bar BTCUSDT 4h feed (as syminfo-stdio.e2e.ts)
 *   PF_E2E_PARITY_PINE    the Pine file (default test/fixtures/syminfo/minimal-long.pine)
 *   PF_E2E_PARITY_TRADES  TradingView's List of trades CSV for it (default test/fixtures/syminfo/minimal-long-tv-trades.csv)
 *   PF_E2E_SERVER, PF_E2E_DOCKER_IMAGE, PF_E2E_MOUNT, PF_E2E_PATH_MAP, PF_E2E_STUB_PORT: as syminfo-stdio.e2e.ts
 *   PF_E2E_PARITY_OUT     write the two results (JSON) here
 *
 * Run: node --import tsx --test test/e2e/parity-instrument.e2e.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callParity, connect, pathMapper } from "./client.js";

const here = (rel: string) => new URL(rel, import.meta.url);
const SPOT_INFO = readFileSync(here("../fixtures/binance/spot-exchangeinfo.json"), "utf8");
const CSV_PATH = process.env.PF_E2E_SYMINFO_CSV;
const PINE = readFileSync(process.env.PF_E2E_PARITY_PINE ?? here("../fixtures/syminfo/minimal-long.pine"), "utf8");
const TRADES = readFileSync(process.env.PF_E2E_PARITY_TRADES ?? here("../fixtures/syminfo/minimal-long-tv-trades.csv"), "utf8");
const map = pathMapper();

let stub: Server;
let client: Client;
const stubHits: string[] = [];

before(async () => {
  assert.ok(CSV_PATH, "PF_E2E_SYMINFO_CSV must name the frozen 2188-bar BTCUSDT 4h feed");
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    stubHits.push(url.pathname);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v3/exchangeInfo") res.end(SPOT_INFO);
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((ok) => stub.listen(Number(process.env.PF_E2E_STUB_PORT ?? 0), "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  const image = process.env.PF_E2E_DOCKER_IMAGE;
  const env = { PINEFORGE_BINANCE_SPOT_URL: url, PINEFORGE_BINANCE_FAPI_URL: url };
  client = image
    ? await connect({
        argv: ["docker", "run", "-i", "--rm", "--network", "host", "--user", `${process.getuid!()}:${process.getgid!()}`,
          "-v", `${process.env.PF_E2E_MOUNT}:/work`, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), image],
      })
    : await connect({ env });
});

after(async () => {
  await client?.close();
  await new Promise<void>((ok) => (stub ? stub.close(() => ok()) : ok()));
});

const args = (extra: Record<string, unknown> = {}) => ({
  pine: PINE, tradingview_trades: TRADES, timeframe: "240", range_start: "2025-10-04T00:00:00Z",
  chart_timezone: "Asia/Taipei", ohlcv_csv_path: map(CSV_PATH!), max_mismatches: 50, ...extra,
});
const results: Record<string, unknown> = {};

const summary = (d: Record<string, any>) =>
  `tier ${d.tier}, matched ${d.matched}, TradingView-only ${d.unmatched_tradingview}, PineForge-only ${d.unmatched_pineforge}`;

const lastPair = (d: Record<string, any>) => d.mismatches[0] as { kind: string; tradingview: { trade: number }; pineforge: { trade: number; qty: number } };

test("BASELINE: no symbol, no sidecar: no lot size, a warning; the grader still pairs 62 of 62 but PineForge's sizes are unfloored", async () => {
  const r = await callParity(client, args());
  assert.equal(r.isError, false, r.text.slice(0, 600));
  const d = r.data!;
  results.baseline = d;
  console.log(`baseline: ${summary(d)}; qty p100 ${(d.metrics as any).qty_p100}; last pair PineForge trade ${lastPair(d).pineforge.trade}`);
  assert.equal((d.applied_instrument as Record<string, unknown>).resolved, false);
  assert.equal((d.applied_instrument as Record<string, unknown>).reason, "no symbol, syminfo or sidecar was given");
  const warnings = d.warnings as string[];
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0]!, /^instrument grid unavailable for btcusdt-4h\.csv \(no symbol, syminfo or sidecar was given\): order quantity is not floored to a lot size/);
  assert.match(r.text, /\nInstrument: no lot size \(no symbol, syminfo or sidecar was given\), so order quantity is not floored\n/);
  assert.deepEqual([d.tier, d.matched, d.unmatched_tradingview, d.unmatched_pineforge], ["excellent", 62, 0, 0]);
  // what the missing grid does show: PineForge's own sizes are not TradingView's, and it books 18 more rows
  assert.ok(Number((d.metrics as any).qty_p100) > 1e-5, `qty p100 ${(d.metrics as any).qty_p100}`);
  assert.equal(lastPair(d).pineforge.trade, 80);
});

test("GRID: BINANCE:BTCUSDT: TradingView's lot size 0.00001 is applied; every paired quantity equals TradingView's", async () => {
  const r = await callParity(client, args({ symbol: "BINANCE:BTCUSDT" }));
  assert.equal(r.isError, false, r.text.slice(0, 600));
  const d = r.data!;
  results.grid = d;
  console.log(`grid: ${summary(d)}; qty p100 ${(d.metrics as any).qty_p100}; last pair PineForge trade ${lastPair(d).pineforge.trade}`);
  assert.deepEqual(d.applied_instrument, {
    schema: "pineforge-instrument/v1", resolved: true, qty_step: 0.00001, mincontract: 0.00001, mintick: 0.01,
    pointvalue: 1, type: "crypto", currency: "USDT", basecurrency: "BTC",
    source: { kind: "tradingview", venue: "binance_spot", symbol: "BTCUSDT" },
  });
  assert.deepEqual(d.warnings, []);
  assert.match(r.text, /\nInstrument: BTCUSDT spot: lot size 0\.00001 \(TradingView's\), tick 0\.01, point value 1\.\n/);
  assert.ok(stubHits.includes("/api/v3/exchangeInfo"));
  assert.deepEqual([d.tier, d.matched, d.unmatched_tradingview, d.unmatched_pineforge], ["excellent", 62, 0, 0]);
  // the 61 closed trades are identical (only the range-end mark deviates), and every quantity is TradingView's
  assert.equal((d.mismatches as unknown[]).length, 1);
  assert.deepEqual([lastPair(d).kind, lastPair(d).tradingview.trade], ["deviating_pair", 62]);
  assert.equal((d.metrics as any).qty_p100, 0);
  assert.equal(lastPair(d).pineforge.qty, 0.10238);
  // and the engine books 62 rows, not 80
  assert.equal(lastPair(d).pineforge.trade, 62);
  assert.ok(lastPair(d).pineforge.trade < lastPair(results.baseline as Record<string, any>).pineforge.trade);
});

test("results are kept for the report", () => {
  if (process.env.PF_E2E_PARITY_OUT) writeFileSync(process.env.PF_E2E_PARITY_OUT, JSON.stringify(results, null, 1));
});
