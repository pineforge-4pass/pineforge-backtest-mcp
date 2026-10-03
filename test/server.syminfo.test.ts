// The instrument through the public MCP interface: a real Client on an in-memory
// transport to the server createServer() builds, a runner that records its calls,
// and a stubbed Binance (the recorded exchangeInfo fixtures and three klines).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { BacktestCall, EngineRunner } from "../src/engine.js";
import { INSTRUMENT_SCHEMA, sidecarPath } from "../src/instrument.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/binance/${name}`, import.meta.url), "utf8"));
const SPOT_INFO = fixture("spot-exchangeinfo.json");
const FAPI_INFO = fixture("fapi-exchangeinfo.json");
// A listing newer than the embedded TradingView table: Binance has it, the table does not.
SPOT_INFO.symbols.push({
  symbol: "NEWCOINUSDT", status: "TRADING", baseAsset: "NEWCOIN", quoteAsset: "USDT",
  filters: [{ filterType: "PRICE_FILTER", tickSize: "0.0001" }, { filterType: "LOT_SIZE", stepSize: "0.1" }],
});
// A symbol Binance lists and TradingView does not (the table's not_on_tv): only Binance's lot step exists for it.
SPOT_INFO.symbols.push({
  symbol: "AIXBTUSDC", status: "TRADING", baseAsset: "AIXBT", quoteAsset: "USDC",
  filters: [{ filterType: "PRICE_FILTER", tickSize: "0.0001" }, { filterType: "LOT_SIZE", stepSize: "0.01" }],
});
// ... and the same on USD-M (the table's usdt_perp not_on_tv has this one symbol).
FAPI_INFO.symbols.push({
  symbol: "STGUSDT", status: "TRADING", contractType: "PERPETUAL", baseAsset: "STG", quoteAsset: "USDT",
  filters: [{ filterType: "PRICE_FILTER", tickSize: "0.0001" }, { filterType: "LOT_SIZE", stepSize: "1" }],
});
FAPI_INFO.symbols.push({
  symbol: "NEWCOINUSDT", status: "TRADING", contractType: "PERPETUAL", baseAsset: "NEWCOIN", quoteAsset: "USDT",
  filters: [{ filterType: "PRICE_FILTER", tickSize: "0.001" }, { filterType: "LOT_SIZE", stepSize: "10" }],
});
const EXCHANGE_WARNING = (label: string) =>
  `lot size for ${label} is the exchange's lot step, not a TradingView reading: order quantities may differ from TradingView's`;
const DEFAULT_WARNING = (label: string) =>
  `lot size for ${label} is TradingView's usual default (0.001), not a reading for this symbol (a listing newer than the readings): ` +
  "order quantities may differ from TradingView's";
const NO_MARKET_WARNING = (symbol: string) =>
  `market not given: spot assumed for ${symbol} (pass market "usdt_perp" for a USD-M perpetual)`;
const KLINES = [1000, 2000, 3000].map((t) => [t, "1", "2", "0.5", "1.5", "10", t + 999, "1", 1, "1", "1", "0"]);
const PINE = '//@version=6\nstrategy("x")\n';
const HEADER = "timestamp,open,high,low,close,volume";

let dir: string;
let client: Client;
const calls: BacktestCall[] = [];
let bigReport = false;
let reportSyminfo: "echo" | "missing" | "unapplied" = "echo";
let tradeQuantities: Array<{ qty: number; open_at_end?: boolean }> | undefined; // the engine's trades, when a case sets them
let runnerNotices: string[] = []; // what the fake runner reports as having done differently (an overlay it went without)
let engineOwnWarnings: unknown; // a top-level `warnings` in the engine's own report, when a case sets one
const realFetch = globalThis.fetch;
const realNow = Date.now;
let hits: string[] = [];
let signals: Array<AbortSignal | null | undefined> = [];
let binanceDown = false;
let shift = 0;

