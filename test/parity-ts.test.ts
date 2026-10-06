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
  RETENTION_HOSTED,
  resolveSettings,
  DEFAULT_EXPORT_LIMITS,
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
  // The per-part cap (the total leaves room for the part).
  const limits = { maxInputChars: 1e9, maxPartBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxRows: 1000, maxCells: 1000 };
  await inputError(readTradingViewExport(bomb, inflate, limits), "bad_trades_csv", /larger than the 1048576-byte limit/);
  // The total: the sizes the directory states for the parts read are checked before any is inflated.
  const small = { ...limits, maxPartBytes: 8 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 };
  let inflated = 0;
  const counting: InflateFn = (d, max) => { inflated++; return inflate(d, max); };
  await inputError(readTradingViewExport(bomb, counting, small), "bad_trades_csv", /parts this reads unpack to \d+ bytes; the limit is 2097152/);
  assert.equal(inflated, 2, "only the workbook and its rels were inflated");
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

test("result text: tier, checks, counts, mismatches, timezone, versions, methodology, retention", () => {
  // The shape parity/pf_parity.py returns.
  const response = {
    ok: true,
    tier: "strong",
    tier_meaning: "Close to TradingView: small differences in count or prices.",
    profile: "strict",
    checks: [
      { name: "trade count", tradingview: 5, pineforge: 5, value: 0, abs: 0, excellent: "exact (0)", strong: "< 6%", pass_excellent: true, pass_strong: true },
      { name: "coverage", value: 1, unmatched: 0, of: 5, excellent: ">= 99% or <= 1 unmatched", strong: ">= 95% or <= 1 unmatched", moderate: ">= 75%", pass_excellent: true, pass_strong: true },
      { name: "exit price p90", value: 0.0101, excellent: "< 0.01%", strong: "< 0.5%", pass_excellent: false, pass_strong: true },
      { name: "distinct entries", value: 0, excellent: "0 mismatches", pass_excellent: true },
    ],
    matched: 5,
    unmatched_tradingview: 0,
    unmatched_pineforge: 0,
    deviating_pairs: 1,
    mismatches: [{
      kind: "deviating_pair",
      tradingview: { trade: 1, side: "long", entry_time: "2025-03-31 08:15", entry_price: 1807.82, exit_time: "2025-04-01 08:00", exit_price: 1839.81, qty: 1, pnl: 31.99, signal: "pyramid-add", open_at_range_end: false },
      pineforge: { trade: 1, side: "long", entry_time: "2025-03-31 08:15", entry_price: 1807.82, exit_time: "2025-04-01 08:00", exit_price: 1821.59, qty: 1, pnl: 13.77, signal: null, open_at_range_end: false },
      deltas: { entry: 0, exit: 0.0099, pnl: 0.5695, qty: 0, entry_seconds: 0, exit_abs: -18.22, pnl_abs: -18.22 },
      hint: null,
    }],
    timezone: {
      given: "UTC", offset_mode_seconds: 28800, offset_mode_share: 1,
      better: { zone: "Asia/Taipei", matched: 5, matched_given: 0, shift_seconds: 28800 },
      note: "Every matched trade sits 8 h later on TradingView than on PineForge: the chart timezone is probably off by 8 h.",
    },
    window: { range_start: "2020-01-01 00:00", range_end: "2025-04-01 00:00", range_end_source: "tape", timezone_of_times: "UTC" },
    versions: { engine: "1.3.0", codegen: "1.3.0", grader: "pineforge-engine v1.2.0 scripts/verify_corpus.py", grader_sha256: "431452ec" },
    warnings: [
      "Every matched trade sits 8 h later on TradingView than on PineForge: the chart timezone is probably off by 8 h.",
      "Read in Asia/Taipei, 5 trades match instead of 0: TradingView may have printed the times in Asia/Taipei. The tier above uses UTC.",
      "Something else.",
    ],
  };
  const text = formatParityResult(response, { retention: RETENTION_LOCAL, notes: ["Bars: your file."] });
  assert.match(text, /^Tier: strong: Close to TradingView/);
  assert.match(text, /\| trade count \| TradingView 5, PineForge 5 Δ 0 \| exact \(0\) \| < 6% \| - \| meets excellent \|/);
  assert.match(text, /\| coverage \| 100\.0% \(0 of 5 unmatched\) \|/);
  assert.match(text, /\| exit price p90 \| 1\.0100% \| < 0\.01% \| < 0\.5% \| - \| meets strong \|/);
  assert.match(text, /\| distinct entries \| 0 mismatches \| 0 mismatches \| - \| - \| meets excellent \|/);
  assert.match(text, /Matched 5 of 5 TradingView trades; 0 TradingView-only, 0 PineForge-only\./);
  assert.match(text, /1\. matched, outside the threshold\n {3}TradingView: #1 long 2025-03-31 08:15 @ 1807\.82 -> 2025-04-01 08:00 @ 1839\.81 qty 1 P&L 31\.99 signal pyramid-add/);
  assert.match(text, /deltas: entry 0\.0000%, exit 0\.9900%, P&L 56\.9500%, qty 0\.0000%, exit price Δ -18\.22, P&L Δ -18\.22/);
  assert.match(text, /Timezone: Every matched trade sits 8 h later/);
  assert.match(text, /Timezone: read in Asia\/Taipei, 5 trades match instead of 0 under UTC; the tier above uses UTC\./);
  assert.match(text, /Window: first bar 2020-01-01 00:00 UTC, range end 2025-04-01 00:00 UTC, set by tape\./);
  assert.match(text, /Warnings:\n- Something else\.\nBars: your file\./);
  assert.equal(text.match(/sits 8 h later/g)?.length, 1);
  assert.match(text, /Engine 1\.3\.0, codegen 1\.3\.0, grader pineforge-engine v1\.2\.0 scripts\/verify_corpus\.py \(sha256 431452ec\)/);
  assert.match(text, /Methodology: https:\/\/pineforge\.dev\/en\/methodology\//);
  assert.ok(text.endsWith(RETENTION_LOCAL));
  const omitted = formatParityResult({ ...response, unmatched_tradingview: null, unmatched_pineforge: null, mismatches: [] }, { retention: RETENTION_LOCAL });
  assert.match(omitted, /Matched 5 TradingView trades; the per-trade listing is left out/);
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

// Python: int(datetime.strptime(wall, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo(tz)).timestamp()) * 1000,
// i.e. the grader's own reading (fold=0), for spring-forward gaps and fall-back folds in both hemispheres.
const PY_FOLD0: Array<[string, string, number]> = [
  ["Europe/Berlin", "2025-10-26 02:15", 1761437700000], // fold: first occurrence (CEST)
  ["Europe/Berlin", "2025-10-26 02:45", 1761439500000],
  ["Europe/Berlin", "2025-10-26 03:15", 1761444900000],
  ["Europe/Berlin", "2025-10-26 01:59", 1761436740000],
  ["Europe/Berlin", "2025-03-30 02:30", 1743298200000], // gap: the offset before the change
  ["America/New_York", "2025-11-02 01:30", 1762061400000],
  ["America/New_York", "2025-03-09 02:30", 1741505400000],
  ["Australia/Sydney", "2025-04-06 02:30", 1743867000000], // southern fall-back
  ["Australia/Sydney", "2025-10-05 02:30", 1759595400000], // southern spring-forward
  ["America/Santiago", "2025-04-05 23:30", 1743906600000],
  ["America/Santiago", "2025-09-07 00:30", 1757219400000],
  ["Asia/Taipei", "2025-03-31 08:15", 1743380100000],
];

test("wall times resolve exactly as the grader's zoneinfo does (fold=0), gaps and folds, both hemispheres", () => {
  for (const [tz, wall, ms] of PY_FOLD0) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(wall)!;
    assert.equal(wallToUtcMs(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz), ms, `${tz} ${wall}`);
  }
});

test("XLSX Properties in a DST fold merge with the matching explicit instant", () => {
  const exp = { range_start_wall: "2025-10-26 02:15", range_end_wall: "2025-10-26 02:45", timeframe: "15", symbol: "BINANCE:ETHUSDT" };
  const r = resolveSettings({ chart_timezone: "Europe/Berlin", range_start: "2025-10-26T00:15:00Z" }, exp, { symbolRequired: true });
  assert.equal(r.rangeStartMs, 1761437700000);
  assert.equal(r.rangeEndMs, 1761439500000);
  assert.throws(() => resolveSettings({ chart_timezone: "Europe/Berlin", range_start: "2025-10-26T01:15:00Z" }, exp, { symbolRequired: true }),
    (e: unknown) => e instanceof ParityInputError && e.kind === "conflicting_setting");
  const syd = resolveSettings({ chart_timezone: "Australia/Sydney" }, { ...exp, range_start_wall: "2025-04-06 02:30", range_end_wall: undefined }, { symbolRequired: true });
  assert.equal(syd.rangeStartMs, 1743867000000);
});

test("ISO ranges: calendar, clock and offset fields are checked, never rolled over", () => {
  for (const bad of ["2025-02-30", "2025-13-01", "2025-00-10", "2025-04-31T00:00", "2025-04-01T24:00",
                     "2025-04-01T23:60", "2025-04-01T23:59:60", "2025-04-01T08:00+25:99", "2025-04-01T08:00+14:30",
                     "2023-02-29", "1899-12-31"]) {
    assert.throws(() => parseIsoUtc(bad, "range_start"), (e: unknown) => e instanceof ParityInputError && e.kind === "bad_range", bad);
  }
  assert.equal(parseIsoUtc("2024-02-29", "range_start"), Date.UTC(2024, 1, 29));
  assert.equal(parseIsoUtc("2025-04-01T23:59:59-14:00", "range_start"), Date.UTC(2025, 3, 2, 13, 59, 59));
});

test("XLSX cell references outside the grid, over-wide rows and the expanded-cell budget are refused before allocation", async () => {
  const sheet = (cells: string) => zip([
    { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="List of trades" r:id="rId1"/></sheets></workbook>') },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<worksheet><sheetData>${cells}</sheetData></worksheet>`) },
  ]).toString("base64");
  const bomb = sheet('<row r="1"><c r="ZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row>');
  assert.ok(Buffer.from(bomb, "base64").length < 1024);
  await inputError(readTradingViewExport(bomb, inflate), "bad_trades_csv", /cell reference outside Excel's grid/);
  await inputError(readTradingViewExport(sheet('<row r="1"><c r="XFE1"><v>1</v></c></row>'), inflate), "bad_trades_csv", /outside Excel's grid/);
  await inputError(readTradingViewExport(sheet('<row r="2000000"><c r="A1"><v>1</v></c></row>'), inflate), "bad_trades_csv", /outside Excel's grid/);
  await inputError(readTradingViewExport(sheet('<row r="1"><c r="XFD1"><v>1</v></c></row>'), inflate), "bad_trades_csv", /wider than 256 columns/);
  const wide = Array.from({ length: 50 }, (_, i) => `<row r="${i + 1}"><c r="IV${i + 1}"><v>1</v></c></row>`).join("");
  const limits = { ...DEFAULT_EXPORT_LIMITS, maxCells: 10_000 };
  await inputError(readTradingViewExport(sheet(wide), inflate, limits), "bad_trades_csv", /span more than 10000 cells together/);
});

test("a check the grader did not compute prints as not measured", () => {
  const text = formatParityResult({
    ok: true, tier: "minimal", tier_meaning: "m", profile: "strict",
    checks: [
      { name: "trade count", tradingview: 1, pineforge: 1, value: 0, abs: 0, excellent: "exact (0)", strong: "< 6%", pass_excellent: true, pass_strong: true },
      { name: "coverage", value: null, note: "not measured: no trade lined up" },
    ],
    matched: 0, unmatched_tradingview: 1, unmatched_pineforge: 1, mismatches: [], warnings: [],
  }, { retention: RETENTION_LOCAL });
  assert.match(text, /\| trade count \| TradingView 1, PineForge 1 Δ 0 \|/);
  assert.match(text, /\| coverage \| not measured: no trade lined up \| - \| - \|  \|/);
});

// One sheet, its rels and a workbook naming it "List of trades".
function oneSheet(sheet: string, workbook = '<workbook><sheets><sheet name="List of trades" r:id="rId1"/></sheets></workbook>'): string {
  return zip([
    { name: "xl/workbook.xml", data: Buffer.from(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]).toString("base64");
}

test("tag scanning is linear: 320,000 unclosed <row> tags end in a plain error within 1 s", async () => {
  const b64 = oneSheet("<worksheet><sheetData>" + "<row>".repeat(320_000));
  const t0 = performance.now();
  await inputError(readTradingViewExport(b64, inflate), "bad_trades_csv", /<row> tag that is never closed/);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
  // Opening tags without '>' and unclosed cells, strings and runs stop just as fast.
  for (const [sheet, wb, re] of [
    ["<worksheet><sheetData><row>" + "<c>".repeat(320_000) + "</row></sheetData></worksheet>", undefined, /<c> tag that is never closed/],
    ["<worksheet/>", "<workbook><sheets>" + "<sheet name='x' ".repeat(100_000), /<sheet> tag that is never closed/],
  ] as Array<[string, string | undefined, RegExp]>) {
    const t1 = performance.now();
    await inputError(readTradingViewExport(oneSheet(sheet, wb), inflate), "bad_trades_csv", re);
    assert.ok(performance.now() - t1 < 1000);
  }
});

test("the review's 5,000 x 200-cell sheet: a plain error, refused before allocation under tighter limits", async () => {
  const row = "<row>" + "<c><v>1</v></c>".repeat(200) + "</row>";
  const b64 = oneSheet("<worksheet><sheetData>" + row.repeat(5_000) + "</sheetData></worksheet>");
  const t0 = performance.now();
  await inputError(readTradingViewExport(b64, inflate), "bad_trades_csv", /no header row with 'Trade number'/);
  assert.ok(performance.now() - t0 < 10_000);
  const hosted = { maxInputChars: 8 * 1024 * 1024, maxPartBytes: 16 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024,
    maxRows: 20_000, maxCells: 300_000, maxColumns: 32 };
  const t1 = performance.now();
  await inputError(readTradingViewExport(b64, inflate, hosted), "bad_trades_csv", /more than 300000 cells|wider than 32 columns/);
  assert.ok(performance.now() - t1 < 2_000);
});

test("the hosted retention sentence names the 512 KiB offload threshold and the 7 days", () => {
  assert.match(RETENTION_HOSTED, /larger than 512 KiB/);
  assert.match(RETENTION_HOSTED, /deleted after 7 days/);
  assert.match(RETENTION_HOSTED, /deleted when grading ends/);
});

test("tag-name scanning is linear: '<' x 1,000,000, '<a' x 500,000, '<row' x 300,000 without '>' each end in under 1 s", async () => {
  const cases: Array<[string, string]> = [
    ["< x 1,000,000", "<".repeat(1_000_000)],
    ["<a x 500,000", "<a".repeat(500_000)],
    ["<row x 300,000, no >", "<row".repeat(300_000)],
    ["<row> x 320,000, unclosed", "<worksheet><sheetData>" + "<row>".repeat(320_000)],
    ["a 100-character name x 100,000", ("<" + "n".repeat(100)).repeat(100_000)],
  ];
  for (const [label, sheet] of cases) {
    const t0 = performance.now();
    await inputError(readTradingViewExport(oneSheet(sheet), inflate), "bad_trades_csv",
      /never closed|no header row with 'Trade number'/);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)} ms`);
  }
});

test("no other part of the reader rescans: workbook, rels and shared strings of '<' x 1,000,000; ranges with long blank runs", async () => {
  const lt = "<".repeat(1_000_000);
  const parts: Array<[string, Array<{ name: string; data: Buffer }>]> = [
    ["workbook", [{ name: "xl/workbook.xml", data: Buffer.from(lt) }]],
    ["rels", [
      { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="List of trades" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(lt) },
    ]],
    ["shared strings", [
      { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="List of trades" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/sharedStrings.xml", data: Buffer.from("<sst><si>" + lt + "</si></sst>") },
      { name: "xl/styles.xml", data: Buffer.from("<styleSheet><cellXfs>" + lt + "</cellXfs></styleSheet>") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<worksheet><sheetData/></worksheet>") },
    ]],
  ];
  for (const [label, files] of parts) {
    const t0 = performance.now();
    await assert.rejects(readTradingViewExport(zip(files).toString("base64"), inflate),
      (e: unknown) => e instanceof ParityInputError && e.kind === "bad_trades_csv", label);
    assert.ok(performance.now() - t0 < 1000, label);
  }
  const t1 = performance.now();
  const blank = settingsFromProperties([
    { section: "", name: "Trading range", value: "2025-01-01" + " ".repeat(200_000) + "x" },
    { section: "", name: "Date range", value: " ".repeat(200_000) },
  ]);
  assert.ok(performance.now() - t1 < 1000);
  assert.equal(blank.settings.range_start_wall, undefined);
  // A character reference outside Unicode stays as written instead of failing the read.
  const b64 = oneSheet('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#99999999;</t></is></c></row></sheetData></worksheet>');
  await inputError(readTradingViewExport(b64, inflate), "bad_trades_csv", /no header row/);
});

// A workbook with a valid "List of trades" (12 cells), a "Properties" sheet of
// `propCells` filler cells (two per row) and `strings` shared-string entries.
function twoSheetWorkbook(propCells: number, strings: number): string {
  const inl = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  const trades = "<worksheet><sheetData>" +
    `<row r="1">${inl("A1", "Trade number")}${inl("B1", "Type")}${inl("C1", "Date and time")}${inl("D1", "Price USDT")}</row>` +
    `<row r="2"><c r="A2"><v>1</v></c>${inl("B2", "Entry long")}${inl("C2", "2025-03-31 08:15")}<c r="D2"><v>100</v></c></row>` +
    `<row r="3"><c r="A3"><v>1</v></c>${inl("B3", "Exit long")}${inl("C3", "2025-03-31 09:15")}<c r="D3"><v>101</v></c></row>` +
    "</sheetData></worksheet>";
  let props = "<worksheet><sheetData>";
  for (let r = 1; r <= propCells / 2; r++) props += `<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}"><v>1</v></c></row>`;
  props += "</sheetData></worksheet>";
  return zip([
    { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="List of trades" r:id="rId1"/><sheet name="Properties" r:id="rId2"/></sheets></workbook>') },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>') },
    { name: "xl/sharedStrings.xml", data: Buffer.from("<sst>" + "<si><t>x</t></si>".repeat(strings) + "</sst>") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(trades) },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from(props) },
  ]).toString("base64");
}

test("one cell budget per workbook: two sheets each under the budget but over it together are refused", async () => {
  const limits = { ...DEFAULT_EXPORT_LIMITS, maxCells: 1_000, maxSharedStrings: 50 };
  // 12 trade cells + 990 Properties cells = 1,002 > 1,000, while each sheet alone is under 1,000.
  await inputError(readTradingViewExport(twoSheetWorkbook(990, 10), inflate, limits), "bad_trades_csv",
    /sheets read from the XLSX have more than 1000 cells together/);
});

test("shared strings over the entry cap are refused before any is decoded", async () => {
  const limits = { ...DEFAULT_EXPORT_LIMITS, maxCells: 1_000, maxSharedStrings: 50 };
  await inputError(readTradingViewExport(twoSheetWorkbook(10, 51), inflate, limits), "bad_trades_csv",
    /more than 50 shared strings/);
  // The default cap applies when the limits do not name one.
  const { maxSharedStrings: _omit, ...noCap } = DEFAULT_EXPORT_LIMITS;
  assert.equal(DEFAULT_EXPORT_LIMITS.maxSharedStrings, 2_000_000);
  const r = await readTradingViewExport(twoSheetWorkbook(10, 51), inflate, noCap);
  assert.equal(r.closedTrades, 1);
});

test("a workbook just under both budgets reads", async () => {
  const limits = { ...DEFAULT_EXPORT_LIMITS, maxCells: 1_000, maxSharedStrings: 50 };
  // 12 + 988 = 1,000 cells exactly, 50 shared strings exactly.
  const r = await readTradingViewExport(twoSheetWorkbook(988, 50), inflate, limits);
  assert.equal(r.format, "xlsx");
  assert.equal(r.closedTrades, 1);
  assert.equal(r.properties.length, 494);
});
