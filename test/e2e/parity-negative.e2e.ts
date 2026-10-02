/**
 * stdio E2E, negative cases and export formats for check_tradingview_parity.
 * Same env as parity-stdio.e2e.ts; run the server with a short
 * PINEFORGE_PARITY_TIMEOUT_MS (e.g. 60000) for the infinite-loop case.
 *
 * Run: node --import tsx --test test/e2e/parity-negative.e2e.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildXlsx, tradesSheetFromCsv, zip } from "../fixtures/parity/xlsx.js";
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
  const lines = out.formatted.split("\n");
  // Long mismatch listings are cut to their first entries; the rest of the text is kept.
  const cut = lines.findIndex((l) => /^4\. /.test(l));
  const end = cut < 0 ? -1 : lines.findIndex((l, i) => i > cut && (l === "" || /^(Timezone|Window|Warnings):/.test(l)));
  console.log((cut >= 0 && end > cut ? [...lines.slice(0, cut), "   ...", ...lines.slice(end)] : lines).join("\n"));
  if (d.timezone) console.log(`timezone: ${JSON.stringify(d.timezone)}`);
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

test("an input named like a grader key is refused", async () => {
  const a = args(SMALL);
  a.inputs = { expected_tier: "excellent" };
  const out = await callParity(client, a);
  report("input expected_tier", out);
  assert.equal(out.isError, true);
  assert.equal(out.data?.error, "reserved_input_name");
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
  // Equal but for the export block and the XLSX's own note that it has no Properties sheet.
  const pick = (o: CallOutcome) => {
    const d = { ...(o.data ?? {}) };
    delete d.export;
    d.warnings = (d.warnings as string[]).filter((w) => !w.includes('no "Properties" sheet'));
    return d;
  };
  assert.equal(fromXlsx.data?.ok, true);
  assert.deepEqual(pick(fromXlsx), pick(fromCsv));
});

const WINDOWED = "ta-dmi-adx-di-cross-01"; // range start 2025-04-05: a year of 15m bars

function sansSource(o: CallOutcome): Record<string, unknown> {
  const d = { ...(o.data ?? {}) };
  delete d.bars_source;
  delete d.export;
  return d;
}

test("bars in TradingView's chart-export format grade like the engine CSV", async () => {
  const a = args(WINDOWED);
  const fromEngine = await callParity(client, a);
  const startMs = Date.parse(String(a.range_start));
  const lines = readFileSync(feed15, "utf8").split("\n").slice(1).filter(Boolean)
    .filter((l) => Number(l.split(",")[0]) >= startMs);
  const tv = ["time,open,high,low,close,Volume", ...lines.map((l) => {
    const [t, ...rest] = l.split(",");
    return [Number(t) / 1000, ...rest].join(",");
  })].join("\n") + "\n";
  const dir = mkdtempSync(join(tmpdir(), "e2e-parity-tvbars-"));
  const path = join(dir, "tv-chart-export.csv");
  writeFileSync(path, tv);
  const fromTv = await callParity(client, { ...a, ohlcv_csv_path: map(path) });
  report("TradingView chart-export bars", fromTv);
  assert.equal(fromTv.data?.ok, true);
  assert.match(String(fromTv.data?.bars_source), /TradingView chart export, converted/);
  assert.deepEqual(sansSource(fromTv), sansSource(fromEngine));
});

test("without bars, BINANCE:ETHUSDT.P is fetched from Binance's public API", async () => {
  const a = args(WINDOWED);
  delete a.ohlcv_csv_path;
  const out = await callParity(client, a);
  report("bars fetched from Binance", out);
  assert.equal(out.data?.ok, true, out.text.slice(0, 300));
  assert.match(String(out.data?.bars_source), /^Binance USDT-M perpetual ETHUSDT 15m klines/);
  assert.ok(Number(out.data?.matched) > 0);
  console.log(`Binance-fetched bars: tier ${out.data?.tier} (published ${probes.get(WINDOWED)!.expectedTier} on the corpus feed)`);
});

test("no trade lines up: minimal, with the trade counts the grader measured", async () => {
  const a = args(SMALL);
  const rows = parseCsv(String(a.tradingview_trades).replace(/^\uFEFF/, ""));
  const iPrice = rows[0]!.findIndex((c) => c.startsWith("Price"));
  for (const r of rows.slice(1)) r[iPrice] = (Number(r[iPrice]) + 1000).toFixed(2);
  a.tradingview_trades = toCsv(rows);
  const out = await callParity(client, a);
  report("prices +1000 (nothing lines up)", out);
  assert.equal(out.data?.tier, "minimal");
  const checks = out.data?.checks as Array<Record<string, any>>;
  assert.equal(checks[0]!.tradingview, 5);
  assert.equal(checks[0]!.pineforge, 5);
  assert.ok(checks.slice(1).every((c) => c.value === null), JSON.stringify(checks));
  assert.match(out.formatted, /\| trade count \| TradingView 5, PineForge 5 Δ 0 \|/);
});

test("a non-finite P&L is refused before any run, as a plain error", async () => {
  const a = args(SMALL);
  const rows = parseCsv(String(a.tradingview_trades).replace(/^\uFEFF/, ""));
  const iPnl = rows[0]!.findIndex((c) => c.startsWith("Net PnL") && !c.endsWith("%"));
  rows[1]![iPnl] = "NaN";
  a.tradingview_trades = toCsv(rows);
  const out = await callParity(client, a);
  report("NaN P&L", out);
  assert.equal(out.data?.error, "bad_trades_csv");
  assert.match(String(out.data?.message), /is not a finite number/);
  await stillServes();
});

test("a sparse-coordinate XLSX gets a typed error over stdio and the server keeps serving", async () => {
  const a = args(SMALL);
  a.tradingview_trades = zip([
    { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="List of trades" r:id="rId1"/></sheets></workbook>') },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row r="1"><c r="ZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>') },
  ]).toString("base64");
  const out = await callParity(client, a);
  report("XLSX cell ZZZZZ1", out);
  assert.equal(out.data?.error, "bad_trades_csv");
  await stillServes();
});

test("a cwd-scoped server refuses bars paths that leave its cwd ('..', symlink)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "e2e-parity-scope-"));
  const { symlinkSync } = await import("node:fs");
  symlinkSync(feed15, join(cwd, "link.csv"));
  const argv = (JSON.parse(process.env.PF_E2E_SERVER ?? '["node","dist/index.js"]') as string[])
    .map((x) => (x === "dist/index.js" ? resolve("dist/index.js") : x));
  const scoped = await connect({ env: { PINEFORGE_ALLOW_ANYWHERE: "0" }, cwd, argv });
  try {
    const a = args(SMALL);
    for (const p of [`${cwd}/${"../".repeat(cwd.split("/").length)}${feed15.slice(1)}`, join(cwd, "link.csv")]) {
      const out = await callParity(scoped, { ...a, ohlcv_csv_path: p });
      report(`scoped server, ${p}`, out);
      assert.equal(out.data?.error, "no_bars");
      assert.match(String(out.data?.message), /outside cwd/);
    }
  } finally {
    await scoped.close();
  }
});

test("after all of that the server still grades", async () => {
  const out = await callParity(client, args(SMALL));
  assert.equal(out.data?.tier, "excellent");
});