// The engine's report, as pf_run_json.py makes it: the instrument it applied is in applied_runtime.
const runner = {
  mode: "local",
  transpile: async () => "// cpp",
  async backtest(call: BacktestCall) {
    calls.push(call);
    call.notices?.push(...runnerNotices);
    return {
      engine: "pineforge",
      applied_inputs: {}, applied_overrides: {},
      applied_runtime: {
        input_tf: "",
        ...(reportSyminfo === "echo" ? { syminfo: call.instrument }
          : reportSyminfo === "unapplied" ? { syminfo: { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "run_json.py was not given the instrument file (--syminfo)" } } : {}),
      },
      ...(engineOwnWarnings !== undefined ? { warnings: engineOwnWarnings } : {}),
      elapsed_seconds: 0.1,
      summary: { total_trades: 1, net_pnl: 1 },
      trades: tradeQuantities ?? (bigReport ? Array.from({ length: 4000 }, (_, i) => ({ n: i, side: "long", entry_price: 1, exit_price: 2 })) : [{ n: 1 }]),
    };
  },
  engineInfo: async () => ({ mode: "local", baked_in: true, version: null }),
  checkImage: async () => ({ mode: "local", baked_in: true, version: null }),
  pullImage: async (image: string) => ({ image, pulled: false, output: "" }),
} as unknown as EngineRunner;

before(async () => {
  assert.notEqual(process.env.PINEFORGE_ALLOW_ANYWHERE, "1", "these cases need the cwd scope");
  dir = mkdtempSync(join(process.cwd(), "test", ".tmp-pf-syminfo-"));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hits.push(url);
    signals.push(init?.signal);
    if (url.includes("/exchangeInfo")) {
      if (binanceDown) return new Response("Service unavailable from a restricted location", { status: 451 });
      return new Response(JSON.stringify(url.includes("fapi") ? FAPI_INFO : SPOT_INFO));
    }
    if (url.includes("/klines")) return new Response(JSON.stringify(KLINES));
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(runner, { imageTools: false }).connect(b);
  client = new Client({ name: "syminfo-test", version: "0.0.0" });
  await client.connect(a);
});

after(async () => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  hits = [];
  signals = [];
  binanceDown = false;
  bigReport = false;
  reportSyminfo = "echo";
  tradeQuantities = undefined;
  runnerNotices = [];
  engineOwnWarnings = undefined;
  // exchangeInfo is cached for 5 minutes in process: step past it so each case starts cold
  shift += 6 * 60_000;
  Date.now = () => realNow() + shift;
});

let n = 0;
function bars(): string {
  const path = join(dir, `bars-${++n}.csv`);
  writeFileSync(path, `${HEADER}\n1000,1,2,0.5,1.5,10\n2000,1,2,0.5,1.5,10\n3000,1,2,0.5,1.5,10\n`);
  return path;
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
  let data: Record<string, any> | undefined;
  try { data = JSON.parse(text); } catch { /* an error message */ }
  return { isError: r.isError === true, text, data: data as Record<string, any> };
}

const backtest = (args: Record<string, unknown>) => call("backtest_pine", { source: PINE, ohlcv_csv_path: bars(), ...args });

// ─── the tool schemas ─────────────────────────────────────────────────────

