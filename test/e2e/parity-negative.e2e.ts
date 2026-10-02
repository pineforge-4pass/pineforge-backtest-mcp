/**
 * stdio E2E, negative cases and export formats for check_tradingview_parity.
 * Same env as parity-stdio.e2e.ts; run the server with a short
 * PINEFORGE_PARITY_TIMEOUT_MS (e.g. 60000) for the infinite-loop case.
 *
 * Run: node --import tsx --test test/e2e/parity-negative.e2e.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildXlsx, tradesSheetFromCsv } from "../fixtures/parity/xlsx.js";
import { parseCsv, toCsv } from "../../src/parity/csv.js";
import { callParity, connect, pathMapper, type CallOutcome } from "./client.js";
import { env, listProbes, probeCall, type Probe } from "./corpus.js";

const SMALL = "risk-max-contracts-held-gate-pyramid-01"; // 5 trades
const LARGER = "ta-sma-152-close-cross-01";

let client: Client;
let probes: Map<string, Probe>;
let feed15: string;
let feed1: string;
const map = pathMapper();

before(async () => {
  probes = new Map(listProbes(env("PF_E2E_CORPUS")).map((p) => [p.slug, p]));
  feed15 = env("PF_E2E_FEED_15M");
  feed1 = env("PF_E2E_FEED_1M");
  client = await connect();
});

after(async () => {
  await client?.close();
});

function args(slug: string): Record<string, unknown> {
  return probeCall(probes.get(slug)!, feed15, feed1, map).args;
}

function report(name: string, out: CallOutcome): void {
  const d = out.data ?? {};
  console.log(`--- ${name}: isError=${out.isError} ok=${d.ok} tier=${d.tier ?? "-"} error=${d.error ?? "-"}`);
  console.log(out.text.split("\n").slice(0, 40).join("\n"));
}

/** The trade list with one row's price column changed by `factor`. */
function movePrice(csv: string, trade: string, kind: "Entry" | "Exit", factor: number): string {
  const rows = parseCsv(csv.replace(/^﻿/, ""));
  const h = rows[0]!;
  const iPrice = h.findIndex((c) => c.startsWith("Price"));
  const row = rows.find((r) => r[0] === trade && r[1]!.startsWith(kind))!;
  row[iPrice] = (Number(row[iPrice]) * factor).toFixed(2);
  return toCsv(rows);
}

async function stillServes(): Promise<void> {
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "check_tradingview_parity"), "server stopped answering");
}

test("baseline: the small probe is excellent", async () => {
  const out = await callParity(client, args(SMALL));
  report("baseline", out);
  assert.equal(out.data?.tier, "excellent");
});

test("one TradingView exit price moved 1% lowers the tier and lists that trade", async () => {
  const a = args(SMALL);
  a.tradingview_trades = movePrice(String(a.tradingview_trades), "3", "Exit", 1.01);
  const out = await callParity(client, a);
  report("exit +1%", out);
  assert.equal(out.data?.ok, true);
  assert.notEqual(out.data?.tier, "excellent");
  const mm = out.data?.mismatches as Array<Record<string, any>>;
  assert.ok(mm.some((m) => m.kind === "deviating_pair" && m.tradingview?.trade === 3), "trade 3 not listed");
});

test("a dropped trade shows as unmatched", async () => {
  const a = args(SMALL);
  const rows = parseCsv(String(a.tradingview_trades).replace(/^﻿/, ""));
  a.tradingview_trades = toCsv(rows.filter((r, i) => i === 0 || r[0] !== "2"));
  const out = await callParity(client, a);
  report("dropped trade 2", out);
  assert.equal(out.data?.ok, true);
  assert.equal(out.data?.unmatched_pineforge, 1);
  const mm = out.data?.mismatches as Array<Record<string, any>>;
  assert.ok(mm.some((m) => m.kind === "unmatched_pineforge" && String(m.pineforge?.entry_time).startsWith("2025-03-31 09:15")));
});

