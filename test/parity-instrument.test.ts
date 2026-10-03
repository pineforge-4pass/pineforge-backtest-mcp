// check_tradingview_parity and the instrument: the Binance symbol its TradingView ticker names is
// resolved as backtest_pine resolves it, passed to the grading core as request key `instrument`
// (in the shape the core accepts), described in the text, and warned about when no grid applies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineRunner, ParityCall } from "../src/engine.js";
import { coreInstrument, parityInstrument, parityToolResult, type ParityDeps, type ParityToolArgs } from "../src/parity-tool.js";
import {
  INSTRUMENT_SCHEMA,
  instrumentFromBinance,
  layerUserSyminfo,
  resolveInstrument,
  unresolvedInstrument,
  writeSidecar,
  type BinanceSymbolInfo,
  type Instrument,
} from "../src/instrument.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const CSV = read("./fixtures/parity/tv_trades.csv");
const PINE = '//@version=6\nstrategy("x")\n';
const SPOT = JSON.parse(read("./fixtures/binance/spot-exchangeinfo.json")).symbols as BinanceSymbolInfo[];
const FAPI = JSON.parse(read("./fixtures/binance/fapi-exchangeinfo.json")).symbols as BinanceSymbolInfo[];
const NEWCOIN: BinanceSymbolInfo = {
  symbol: "NEWCOINUSDT", baseAsset: "NEWCOIN", quoteAsset: "USDT",
  filters: [{ filterType: "PRICE_FILTER", tickSize: "0.0001" }, { filterType: "LOT_SIZE", stepSize: "0.1" }],
};
// A symbol Binance lists and TradingView does not (the table's not_on_tv): only Binance's lot step exists for it.
const UNLISTED: BinanceSymbolInfo = {
  symbol: "AIXBTUSDC", baseAsset: "AIXBT", quoteAsset: "USDC",
  filters: [{ filterType: "PRICE_FILTER", tickSize: "0.0001" }, { filterType: "LOT_SIZE", stepSize: "0.01" }],
};
const EXCHANGE_WARNING = (label: string) =>
  `lot size for ${label} is the exchange's lot step, not a TradingView reading: order quantities may differ from TradingView's`;
const DEFAULT_WARNING = (label: string) =>
  `lot size for ${label} is TradingView's usual default (0.001), not a reading for this symbol (a listing newer than the readings): ` +
  "order quantities may differ from TradingView's";
const BARS = "timestamp,open,high,low,close,volume\n1743379200000,1,1,1,1,1\n";