test("backtest_pine and backtest_pine_grid take symbol, market and a strict syminfo", async () => {
  const { tools } = await client.listTools();
  for (const name of ["backtest_pine", "backtest_pine_grid"]) {
    const props = (tools.find((t) => t.name === name)!.inputSchema as any).properties;
    assert.deepEqual(props.market.enum, ["spot", "usdt_perp"], name);
    assert.equal(props.symbol.type, "string", name);
    assert.deepEqual(Object.keys(props.syminfo.properties).sort(),
      ["basecurrency", "currency", "mincontract", "mintick", "pointvalue", "qty_step", "type"], name);
    assert.equal(props.syminfo.additionalProperties, false, name);
    assert.match(props.symbol.description, /TradingView's own reading for the symbol/);
    assert.match(props.symbol.description, /exchangeInfo/);
    assert.match(props.syminfo.description, /ticker, tickerid, timezone and session are not applied/);
  }
  const fetchTool = tools.find((t) => t.name === "fetch_binance_ohlcv")!;
  assert.match(fetchTool.description!, /\.instrument\.json/);
});

test("bad syminfo values are refused with the reason, not silently dropped", async () => {
  for (const syminfo of [{ qty_step: -1 }, { qty_step: 0 }, { mintick: 1e13 }, { type: "cré" }, { timezone: "UTC" },
    { ticker: "BTCUSDT" }, { tickerid: "BINANCE:BTCUSDT" }]) {
    const r = await backtest({ syminfo });
    assert.equal(r.isError, true, JSON.stringify(syminfo));
  }
  assert.equal(calls.length, 0);
});

// ─── backtest_pine ────────────────────────────────────────────────────────

test("symbol: TradingView's lot size from the embedded table reaches the runner; tick and currencies from exchangeInfo", async () => {
  const r = await backtest({ symbol: "btcusdt", market: "spot" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls.length, 1);
  const inst = calls[0]!.instrument!;
  assert.deepEqual(inst, {
    schema: INSTRUMENT_SCHEMA, resolved: true, qty_step: 0.00001, mincontract: 0.00001, mintick: 0.01, pointvalue: 1,
    type: "crypto", currency: "USDT", basecurrency: "BTC",
    source: { kind: "tradingview", market: "spot", symbol: "BTCUSDT", via: "symbol" },
  });
  assert.deepEqual(r.data.applied_runtime.syminfo, inst, "what the engine applied is in the result");
  assert.equal(r.data.warnings, undefined);
  assert.equal(hits.filter((u) => u.includes("/exchangeInfo")).length, 1);
});

test("symbol with market usdt_perp: the USD-M exchangeInfo for the tick, TradingView's 0.000001 over Binance's 0.001 for the lot", async () => {
  const r = await backtest({ symbol: "BTCUSDT", market: "usdt_perp" });
  assert.equal(r.isError, false, r.text);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.qty_step, inst.mincontract, inst.mintick, inst.source!.kind], [0.000001, 0.000001, 0.1, "tradingview"]);
  assert.ok(hits.some((u) => u.includes("/fapi/v1/exchangeInfo")));
  assert.equal(r.data.warnings, undefined);
});

test("a listing newer than the table gets TradingView's usual 0.001 (not Binance's 0.1), and the result says so", async () => {
  const r = await backtest({ symbol: "NEWCOINUSDT", market: "spot" });
  assert.equal(r.isError, false, r.text);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.resolved, inst.qty_step, inst.mintick, inst.source!.kind], [true, 0.001, 0.0001, "default"]);
  assert.deepEqual(r.data.warnings, [DEFAULT_WARNING("Binance spot NEWCOINUSDT")]);
  assert.equal(r.data.applied_runtime.syminfo.source.kind, "default", "the report says where the lot size is from");
});

test("a symbol TradingView does not list gets Binance's lot step, kind exchange, and the exchange warning", async () => {
  const r = await backtest({ symbol: "AIXBTUSDC", market: "spot" });
  assert.equal(r.isError, false, r.text);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.resolved, inst.qty_step, inst.mintick, inst.source!.kind], [true, 0.01, 0.0001, "exchange"]);
  assert.deepEqual(r.data.warnings, [EXCHANGE_WARNING("Binance spot AIXBTUSDC")]);
  assert.equal(r.data.applied_runtime.syminfo.source.kind, "exchange");
});

test("USD-M: a listing newer than the table gets 0.001 too; the one symbol TradingView does not list there gets Binance's step", async () => {
  const fresh = await backtest({ symbol: "NEWCOINUSDT", market: "usdt_perp" });
  assert.equal(fresh.isError, false, fresh.text);
  assert.deepEqual([calls[0]!.instrument!.qty_step, calls[0]!.instrument!.mintick, calls[0]!.instrument!.source!.kind], [0.001, 0.001, "default"]);
  assert.deepEqual(fresh.data.warnings, [DEFAULT_WARNING("Binance usdt_perp NEWCOINUSDT")]);
  const unlisted = await backtest({ symbol: "STGUSDT", market: "usdt_perp" });
  assert.equal(unlisted.isError, false, unlisted.text);
  assert.deepEqual([calls[1]!.instrument!.qty_step, calls[1]!.instrument!.source!.kind], [1, "exchange"]);
  assert.deepEqual(unlisted.data.warnings, [EXCHANGE_WARNING("Binance usdt_perp STGUSDT")]);
});