test("a chart timezone 8 h off is reported, not absorbed", async () => {
  const a = args(LARGER);
  a.chart_timezone = "UTC";
  const out = await callParity(client, a);
  report("timezone UTC (8 h off)", out);
  assert.equal(out.data?.ok, true);
  assert.notEqual(out.data?.tier, "excellent");
  const tz = out.data?.timezone as Record<string, any>;
  assert.ok(tz?.better || tz?.note, "no timezone finding");
  assert.match(out.text, /Timezone:/);
});

test("a chart timezone 1 h off is reported, not absorbed", async () => {
  const a = args(LARGER);
  a.chart_timezone = "Asia/Tokyo";
  const out = await callParity(client, a);
  report("timezone Asia/Tokyo (1 h off)", out);
  assert.equal(out.data?.ok, true);
  const tz = out.data?.timezone as Record<string, any>;
  assert.ok(tz?.note || tz?.better, "the 1 h offset was not reported");
  assert.match(out.text, /Timezone: /);
});

test("a malformed trade list gets a plain error", async () => {
  const a = args(SMALL);
  a.tradingview_trades = "Trade number,Type,When,Price USDT\n1,Entry long,yesterday,10\n";
  const out = await callParity(client, a);
  report("malformed CSV", out);
  assert.equal(out.isError, true);
  assert.equal(out.data?.error, "bad_trades_csv");
  assert.match(String(out.data?.message), /missing 'Date and time'/);
  await stillServes();
});

test("a symbol with no bars source asks for bars", async () => {
  const a = args(SMALL);
  delete a.ohlcv_csv_path;
  a.symbol = "NASDAQ:AAPL";
  const out = await callParity(client, a);
  report("NASDAQ:AAPL without bars", out);
  assert.equal(out.isError, true);
  assert.equal(out.data?.error, "no_bars");
  assert.match(String(out.data?.message), /NASDAQ:AAPL has no bars source.*ohlcv_csv/);
  await stillServes();
});

test("an infinite loop is stopped with a timeout error", async () => {
  const a = args(SMALL);
  a.pine = [
    "//@version=6",
    'strategy("loop forever", overlay = true)',
    "var int n = 0",
    "while true",
    "    n += 1",
    "if n > 0",
    '    strategy.entry("L", strategy.long)',
  ].join("\n");
  const t0 = Date.now();
  const out = await callParity(client, a);
  report(`infinite loop (${Math.round((Date.now() - t0) / 1000)} s)`, out);
  assert.equal(out.isError, true);
  assert.equal(out.data?.error, "timeout");
  await stillServes();
});

test("a huge allocation fails with a plain error", async () => {
  const a = args(SMALL);
  a.pine = [
    "//@version=6",
    'strategy("allocate", overlay = true)',
    "var a = array.new_float(1000000000000, 0.0)",
    "if array.size(a) > 0",
    '    strategy.entry("L", strategy.long)',
  ].join("\n");
  const out = await callParity(client, a);
  report("huge allocation", out);
  assert.equal(out.isError, true);
  assert.ok(["backtest", "compile", "transpile", "timeout"].includes(String(out.data?.error)), String(out.data?.error));
  await stillServes();
});

test("the XLSX report grades exactly like the CSV it came from", async () => {
  const a = args(SMALL);
  const fromCsv = await callParity(client, a);
  const b = { ...a, tradingview_trades: buildXlsx([tradesSheetFromCsv(String(a.tradingview_trades))]).toString("base64") };
  const fromXlsx = await callParity(client, b);
  report("xlsx", fromXlsx);
  const pick = (o: CallOutcome) => {
    const d = { ...(o.data ?? {}) };
    delete d.export;
    return d;
  };
  assert.equal(fromXlsx.data?.ok, true);
  assert.deepEqual(pick(fromXlsx), pick(fromCsv));
});

test("after all of that the server still grades", async () => {
  const out = await callParity(client, args(SMALL));
  assert.equal(out.data?.tier, "excellent");
});