const tmp = mkdtempSync(join(tmpdir(), "pf-parity-instrument-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const barsFile = (text = BARS) => {
  const path = join(tmp, `bars-${++n}.csv`);
  writeFileSync(path, text);
  return path;
};

// A runner that records the core's request and answers as the core does: it echoes the instrument it was given.
function fakeRunner() {
  const calls: ParityCall[] = [];
  const runner = {
    mode: "local",
    async parity(call: ParityCall) {
      calls.push(call);
      return {
        ok: true, tier: "excellent", tier_meaning: "m", checks: [], matched: 5, unmatched_tradingview: 0,
        unmatched_pineforge: 0, mismatches: [], warnings: [],
        applied_instrument: (call.request.instrument as unknown) ?? null,
      };
    },
  } as unknown as EngineRunner;
  return { runner, calls };
}

const seenLookups: string[] = [];
const lookup = async (market: string, symbol: string) => {
  seenLookups.push(`${market}:${symbol}`);
  return [...(market === "spot" ? SPOT : FAPI), NEWCOIN, UNLISTED].find((s) => s.symbol === symbol);
};
const depsWith = (lookupFn: typeof lookup = lookup): ParityDeps => ({
  resolvePath: (p) => resolve(p),
  fetchBinanceCsv: async () => ({ csv: BARS, bars: 1 }),
  resolveInstrument: (req, csvPath) => resolveInstrument(req, csvPath, lookupFn),
});

const base = { pine: PINE, tradingview_trades: CSV, timeframe: "15", range_start: "2025-03-31T00:00:00Z", chart_timezone: "Asia/Taipei" };

test("a Binance spot ticker: TradingView's lot size from the table, the exchange's tick, in the core's request and echoed back", async () => {
  const { runner, calls } = fakeRunner();
  seenLookups.length = 0;
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:BTCUSDT", ohlcv_csv_path: barsFile() }, depsWith());
  assert.equal(out.isError, false, out.content[0]!.text);
  assert.deepEqual(seenLookups, ["spot:BTCUSDT"]);
  const sent = calls[0]!.request.instrument;
  assert.deepEqual(sent, {
    schema: INSTRUMENT_SCHEMA, resolved: true,
    qty_step: 0.00001, mincontract: 0.00001, mintick: 0.01, pointvalue: 1, type: "crypto", currency: "USDT", basecurrency: "BTC",
    source: { kind: "tradingview", venue: "binance_spot", symbol: "BTCUSDT" },
  });
  assert.deepEqual(out.structuredContent.applied_instrument, sent);
  assert.deepEqual(out.structuredContent.warnings, []);
  assert.match(out.content[0]!.text, /\nInstrument: BTCUSDT spot: lot size 0\.00001 \(TradingView's\), tick 0\.01, point value 1\.\n/);
  assert.deepEqual(JSON.parse(out.content[1]!.text), out.structuredContent);
});

test("a .P ticker is the USD-M perpetual: TradingView's 0.000001 for BTCUSDT, not Binance's 0.001", async () => {
  const { runner, calls } = fakeRunner();
  seenLookups.length = 0;
  const out = await parityToolResult(runner, { ...base, symbol: "binance:btcusdt.p", ohlcv_csv_path: barsFile() }, depsWith());
  assert.equal(out.isError, false, out.content[0]!.text);
  assert.deepEqual(seenLookups, ["usdt_perp:BTCUSDT"]);
  const sent = calls[0]!.request.instrument as Record<string, unknown>;
  assert.deepEqual([sent.qty_step, sent.mincontract, sent.mintick], [0.000001, 0.000001, 0.1]);
  assert.deepEqual(sent.source, { kind: "tradingview", venue: "binance_usdt_perp", symbol: "BTCUSDT" });
  assert.match(out.content[0]!.text, /Instrument: BTCUSDT USDT-M perpetual: lot size 0\.000001 \(TradingView's\), tick 0\.1/);
});

test("fetched bars and the instrument come from the same ticker (one lookup, one fetch)", async () => {
  const { runner, calls } = fakeRunner();
  const fetched: unknown[][] = [];
  seenLookups.length = 0;
  const deps = { ...depsWith(), fetchBinanceCsv: async (...a: unknown[]) => { fetched.push(a); return { csv: BARS, bars: 1 }; } } as ParityDeps;
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:ETHUSDT.P" }, deps);
  assert.equal(out.isError, false, out.content[0]!.text);
  assert.deepEqual(fetched.map((f) => f.slice(0, 3)), [["usdt_perp", "ETHUSDT", "15m"]]);
  assert.deepEqual(seenLookups, ["usdt_perp:ETHUSDT"]);
  assert.equal((calls[0]!.request.instrument as Record<string, unknown>).qty_step, 0.0001);
});

test("a listing newer than the table: TradingView's usual 0.001 (kind default), with the default warning, as backtest_pine gives", async () => {
  const { runner, calls } = fakeRunner();
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:NEWCOINUSDT", ohlcv_csv_path: barsFile() }, depsWith());
  assert.equal(out.isError, false, out.content[0]!.text);
  const sent = calls[0]!.request.instrument as Record<string, unknown>;
  assert.deepEqual([sent.qty_step, sent.mincontract, sent.source], [0.001, 0.001, { kind: "default", venue: "binance_spot", symbol: "NEWCOINUSDT" }]);
  assert.deepEqual(out.structuredContent.warnings, [DEFAULT_WARNING("Binance spot NEWCOINUSDT")]);
  assert.match(out.content[0]!.text, /\nInstrument: NEWCOINUSDT spot: lot size 0\.001 \(TradingView's usual default\), tick 0\.0001/);
  assert.match(out.content[0]!.text, /Warnings:\n- lot size for Binance spot NEWCOINUSDT is TradingView's usual default \(0\.001\)/);
  // a .P ticker is the USD-M market: the label says so
  const perp = await parityToolResult(runner, { ...base, symbol: "BINANCE:NEWCOINUSDT.P", ohlcv_csv_path: barsFile() }, depsWith());
  assert.deepEqual(perp.structuredContent.warnings, [DEFAULT_WARNING("Binance usdt_perp NEWCOINUSDT")]);
});

test("a symbol TradingView does not list: Binance's lot step (kind exchange), with the exchange warning", async () => {
  const { runner, calls } = fakeRunner();
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:AIXBTUSDC", ohlcv_csv_path: barsFile() }, depsWith());
  assert.equal(out.isError, false, out.content[0]!.text);
  const sent = calls[0]!.request.instrument as Record<string, unknown>;
  assert.deepEqual([sent.qty_step, sent.source], [0.01, { kind: "exchange", venue: "binance_spot", symbol: "AIXBTUSDC" }]);
  assert.deepEqual(out.structuredContent.warnings, [EXCHANGE_WARNING("Binance spot AIXBTUSDC")]);
  assert.match(out.content[0]!.text, /Warnings:\n- lot size for Binance spot AIXBTUSDC is the exchange's lot step/);
});

test("the ticker names the market, so the parity tool never has the backtest's `market not given` warning", async () => {
  const { runner } = fakeRunner();
  for (const symbol of ["BINANCE:BTCUSDT", "BINANCE:BTCUSDT.P", "binance:ethusdt"]) {
    const out = await parityToolResult(runner, { ...base, symbol, ohlcv_csv_path: barsFile() }, depsWith());
    assert.deepEqual(out.structuredContent.warnings, [], symbol);
  }
  // with bars of the user's own and no ticker the instrument is the bars' sidecar or `syminfo`: no market is assumed either
  const own = await parityToolResult(runner, { ...base, ohlcv_csv: BARS, syminfo: { qty_step: 0.001, mintick: 0.1 } }, depsWith());
  assert.deepEqual(own.structuredContent.warnings, []);
});

test("no lot size anywhere: the run goes ahead, the core is told it is unresolved, and the result warns", async () => {
  const { runner, calls } = fakeRunner();
  const down = async () => { throw new Error("Binance 451 for https://api.binance.com/x: blocked"); };
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:NEWCOINUSDT", ohlcv_csv_path: barsFile() }, depsWith(down));
  assert.equal(out.isError, false, out.content[0]!.text);
  assert.deepEqual(calls[0]!.request.instrument, {
    schema: INSTRUMENT_SCHEMA, resolved: false, reason: "Binance spot exchangeInfo unavailable",
    source: { kind: "exchange", venue: "binance_spot", symbol: "NEWCOINUSDT" },
  });
  const warnings = out.structuredContent.warnings as string[];
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^instrument grid unavailable for Binance spot NEWCOINUSDT \(Binance spot exchangeInfo unavailable: Binance 451.*\): order quantity is not floored to a lot size, so the run can contain sub-lot margin-call rows that TradingView does not book\. Pass `syminfo` \(qty_step, mintick, \.\.\.\) or, for a Binance chart, `symbol` as BINANCE:<SYMBOL>/);
  assert.match(out.content[0]!.text, /\nInstrument: NEWCOINUSDT spot: no lot size \(Binance spot exchangeInfo unavailable\), so order quantity is not floored\n/);
});

test("a table symbol with Binance unreachable still gets TradingView's lot size, and says the tick is unknown", async () => {
  const { runner, calls } = fakeRunner();
  const down = async () => { throw new Error("fetch failed"); };
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:BTCUSDT", ohlcv_csv_path: barsFile() }, depsWith(down));
  const sent = calls[0]!.request.instrument as Record<string, unknown>;
  assert.deepEqual([sent.resolved, sent.qty_step, sent.mintick], [true, 0.00001, undefined]);
  const warnings = out.structuredContent.warnings as string[];
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /the lot size is TradingView's, from the embedded table, but the tick size and currencies are not known$/);
});

test("another exchange has no instrument source: unresolved unless `syminfo` gives the grid", async () => {
  const { runner, calls } = fakeRunner();
  const bybit = await parityToolResult(runner, { ...base, symbol: "BYBIT:BTCUSDT", ohlcv_csv_path: barsFile() }, depsWith());
  assert.equal(bybit.isError, false, bybit.content[0]!.text);
  assert.deepEqual(calls[0]!.request.instrument, { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "no instrument source for BYBIT" });
  assert.match((bybit.structuredContent.warnings as string[])[0]!, /^instrument grid unavailable for BYBIT:BTCUSDT \(no instrument source for BYBIT\)/);
  const given = await parityToolResult(runner, {
    ...base, symbol: "BYBIT:BTCUSDT", ohlcv_csv_path: barsFile(), syminfo: { qty_step: 0.000001, mintick: 0.1, pointvalue: 1 },
  }, depsWith());
  assert.deepEqual(calls[1]!.request.instrument, {
    schema: INSTRUMENT_SCHEMA, resolved: true, qty_step: 0.000001, mincontract: 0.000001, mintick: 0.1, pointvalue: 1, source: { kind: "user" },
  });
  assert.deepEqual(given.structuredContent.warnings, []);
  assert.match(given.content[0]!.text, /\nInstrument: lot size 0\.000001 \(your syminfo\), tick 0\.1, point value 1\.\n/);
});

test("`syminfo` goes over the resolved symbol: your lot size, TradingView's tick source kept as the base", async () => {
  const { runner, calls } = fakeRunner();
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:BTCUSDT", ohlcv_csv_path: barsFile(), syminfo: { qty_step: 0.001 } }, depsWith());
  assert.equal(out.isError, false, out.content[0]!.text);
  const sent = calls[0]!.request.instrument as Record<string, unknown>;
  assert.deepEqual([sent.qty_step, sent.mincontract, sent.mintick, sent.source], [0.001, 0.001, 0.01, { kind: "user", venue: "binance_spot", symbol: "BTCUSDT" }]);
  assert.match(out.content[0]!.text, /Instrument: BTCUSDT spot: lot size 0\.001 \(your syminfo\), tick 0\.01/);
});

test("without a ticker, the sidecar next to your own bars file names the instrument", async () => {
  const { runner, calls } = fakeRunner();
  const path = barsFile();
  await writeSidecar(path, instrumentFromBinance(SPOT.find((s) => s.symbol === "ETHUSDT")!, "spot", 0.0001),
    { interval: "15m", first_open_time: 1743379200000, last_open_time: 1743379200000, bars: 1 });
  const out = await parityToolResult(runner, { ...base, ohlcv_csv_path: path }, depsWith());
  assert.equal(out.isError, false, out.content[0]!.text);
  const sent = calls[0]!.request.instrument as Record<string, unknown>;
  assert.deepEqual([sent.resolved, sent.qty_step, sent.source], [true, 0.0001, { kind: "tradingview", venue: "binance_spot", symbol: "ETHUSDT" }]);
  assert.deepEqual(out.structuredContent.warnings, []);
  // bars without one: unresolved, and the warning names the file
  const bare = barsFile();
  const none = await parityToolResult(runner, { ...base, ohlcv_csv_path: bare }, depsWith());
  assert.equal((calls[1]!.request.instrument as Record<string, unknown>).resolved, false);
  assert.match((none.structuredContent.warnings as string[])[0]!, /^instrument grid unavailable for bars-\d+\.csv \(no symbol, syminfo or sidecar was given\)/);
  // bars passed as text have no file next to them: the label is the instrument
  const inline = await parityToolResult(runner, { ...base, ohlcv_csv: BARS }, depsWith());
  assert.match((inline.structuredContent.warnings as string[])[0]!, /^instrument grid unavailable for the instrument \(/);
});

test("without the resolver (older callers of the module) no instrument is passed and nothing is warned", async () => {
  const { runner, calls } = fakeRunner();
  const deps = { resolvePath: (p: string) => resolve(p), fetchBinanceCsv: async () => ({ csv: BARS, bars: 1 }) } as ParityDeps;
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:BTCUSDT", ohlcv_csv_path: barsFile() }, deps);
  assert.equal(out.isError, false, out.content[0]!.text);
  assert.equal("instrument" in calls[0]!.request, false);
  assert.deepEqual(out.structuredContent.warnings, []);
  assert.equal(await parityInstrument({ ...base } as ParityToolArgs, "BINANCE:BTCUSDT", undefined, deps), undefined);
});

test("instrument warnings come before the export's and the core's, and after nothing but the release warning", async () => {
  const calls: ParityCall[] = [];
  const runner = {
    mode: "local",
    async parity(call: ParityCall) {
      calls.push(call);
      return { ok: true, tier: "excellent", tier_meaning: "m", checks: [], matched: 5, unmatched_tradingview: 0,
        unmatched_pineforge: 0, mismatches: [], warnings: ["the core's own warning"], versions: { engine: "0.9.0", codegen: "0.9.0" } };
    },
  } as unknown as EngineRunner;
  const out = await parityToolResult(runner, { ...base, symbol: "BINANCE:NEWCOINUSDT", ohlcv_csv_path: barsFile() }, depsWith());
  const warnings = out.structuredContent.warnings as string[];
  assert.equal(warnings.length, 3);
  assert.match(warnings[0]!, /^This check ran on engine 0\.9\.0/);
  assert.equal(warnings[1], DEFAULT_WARNING("Binance spot NEWCOINUSDT"));
  assert.equal(warnings[2], "the core's own warning");
});

// ─── the shape the core accepts ───────────────────────────────────────────

test("coreInstrument keeps what the core knows: no market/via/base/overridden/fetched_at, a reason of at most 64 characters", () => {
  const tv = instrumentFromBinance(SPOT.find((s) => s.symbol === "BTCUSDT")!, "spot", 0.00001);
  tv.source = { ...tv.source!, via: "sidecar", fetched_at: "2026-10-04T00:00:00.000Z" };
  assert.deepEqual(coreInstrument(tv).source, { kind: "tradingview", venue: "binance_spot", symbol: "BTCUSDT" });
  const layered = layerUserSyminfo(tv, { qty_step: 1, mintick: 0.5 });
  assert.deepEqual(coreInstrument(layered).source, { kind: "user", venue: "binance_spot", symbol: "BTCUSDT" });
  const long = unresolvedInstrument("x".repeat(150));
  assert.equal((coreInstrument(long).reason as string).length, 64);
  assert.deepEqual(Object.keys(coreInstrument(unresolvedInstrument("why"))), ["schema", "resolved", "reason"]);
  const dropped = instrumentFromBinance({ symbol: "XUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "1" }] }, "usdt_perp");
  assert.deepEqual(coreInstrument(dropped).source, { kind: "exchange", venue: "binance_usdt_perp", symbol: "XUSDT", dropped: ["mintick"] });
});

test("the real grading core accepts every instrument the tool can send (check_instrument)", () => {
  const spot = (s: string) => SPOT.find((x) => x.symbol === s)!;
  const instruments: Instrument[] = [
    instrumentFromBinance(spot("BTCUSDT"), "spot", 0.00001),
    instrumentFromBinance(spot("DOGEUSDT"), "spot"),
    instrumentFromBinance(FAPI.find((x) => x.symbol === "BTCUSDT")!, "usdt_perp", 0.000001),
    instrumentFromBinance({ symbol: "XUSDT", filters: [] }, "spot"),
    layerUserSyminfo(instrumentFromBinance(spot("BTCUSDT"), "spot", 0.00001), { qty_step: 0.5, mintick: 0.5, pointvalue: 2, type: "futures", currency: "EUR", basecurrency: "X" }),
    layerUserSyminfo(undefined, { qty_step: 1 }),
    layerUserSyminfo(undefined, { mintick: 0.1 }),
    unresolvedInstrument("no symbol, syminfo or sidecar was given"),
    unresolvedInstrument("y".repeat(300), { kind: "exchange", market: "spot", symbol: "NEWCOINUSDT", via: "symbol" }),
  ];
  const sent = instruments.map(coreInstrument);
  const py = [
    "import json, sys",
    "sys.path.insert(0, 'parity')",
    "import pf_parity as pf",
    "specs = json.load(sys.stdin)",
    "for spec in specs:",
    "    pf.check_instrument(spec)",
    "    assert pf.instrument_overrides(spec) is not None",
    "print(len(specs))",
  ].join("\n");
  const r = spawnSync("python3", ["-c", py], { cwd: root, input: JSON.stringify(sent), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), String(sent.length));
});

test("the real core turns the instrument into runtime_overrides: lot size, tick, point value, type, currencies, mincontract", () => {
  const sent = coreInstrument(instrumentFromBinance(SPOT.find((x) => x.symbol === "BTCUSDT")!, "spot", 0.00001));
  const py = ["import json, sys", "sys.path.insert(0, 'parity')", "import pf_parity as pf",
    "print(json.dumps(pf.instrument_overrides(json.load(sys.stdin))))"].join("\n");
  const r = spawnSync("python3", ["-c", py], { cwd: root, input: JSON.stringify(sent), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    qty_step: 0.00001, mintick: 0.01, pointvalue: 1, type: "crypto", currency: "USDT", basecurrency: "BTC",
    syminfo_metadata: { mincontract: 0.00001 },
  });
});