// ─── `symbol` without `market` ────────────────────────────────────────────

test("symbol without market and no sidecar: spot is assumed and the result says so, for backtest_pine and backtest_pine_grid", async () => {
  const r = await backtest({ symbol: "BTCUSDT" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument!.source!.market, "spot");
  assert.deepEqual(r.data.warnings, [NO_MARKET_WARNING("BTCUSDT")]);
  const grid = await call("backtest_pine_grid", { source: PINE, ohlcv_csv_path: bars(), symbol: "BTCUSDT", overrides: { commission_value: [0.04, 0.1] } });
  assert.equal(grid.isError, false, grid.text);
  assert.deepEqual(grid.data.warnings, [NO_MARKET_WARNING("BTCUSDT")]);
  // given, it is not an assumption
  assert.equal((await backtest({ symbol: "BTCUSDT", market: "spot" })).data.warnings, undefined);
  assert.equal((await backtest({ symbol: "BTCUSDT", market: "usdt_perp" })).data.warnings, undefined);
});

// ─── the engine's own warnings never replace ours ─────────────────────────

test("a report that has its own top-level warnings: ours first, then the engine's strings (bounded), never instead of ours", async () => {
  engineOwnWarnings = ["engine says one", 7, null, "", { text: "not a string" }, "engine says two"];
  const r = await backtest({ symbol: "NEWCOINUSDT", market: "spot" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.data.warnings, [DEFAULT_WARNING("Binance spot NEWCOINUSDT"), "engine says one", "engine says two"]);
  assert.equal(Object.keys(r.data)[0], "warnings");
  assert.equal(r.data.engine, "pineforge", "the rest of the report is as it was");
  // a repeat of one of ours is not said twice; a very long one is cut; at most 20 of the engine's are kept
  engineOwnWarnings = [DEFAULT_WARNING("Binance spot NEWCOINUSDT"), "x".repeat(5000), ...Array.from({ length: 40 }, (_, i) => `engine ${i}`)];
  const many = await backtest({ symbol: "NEWCOINUSDT", market: "spot" });
  assert.equal(many.data.warnings[0], DEFAULT_WARNING("Binance spot NEWCOINUSDT"));
  assert.equal(many.data.warnings.filter((w: string) => w === DEFAULT_WARNING("Binance spot NEWCOINUSDT")).length, 1);
  assert.equal(many.data.warnings[1].length, 1000);
  assert.equal(many.data.warnings.length, 1 + 19, "ours, then the first 20 of the engine's (one of which was ours again)");
  assert.equal(many.data.warnings.at(-1), "engine 17");
  // not a list: ignored, ours stand
  engineOwnWarnings = "just a string";
  const text = await backtest({ symbol: "NEWCOINUSDT", market: "spot" });
  assert.deepEqual(text.data.warnings, [DEFAULT_WARNING("Binance spot NEWCOINUSDT")]);
  // with nothing of ours to say, theirs are still reported
  engineOwnWarnings = ["only the engine's"];
  const alone = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.deepEqual(alone.data.warnings, ["only the engine's"]);
});

test("a report too large to return inline keeps ours and the engine's warnings in its summary", async () => {
  bigReport = true;
  engineOwnWarnings = ["engine says one"];
  const r = await backtest({ symbol: "NEWCOINUSDT", market: "spot", report_path: join(dir, "big-report-warnings.json") });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.truncated, true);
  assert.deepEqual(r.data.warnings, [DEFAULT_WARNING("Binance spot NEWCOINUSDT"), "engine says one"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "big-report-warnings.json"), "utf8")).warnings, r.data.warnings);
});

test("every request to Binance has a timeout, so a stalled mirror cannot stall a backtest", async () => {
  const r = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(r.isError, false, r.text);
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal, "fetch got no abort signal");
});

