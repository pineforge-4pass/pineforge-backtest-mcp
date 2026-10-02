import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import {
  ParityInputError,
  readTradingViewExport,
  parseCsv,
  parseTicker,
  normalizeTimeframe,
  canonicalTimezone,
  wallToUtcMs,
  formatWall,
  parseIsoUtc,
  exportSpan,
  excelSerialToWall,
  settingsFromProperties,
  formatParityResult,
  RETENTION_LOCAL,
  resolveSettings,
  type InflateFn,
} from "../src/parity/index.js";
import { buildXlsx, reportXlsx, tradesSheetFromCsv, zip, SAMPLE_PROPERTIES } from "./fixtures/parity/xlsx.js";

const inflate: InflateFn = (data, max) => new Uint8Array(inflateRawSync(data, { maxOutputLength: max }));
const CSV = readFileSync(new URL("./fixtures/parity/tv_trades.csv", import.meta.url), "utf8");

async function inputError(p: Promise<unknown>, kind: string, re: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ParityInputError, `not a ParityInputError: ${String(e)}`);
    assert.equal(e.kind, kind);
    assert.match(e.message, re);
    return true;
  });
}

// The values parse_trades reads: numbers compare as floats, the rest as text.
function sameGraderValues(a: string, b: string): void {
  const ra = parseCsv(a.replace(/^﻿/, ""));
  const rb = parseCsv(b.replace(/^﻿/, ""));
  assert.deepEqual(rb[0], ra[0], "header");
  assert.equal(rb.length, ra.length, "row count");
  const num = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
  for (let i = 1; i < ra.length; i++) {
    ra[i]!.forEach((v, j) => {
      const w = rb[i]![j] ?? "";
      if (num.test(v)) assert.equal(Number(w), Number(v), `row ${i + 1} ${ra[0]![j]}`);
      else assert.equal(w, v, `row ${i + 1} ${ra[0]![j]}`);
    });
  }
}

test("CSV export passes through unchanged with its trade count", async () => {
  const r = await readTradingViewExport(CSV, inflate);
  assert.equal(r.format, "csv");
  assert.equal(r.csv, CSV.replace(/^﻿/, ""));
  assert.equal(r.rows, 10);
  assert.equal(r.closedTrades, 5);
  assert.deepEqual(r.settings, {});
  assert.deepEqual(r.warnings, []);
});

test("CSV missing grader columns names them", async () => {
  const bad = CSV.replace("Date and time", "When").replace("Price USDT", "Cost");
  await inputError(readTradingViewExport(bad, inflate), "bad_trades_csv", /missing 'Date and time', a 'Price' column/);
});

test("older TradingView layout is named as such", async () => {
  const old = "Trade #,Type,Signal,Date/Time,Price USDT,Contracts,Profit USDT\n1,Entry Long,x,2025-01-01 00:00,1,1,0\n";
  await inputError(readTradingViewExport(old, inflate), "bad_trades_csv", /older export layout/);
});

test("CSV row problems point at the row", async () => {
  const lines = CSV.split("\n");
  lines[4] = lines[4]!.replace("2025-03-31 09:15", "31/03/2025 09:15");
  await inputError(readTradingViewExport(lines.join("\n"), inflate), "bad_trades_csv", /Row 5: 'Date and time' is '31\/03\/2025 09:15'/);
  await inputError(readTradingViewExport("hello", inflate), "bad_trades_csv", /empty or not CSV/);
  const price = CSV.replace("1821.59", "n/a");
  await inputError(readTradingViewExport(price, inflate), "bad_trades_csv", /Row 2: price 'n\/a' is not a number/);
});

test("XLSX round trip: a corpus trade list read from the report equals the CSV", async () => {
  const b64 = reportXlsx(CSV).toString("base64");
  assert.ok(b64.startsWith("UEsDB"));
  const r = await readTradingViewExport(b64, inflate);
  assert.equal(r.format, "xlsx");
  assert.equal(r.closedTrades, 5);
  sameGraderValues(CSV, r.csv);
});