test("syminfo alone: the user's values, no Binance call, resolved", async () => {
  const r = await backtest({ syminfo: { qty_step: 0.001, mintick: 0.5, pointvalue: 50, type: "futures" } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(hits, []);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.resolved, inst.qty_step, inst.mincontract, inst.mintick, inst.pointvalue, inst.type],
    [true, 0.001, 0.001, 0.5, 50, "futures"]);
  assert.deepEqual(inst.source, { kind: "user" });
  assert.equal(r.data.warnings, undefined);
});

test("syminfo wins over symbol", async () => {
  const r = await backtest({ symbol: "BTCUSDT", market: "spot", syminfo: { mintick: 0.5 } });
  assert.equal(r.isError, false, r.text);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.qty_step, inst.mintick, inst.source!.kind, inst.source!.overridden], [0.00001, 0.5, "user", ["mintick"]]);
});

test("nothing given and no sidecar: nothing is passed to the runner (the run is the image's own), and the result says so", async () => {
  const r = await backtest({});
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument, undefined, "an instrument with nothing to apply is not passed on");
  assert.equal("syminfo" in r.data.applied_runtime, false);
  assert.equal(r.data.warnings.length, 2);
  assert.match(r.data.warnings[0], /^instrument grid unavailable for bars-\d+\.csv \(no symbol, syminfo or sidecar was given\): order quantity is not floored to a lot size, so the run can contain sub-lot margin-call rows that TradingView does not book/);
  assert.equal(r.data.warnings[1], "no instrument was applied: the engine ran with its defaults (no lot size, tick 0.01, point value 1)");
  assert.equal(Object.keys(r.data)[0], "warnings");
  assert.deepEqual(hits, []);
});

test("Binance unreachable, symbol not in the table: still runs, unresolved, the reason and a warning", async () => {
  binanceDown = true;
  const r = await backtest({ symbol: "NEWCOINUSDT", market: "spot" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument, undefined);
  assert.match(r.data.warnings[0], /^instrument grid unavailable for Binance spot NEWCOINUSDT \(Binance spot exchangeInfo unavailable: Binance 451/);
  assert.match(r.data.warnings[1], /^no instrument was applied: the engine ran with its defaults/);
});

test("Binance unreachable, symbol in the table: TradingView's lot size is applied, the missing tick is said", async () => {
  binanceDown = true;
  const r = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(r.isError, false, r.text);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.resolved, inst.qty_step, inst.mintick, inst.source!.kind], [true, 0.00001, undefined, "tradingview"]);
  assert.equal(r.data.warnings.length, 2);
  assert.match(r.data.warnings[0], /^Binance spot exchangeInfo unavailable \(Binance 451.*\): the lot size is TradingView's, from the embedded table, but the tick size and currencies are not known$/);
  assert.match(r.data.warnings[1], /no mintick, so the engine's default tick of 0\.01 applies/);
});

test("a symbol Binance does not list: still runs, unresolved", async () => {
  const r = await backtest({ symbol: "NOPEUSDT", market: "spot" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument, undefined);
  assert.match(r.data.warnings[0], /\(NOPEUSDT is not in Binance spot exchangeInfo\)/);
  assert.equal(r.data.warnings.length, 2);
});

test("a report too large to return inline still states the instrument and the warnings", async () => {
  bigReport = true;
  const r = await backtest({ symbol: "BTCUSDT", market: "spot", report_path: join(dir, "big-report.json") });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.applied_runtime.syminfo.resolved, true);
  assert.equal(r.data.applied_runtime.syminfo.qty_step, 0.00001);
  assert.equal(JSON.parse(readFileSync(join(dir, "big-report.json"), "utf8")).applied_runtime.syminfo.qty_step, 0.00001);
  bigReport = true;
  const none = await backtest({ report_path: join(dir, "big-report-none.json") });
  assert.equal(none.data.truncated, true);
  assert.equal(none.data.warnings.length, 2, "the unresolved warning and the plain statement that nothing was applied");
  assert.match(none.data.warnings[1], /^no instrument was applied/);
});

test("an engine image that does not report or apply the instrument is named in the result", async () => {
  reportSyminfo = "missing";
  const missing = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(missing.isError, false, missing.text);
  assert.equal(missing.data.warnings.length, 1);
  assert.match(missing.data.warnings[0], /did not report the instrument it applied/);
  reportSyminfo = "unapplied";
  const unapplied = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(unapplied.data.warnings.length, 1);
  assert.match(unapplied.data.warnings[0], /did not apply the instrument's lot grid \(run_json\.py was not given the instrument file \(--syminfo\)\)/);
});

test("a runner that went without the overlay: its notice is the warning, and the engine is not asked what it applied", async () => {
  runnerNotices = ["the instrument could not be applied (the overlay of the engine prefix could not be built); the engine ran with its defaults"];
  reportSyminfo = "missing"; // an image's own report: no applied_runtime.syminfo
  const r = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.data.warnings, runnerNotices);
  const grid = await call("backtest_pine_grid", { source: PINE, ohlcv_csv_path: bars(), symbol: "BTCUSDT", market: "spot", overrides: { commission_value: [0.04, 0.1] } });
  assert.deepEqual(grid.data.warnings, runnerNotices, "once, not once per combination");
});

const FLOORED = [0.08166, 0.08031, 0.5, 0.00001].map((qty) => ({ qty }));

test("the engine says the lot size is applied and its trades are multiples of it: nothing to add", async () => {
  tradeQuantities = FLOORED;
  const r = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(r.data.warnings, undefined);
});

test("quantities that are not multiples of the reported lot size: the older-engine warning, counts exact", async () => {
  tradeQuantities = [...FLOORED, { qty: 2.5981822415754863e-8 }, { qty: 0.0816684 }];
  const r = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.deepEqual(r.data.warnings, [
    "the engine reported the lot size applied, but 2 of 6 trade quantities are not multiples of it (an older engine ignores it)",
  ]);
  // the report itself is not edited
  assert.equal(r.data.trades.length, 6);
  assert.equal(r.data.trades[4].qty, 2.5981822415754863e-8);
});

test("a lone range-end mark that is not a multiple is not counted; with others it is", async () => {
  tradeQuantities = [...FLOORED, { qty: 0.123456789, open_at_end: true }];
  const lone = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(lone.data.warnings, undefined);
  tradeQuantities = [...FLOORED, { qty: 0.123456789, open_at_end: true }, { qty: 1e-8 }];
  const both = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.match(both.data.warnings[0], /but 2 of 6 trade quantities are not multiples of it/);
});

test("the quantity check tolerates float rounding (1e-6 of a step) and the grid reports it once", async () => {
  tradeQuantities = [{ qty: 0.08166000000000001 }, { qty: 0.0816600000001 }, { qty: 0.3 }];
  const r = await backtest({ symbol: "BTCUSDT", market: "spot" });
  assert.equal(r.data.warnings, undefined, "0.08166 + 1e-13 is within 1e-6 of one 0.00001 step");
  tradeQuantities = [{ qty: 1e-8 }, { qty: 0.5 }];
  const grid = await call("backtest_pine_grid", { source: PINE, ohlcv_csv_path: bars(), symbol: "BTCUSDT", market: "spot", overrides: { commission_value: [0.04, 0.1, 0.2] } });
  assert.equal(grid.data.warnings.length, 1);
  assert.match(grid.data.warnings[0], /1 of 2 trade quantities/);
});

test("without a lot step in what the engine reports, quantities are not judged", async () => {
  tradeQuantities = [{ qty: 1e-8 }];
  const r = await backtest({ syminfo: { mintick: 0.5 } }); // unresolved: no lot size asked for, none applied
  assert.equal(r.data.warnings.some((w: string) => /not multiples/.test(w)), false);
});

test("the grid names an engine that did not apply the instrument once, not once per combination", async () => {
  reportSyminfo = "unapplied";
  const r = await call("backtest_pine_grid", {
    source: PINE, ohlcv_csv_path: bars(), symbol: "BTCUSDT", market: "spot", overrides: { commission_value: [0.04, 0.1, 0.2] },
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls.length, 3);
  assert.equal(r.data.warnings.length, 1);
});

// ─── fetch_binance_ohlcv and its sidecar ──────────────────────────────────

const fetchArgs = (out: string, extra: Record<string, unknown> = {}) =>
  ({ symbol: "BTCUSDT", interval: "4h", limit: 3, start_time: 1000, end_time: 3000, output_path: out, ...extra });

test("fetch_binance_ohlcv records the instrument next to the CSV and says so", async () => {
  const out = join(dir, "btc-4h.csv");
  const r = await call("fetch_binance_ohlcv", fetchArgs(out));
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.bars, 3);
  assert.equal(r.data.instrument_path, `${out}.instrument.json`);
  assert.equal(r.data.warnings, undefined);
  const inst = r.data.instrument;
  assert.deepEqual([inst.resolved, inst.qty_step, inst.mintick, inst.currency], [true, 0.00001, 0.01, "USDT"]);
  assert.equal("tickerid" in inst, false);
  assert.equal(inst.source.kind, "tradingview");
  assert.match(inst.source.fetched_at, /^\d{4}-\d\d-\d\dT/);
  const onDisk = JSON.parse(readFileSync(sidecarPath(out), "utf8"));
  assert.match(onDisk.csv.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(onDisk, { ...inst, csv: { interval: "4h", first_open_time: 1000, last_open_time: 3000, bars: 3, sha256: onDisk.csv.sha256 } });
});

test("backtest_pine finds the sidecar of a fetched CSV: no symbol, no lookup, no warning", async () => {
  const out = join(dir, "eth-4h.csv");
  await call("fetch_binance_ohlcv", fetchArgs(out, { symbol: "ETHUSDT" }));
  hits = [];
  const r = await call("backtest_pine", { source: PINE, ohlcv_csv_path: out });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(hits, []);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.resolved, inst.qty_step, inst.currency], [true, 0.0001, "USDT"]);
  assert.deepEqual(inst.source, { kind: "tradingview", market: "spot", symbol: "ETHUSDT", via: "sidecar" });
  assert.equal(inst.source!.fetched_at, undefined, "a fetch time would change the fingerprint of an identical run");
  assert.equal(r.data.warnings, undefined);
});

test("a sidecar the CSV no longer matches is ignored, and says why", async () => {
  const out = join(dir, "stale-4h.csv");
  await call("fetch_binance_ohlcv", fetchArgs(out));
  writeFileSync(out, `${HEADER}\n5000,1,2,0.5,1.5,10\n6000,1,2,0.5,1.5,10\n`);
  const r = await call("backtest_pine", { source: PINE, ohlcv_csv_path: out });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument, undefined);
  assert.match(r.data.warnings[0], /\(sidecar ignored: stale-4h\.csv\.instrument\.json was written for bars 1000\.\.3000 and the CSV now holds 5000\.\.6000\)/);
});