test("XLSX round trip on every corpus trade list (PF_E2E_CORPUS set)", { skip: !process.env.PF_E2E_CORPUS }, async () => {
  const root = `${process.env.PF_E2E_CORPUS}/validation`;
  let n = 0;
  for (const slug of readdirSync(root)) {
    let csv: string;
    try { csv = readFileSync(`${root}/${slug}/tv_trades.csv`, "utf8"); } catch { continue; }
    const r = await readTradingViewExport(buildXlsx([tradesSheetFromCsv(csv)]).toString("base64"), inflate);
    sameGraderValues(csv, r.csv);
    n++;
  }
  assert.ok(n > 300, `${n} lists`);
});

test("XLSX Properties become tool settings; strategy inputs are reported, not applied", async () => {
  const r = await readTradingViewExport(reportXlsx(CSV).toString("base64"), inflate);
  assert.deepEqual(r.settings, {
    symbol: "BINANCE:ETHUSDT.P",
    timeframe: "15",
    range_start_wall: "2020-01-01 00:00",
    range_end_wall: "2025-04-01 08:00",
    strategy_overrides: {
      initial_capital: 1000000,
      default_qty_value: 1,
      default_qty_type: "fixed",
      pyramiding: 5,
      commission_value: 0,
      commission_type: "percent",
      slippage: 0,
      process_orders_on_close: false,
    },
    runtime: { bar_magnifier: false },
  });
  assert.deepEqual(r.strategyInputs.map((p) => p.name), ["Max contracts"]);
  assert.ok(r.warnings.some((w) => /1 strategy input\(s\); they are not applied/.test(w)));
});

test("XLSX settings: units, combined fill orders, ambiguous ranges", () => {
  const { settings, warnings } = settingsFromProperties([
    { section: "", name: "Order size", value: "10 % of equity" },
    { section: "", name: "Commission", value: "1.5 USDT per order" },
    { section: "", name: "Fill orders", value: "On bar close: On; Using bar magnifier: On" },
    { section: "", name: "Trading range", value: "2025-04-20 21:00 — 2026-05-04 06:00" },
    { section: "", name: "Backtesting range", value: "2020-01-01 00:00 — 2026-05-04 06:00" },
    { section: "", name: "Slippage", value: "a few" },
  ]);
  assert.deepEqual(settings.strategy_overrides, {
    default_qty_value: 10, default_qty_type: "percent_of_equity",
    commission_value: 1.5, commission_type: "cash_per_order",
    process_orders_on_close: true,
  });
  assert.deepEqual(settings.runtime, { bar_magnifier: true });
  assert.equal(settings.range_start_wall, undefined);
  assert.ok(warnings.some((w) => /pass `range_start`/.test(w)));
  assert.ok(warnings.some((w) => /"Slippage" \(a few\)/.test(w)));
  const cash = settingsFromProperties([{ section: "", name: "Order size", value: "1,000 USDT" }]);
  assert.deepEqual(cash.settings.strategy_overrides, { default_qty_value: 1000, default_qty_type: "cash" });
});

test("XLSX with date strings, no Properties sheet, and a missing List of trades", async () => {
  const rows = parseCsv(CSV.replace(/^﻿/, ""));
  const strings = buildXlsx([{ name: "List of trades", rows }]).toString("base64");
  const r = await readTradingViewExport(strings, inflate);
  sameGraderValues(CSV, r.csv);
  assert.ok(r.warnings.some((w) => /no "Properties" sheet/.test(w)));
  const none = buildXlsx([{ name: "Performance", rows: [["Net profit", 1]] }]).toString("base64");
  await inputError(readTradingViewExport(none, inflate), "bad_trades_csv", /no "List of trades" sheet \(sheets: Performance\)/);
});