test("symbol without market keeps the market the CSV was fetched for; a market that disagrees is warned about", async () => {
  const out = join(dir, "eth-perp-4h.csv");
  await call("fetch_binance_ohlcv", fetchArgs(out, { symbol: "DOGEUSDT", market: "usdt_perp" }));
  shift += 6 * 60_000; // exchangeInfo is cached for 5 minutes: look it up again
  hits = [];
  const same = await call("backtest_pine", { source: PINE, ohlcv_csv_path: out, symbol: "DOGEUSDT" });
  assert.equal(same.isError, false, same.text);
  assert.ok(hits.some((u) => u.includes("/fapi/v1/exchangeInfo")), "the perpetual's exchangeInfo, not spot's");
  assert.deepEqual(calls[0]!.instrument!.source!.market, "usdt_perp");
  assert.equal(same.data.warnings, undefined);
  const other = await call("backtest_pine", { source: PINE, ohlcv_csv_path: out, symbol: "DOGEUSDT", market: "spot" });
  assert.equal(calls[1]!.instrument!.source!.market, "spot");
  assert.deepEqual(other.data.warnings, [
    "the CSV was fetched for usdt_perp (its sidecar says so), but market spot was given: the instrument is DOGEUSDT on spot",
  ]);
});

test("usdt_perp fetch records the USD-M instrument", async () => {
  const out = join(dir, "btc-perp.csv");
  const r = await call("fetch_binance_ohlcv", fetchArgs(out, { market: "usdt_perp" }));
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([r.data.instrument.qty_step, r.data.instrument.mintick, r.data.instrument.source.kind], [0.000001, 0.1, "tradingview"]);
});

test("fetch_binance_ohlcv records the lot size by the same tiers, and backtest_pine then warns from the sidecar", async () => {
  // a listing newer than the table: TradingView's usual 0.001, kind default
  const fresh = join(dir, "newcoin-4h.csv");
  const f = await call("fetch_binance_ohlcv", fetchArgs(fresh, { symbol: "NEWCOINUSDT" }));
  assert.equal(f.isError, false, f.text);
  assert.deepEqual([f.data.instrument.resolved, f.data.instrument.qty_step, f.data.instrument.source.kind], [true, 0.001, "default"]);
  assert.equal(JSON.parse(readFileSync(sidecarPath(fresh), "utf8")).source.kind, "default");
  hits = [];
  const r = await call("backtest_pine", { source: PINE, ohlcv_csv_path: fresh });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(hits, [], "the sidecar was enough: nothing was looked up");
  assert.deepEqual(calls.at(-1)!.instrument!.source, { kind: "default", market: "spot", symbol: "NEWCOINUSDT", via: "sidecar" });
  assert.deepEqual(r.data.warnings, [DEFAULT_WARNING("Binance spot NEWCOINUSDT")]);
  // a symbol TradingView does not list: Binance's lot step, kind exchange
  const unlisted = join(dir, "aixbt-4h.csv");
  const g = await call("fetch_binance_ohlcv", fetchArgs(unlisted, { symbol: "AIXBTUSDC" }));
  assert.equal(g.isError, false, g.text);
  assert.deepEqual([g.data.instrument.qty_step, g.data.instrument.source.kind], [0.01, "exchange"]);
  const r2 = await call("backtest_pine", { source: PINE, ohlcv_csv_path: unlisted });
  assert.deepEqual(r2.data.warnings, [EXCHANGE_WARNING("Binance spot AIXBTUSDC")]);
});

test("exchangeInfo down: the CSV is still written, no instrument, a warning, and a stale sidecar is removed", async () => {
  const out = join(dir, "down-4h.csv");
  await call("fetch_binance_ohlcv", fetchArgs(out));
  assert.equal(existsSync(sidecarPath(out)), true);
  binanceDown = true;
  shift += 6 * 60_000; // the earlier success is cached; step past it
  const r = await call("fetch_binance_ohlcv", fetchArgs(out, { symbol: "ETHUSDT" }));
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.bars, 3);
  assert.equal(r.data.instrument.resolved, false);
  assert.equal(r.data.instrument_path, null);
  assert.match(r.data.warnings[0], /no instrument recorded next to the CSV \(Binance 451/);
  assert.equal(existsSync(out), true);
  assert.equal(existsSync(sidecarPath(out)), false, "a sidecar of the previous symbol must not describe the new CSV");
});

// ─── backtest_pine_grid ───────────────────────────────────────────────────

test("backtest_pine_grid applies one instrument to every combination and shows it", async () => {
  const r = await call("backtest_pine_grid", {
    source: PINE, ohlcv_csv_path: bars(), symbol: "BTCUSDT", market: "spot",
    overrides: { commission_value: [0.04, 0.1] },
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.instrument!.qty_step, 0.00001);
  assert.equal(r.data.instrument.resolved, true);
  assert.equal(r.data.instrument.source.symbol, "BTCUSDT");
  assert.equal(r.data.warnings, undefined);
});

test("backtest_pine_grid warns when the grid is unknown", async () => {
  const r = await call("backtest_pine_grid", {
    source: PINE, ohlcv_csv_path: bars(), overrides: { commission_value: [0.04] },
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.instrument.resolved, false);
  assert.equal(calls[0]!.instrument, undefined);
  assert.equal(r.data.warnings.length, 2);
  assert.match(r.data.warnings[1], /^no instrument was applied/);
});