test("XLSX decompression is capped", async () => {
  const big = new Uint8Array(4 * 1024 * 1024);
  const bomb = zip([
    { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="List of trades" r:id="rId1"/></sheets></workbook>') },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: "xl/worksheets/sheet1.xml", data: big },
  ]).toString("base64");
  const limits = { maxInputChars: 1e9, maxPartBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxRows: 1000, maxCells: 1000 };
  await inputError(readTradingViewExport(bomb, inflate, limits), "bad_trades_csv", /larger than the 1048576-byte limit/);
  await inputError(readTradingViewExport("UEsDBAAA", inflate), "bad_trades_csv", /not a readable ZIP/);
});

test("excel serials read as wall clock, rounded to the minute", () => {
  assert.equal(excelSerialToWall(45747.34375), "2025-03-31 08:15");
  assert.equal(excelSerialToWall(45747.343749999), "2025-03-31 08:15");
  assert.equal(excelSerialToWall(44285.34375, true), "2025-03-31 08:15");
});

test("tickers", () => {
  assert.deepEqual(parseTicker("BINANCE:ETHUSDT.P"), { ticker: "BINANCE:ETHUSDT.P", exchange: "BINANCE", symbol: "ETHUSDT", perpetual: true });
  assert.deepEqual(parseTicker("binance:btcusdt"), { ticker: "BINANCE:BTCUSDT", exchange: "BINANCE", symbol: "BTCUSDT", perpetual: false });
  assert.deepEqual(parseTicker("NASDAQ:AAPL"), { ticker: "NASDAQ:AAPL", exchange: "NASDAQ", symbol: "AAPL", perpetual: false });
  assert.equal(parseTicker("ETHUSDT").exchange, null);
  assert.throws(() => parseTicker("BINANCE:"), /not a TradingView ticker/);
});

test("timeframes in TradingView's resolution spelling", () => {
  const cases: Array<[string, string]> = [
    ["15", "15"], ["15m", "15"], ["1h", "60"], ["4 hours", "240"], ["240", "240"],
    ["D", "1D"], ["1D", "1D"], ["1 day", "1D"], ["W", "1W"], ["M", "1M"], ["1M", "1M"], ["30S", "30S"],
  ];
  for (const [a, b] of cases) assert.equal(normalizeTimeframe(a), b, a);
  assert.throws(() => normalizeTimeframe("fortnight"), /not a TradingView timeframe/);
});

test("timezones: IANA via Intl, fixed offsets, Exchange refused", () => {
  assert.equal(canonicalTimezone("Asia/Taipei"), "Asia/Taipei");
  assert.equal(canonicalTimezone("asia/taipei"), "Asia/Taipei");
  assert.equal(canonicalTimezone("utc"), "UTC");
  assert.equal(canonicalTimezone("UTC+8"), "Etc/GMT-8");
  assert.equal(canonicalTimezone("UTC-5"), "Etc/GMT+5");
  assert.throws(() => canonicalTimezone("UTC+5:30"), /Asia\/Kolkata/);
  assert.throws(() => canonicalTimezone("Exchange"), (e: unknown) => e instanceof ParityInputError && e.kind === "bad_timezone");
  assert.throws(() => canonicalTimezone("Mars/Olympus"), /not an IANA timezone/);
});

test("wall clock and instants across DST", () => {
  assert.equal(wallToUtcMs(2025, 3, 31, 8, 15, "Asia/Taipei"), Date.UTC(2025, 2, 31, 0, 15));
  assert.equal(wallToUtcMs(2025, 7, 1, 9, 30, "America/New_York"), Date.UTC(2025, 6, 1, 13, 30));
  assert.equal(wallToUtcMs(2025, 12, 1, 9, 30, "America/New_York"), Date.UTC(2025, 11, 1, 14, 30));
  // 01:30 happens twice on 2025-11-02 in New York: the first (EDT) is taken.
  assert.equal(wallToUtcMs(2025, 11, 2, 1, 30, "America/New_York"), Date.UTC(2025, 10, 2, 5, 30));
  assert.equal(formatWall(Date.UTC(2025, 2, 31, 0, 15), "Asia/Taipei"), "2025-03-31 08:15");
});

test("ISO range inputs", () => {
  assert.equal(parseIsoUtc("2025-04-01", "range_start"), Date.UTC(2025, 3, 1));
  assert.equal(parseIsoUtc("2025-04-01T08:00", "range_start"), Date.UTC(2025, 3, 1, 8));
  assert.equal(parseIsoUtc("2025-04-01T08:00:00+08:00", "range_start"), Date.UTC(2025, 3, 1, 0));
  assert.equal(parseIsoUtc("2025-04-01 08:00:00Z", "range_start"), Date.UTC(2025, 3, 1, 8));
  assert.throws(() => parseIsoUtc("April 1", "range_start"), /range_start 'April 1' is not an ISO 8601/);
});

test("export span: first entry and last row in the chart timezone", () => {
  const s = exportSpan(CSV, "Asia/Taipei");
  assert.equal(s.trades, 5);
  assert.equal(s.firstEntry, "2025-03-31 08:15");
  assert.equal(s.firstEntryMs, Date.UTC(2025, 2, 31, 0, 15));
  assert.equal(s.lastRow, "2025-04-01 08:00");
  assert.equal(s.lastRowMs, Date.UTC(2025, 3, 1, 0, 0));
});

test("result text: tier, checks, counts, mismatches, versions, methodology, retention", () => {
  const text = formatParityResult({
    ok: true,
    tier: "strong",
    tier_meaning: "close to TradingView, outside the excellent envelope",
    profile: "strict",
    checks: [
      { name: "trade count", tradingview: 5, pineforge: 5, value: 0, abs: 0, excellent: "exact (0)", strong: "< 6%", pass_excellent: true },
      { name: "exit price p90", value: 0.0101, excellent: "< 0.01%", strong: "< 0.5%", pass_excellent: false, pass_strong: true },
    ],
    matched: 5,
    unmatched_tradingview: 0,
    unmatched_pineforge: 0,
    mismatches: [{
      kind: "deviating_pair",
      tradingview: { trade: 1, side: "long", entry_time: "2025-03-31 08:15", entry_price: 1807.82, exit_time: "2025-04-01 08:00", exit_price: 1839.81, qty: 1, pnl: 31.99 },
      pineforge: { side: "long", entry_time: "2025-03-31 08:15", entry_price: 1807.82, exit_time: "2025-04-01 08:00", exit_price: 1821.59, qty: 1, pnl: 13.77 },
      deltas: { entry: 0, exit: 0.0099, pnl: 0.5695 },
      hint: null,
    }],
    timezone: { given: "Asia/Taipei", offset_mode_seconds: 0, better: null, note: null },
    versions: { engine: "1.0.1", codegen: "1.0.1", grader: "pineforge-engine v1.0.1 scripts/verify_corpus.py", grader_sha256: "de84d515" },
    warnings: [],
  }, { retention: RETENTION_LOCAL });
  assert.match(text, /^Tier: strong: close to TradingView/);
  assert.match(text, /\| trade count \| TradingView 5, PineForge 5 Δ 0 \| exact \(0\) \| < 6% \| meets excellent \|/);
  assert.match(text, /\| exit price p90 \| 1\.0100% \| < 0\.01% \| < 0\.5% \| meets strong \|/);
  assert.match(text, /Matched 5 of 5 TradingView trades; 0 TradingView-only, 0 PineForge-only\./);
  assert.match(text, /1\. matched, outside the threshold\n {3}TradingView: #1 long 2025-03-31 08:15 @ 1807\.82 -> 2025-04-01 08:00 @ 1839\.81/);
  assert.match(text, /deltas: entry 0\.0000%, exit 0\.9900%, pnl 56\.9500%/);
  assert.match(text, /Engine 1\.0\.1, codegen 1\.0\.1, grader pineforge-engine v1\.0\.1 scripts\/verify_corpus\.py \(sha256 de84d515\)/);
  assert.match(text, /Methodology: https:\/\/pineforge\.dev\/en\/methodology\//);
  assert.ok(text.endsWith(RETENTION_LOCAL));
  const err = formatParityResult({ ok: false, error: "no_bars", message: "Pass bars." }, { retention: RETENTION_LOCAL });
  assert.match(err, /^Parity check failed \(no_bars\): Pass bars\./);
});

test("src/parity stays portable: no node: imports, no zod, no imports outside the directory", () => {
  const dir = new URL("../src/parity/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)) {
      assert.match(m[1]!, /^\.\/[\w-]+\.js$/, `${f} imports ${m[1]}`);
    }
    assert.ok(!/\brequire\(|import\(/.test(src), `${f} uses require/dynamic import`);
  }
  assert.ok(SAMPLE_PROPERTIES.length > 0);
});

test("settings: explicit inputs and XLSX Properties merge only when they agree", () => {
  const exp = {
    symbol: "BINANCE:ETHUSDT.P", timeframe: "15",
    range_start_wall: "2020-01-01 08:00", range_end_wall: "2025-04-01 08:00",
    strategy_overrides: { initial_capital: 1000000, pyramiding: 5 },
    runtime: { bar_magnifier: false },
  };
  const r = resolveSettings({ chart_timezone: "Asia/Taipei", strategy_overrides: { pyramiding: 5 } }, exp, { symbolRequired: true });
  assert.equal(r.symbol, "BINANCE:ETHUSDT.P");
  assert.equal(r.timeframe, "15");
  assert.equal(r.rangeStartMs, Date.UTC(2020, 0, 1, 0, 0));
  assert.equal(r.rangeEndMs, Date.UTC(2025, 3, 1, 0, 0));
  assert.deepEqual(r.strategyOverrides, { pyramiding: 5, initial_capital: 1000000 });
  assert.deepEqual(r.runtime, { bar_magnifier: false });
  assert.deepEqual(r.fromExport, ["symbol", "timeframe", "range_start", "range_end", "strategy_overrides.initial_capital", "runtime.bar_magnifier"]);
  const agree = resolveSettings({ symbol: "binance:ethusdt.p", timeframe: "15m", chart_timezone: "Asia/Taipei", range_start: "2020-01-01T00:00:00Z" }, exp, { symbolRequired: true });
  assert.equal(agree.fromExport.includes("symbol"), false);
  assert.throws(() => resolveSettings({ symbol: "BINANCE:ETHUSDT", chart_timezone: "Asia/Taipei" }, exp, { symbolRequired: true }),
    /symbol: you passed "BINANCE:ETHUSDT", the export's Properties say "BINANCE:ETHUSDT.P"/);
  assert.throws(() => resolveSettings({ chart_timezone: "Asia/Taipei", range_start: "2021-01-01" }, exp, { symbolRequired: true }),
    (e: unknown) => e instanceof ParityInputError && e.kind === "conflicting_setting" && /range_start/.test(e.message));
  assert.throws(() => resolveSettings({ chart_timezone: "Asia/Taipei", strategy_overrides: { pyramiding: 1 } }, exp, { symbolRequired: true }),
    /strategy_overrides\.pyramiding: you passed 1/);
  assert.throws(() => resolveSettings({}, {}, { symbolRequired: true }),
    (e: unknown) => e instanceof ParityInputError && e.kind === "missing_setting" && /symbol .*timeframe .*chart_timezone .*range_start .*A CSV trade list/.test(e.message));
  const noSymbol = resolveSettings({ timeframe: "60", chart_timezone: "UTC", range_start: "2025-01-01" }, {}, { symbolRequired: false });
  assert.equal(noSymbol.symbol, null);
  assert.equal(noSymbol.rangeEndMs, null);
});
