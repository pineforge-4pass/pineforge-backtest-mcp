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
const KLINES = [1000, 2000, 3000].map((t) => [t, "1", "2", "0.5", "1.5", "10", t + 999, "1", 1, "1", "1", "0"]);
const PINE = '//@version=6\nstrategy("x")\n';
const HEADER = "timestamp,open,high,low,close,volume";

let dir: string;
let client: Client;
const calls: BacktestCall[] = [];
let bigReport = false;
let reportSyminfo: "echo" | "missing" | "unapplied" = "echo";
const realFetch = globalThis.fetch;
const realNow = Date.now;
let hits: string[] = [];
let binanceDown = false;
let shift = 0;

// The engine's report, as pf_run_json.py makes it: the instrument it applied is in applied_runtime.
const runner = {
  mode: "local",
  transpile: async () => "// cpp",
  async backtest(call: BacktestCall) {
    calls.push(call);
    return {
      engine: "pineforge",
      applied_inputs: {}, applied_overrides: {},
      applied_runtime: {
        input_tf: "",
        ...(reportSyminfo === "echo" ? { syminfo: call.instrument }
          : reportSyminfo === "unapplied" ? { syminfo: { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "no instrument was supplied" } } : {}),
      },
      elapsed_seconds: 0.1,
      summary: { total_trades: 1, net_pnl: 1 },
      trades: bigReport ? Array.from({ length: 4000 }, (_, i) => ({ n: i, side: "long", entry_price: 1, exit_price: 2 })) : [{ n: 1 }],
    };
  },
  engineInfo: async () => ({ mode: "local", baked_in: true, version: null }),
  checkImage: async () => ({ mode: "local", baked_in: true, version: null }),
  pullImage: async (image: string) => ({ image, pulled: false, output: "" }),
} as unknown as EngineRunner;

before(async () => {
  assert.notEqual(process.env.PINEFORGE_ALLOW_ANYWHERE, "1", "these cases need the cwd scope");
  dir = mkdtempSync(join(process.cwd(), "test", ".tmp-pf-syminfo-"));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    hits.push(url);
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
  binanceDown = false;
  bigReport = false;
  reportSyminfo = "echo";
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
      ["basecurrency", "currency", "mincontract", "mintick", "pointvalue", "qty_step", "ticker", "tickerid", "type"], name);
    assert.equal(props.syminfo.additionalProperties, false, name);
    assert.match(props.symbol.description, /exchangeInfo/);
    assert.match(props.syminfo.description, /Timezone and session are not applied/);
  }
  const fetchTool = tools.find((t) => t.name === "fetch_binance_ohlcv")!;
  assert.match(fetchTool.description!, /\.instrument\.json/);
});

test("bad syminfo values are refused with the reason, not silently dropped", async () => {
  for (const syminfo of [{ qty_step: -1 }, { qty_step: 0 }, { mintick: 1e13 }, { type: "cré" }, { timezone: "UTC" }]) {
    const r = await backtest({ syminfo });
    assert.equal(r.isError, true, JSON.stringify(syminfo));
  }
  assert.equal(calls.length, 0);
});

// ─── backtest_pine ────────────────────────────────────────────────────────

test("symbol: the lot grid comes from Binance's exchangeInfo and reaches the runner", async () => {
  const r = await backtest({ symbol: "btcusdt" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls.length, 1);
  const inst = calls[0]!.instrument!;
  assert.deepEqual(
    [inst.schema, inst.resolved, inst.qty_step, inst.mincontract, inst.mintick, inst.pointvalue, inst.type, inst.ticker, inst.tickerid, inst.currency, inst.basecurrency],
    [INSTRUMENT_SCHEMA, true, 0.00001, 0.00001, 0.01, 1, "crypto", "BTCUSDT", "BINANCE:BTCUSDT", "USDT", "BTC"],
  );
  assert.deepEqual(inst.source, { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT", via: "symbol" });
  assert.deepEqual(r.data.applied_runtime.syminfo, inst, "what the engine applied is in the result");
  assert.equal(r.data.warnings, undefined);
  assert.equal(hits.filter((u) => u.includes("/exchangeInfo")).length, 1);
});

test("symbol with market usdt_perp reads the USD-M exchangeInfo", async () => {
  const r = await backtest({ symbol: "BTCUSDT", market: "usdt_perp" });
  assert.equal(r.isError, false, r.text);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.qty_step, inst.mintick, inst.tickerid], [0.001, 0.1, "BINANCE:BTCUSDT.P"]);
  assert.ok(hits.some((u) => u.startsWith("https://fapi.binance.com/fapi/v1/exchangeInfo")));
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
  const r = await backtest({ symbol: "BTCUSDT", syminfo: { mintick: 0.5 } });
  assert.equal(r.isError, false, r.text);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.qty_step, inst.mintick, inst.source!.kind, inst.source!.overridden], [0.00001, 0.5, "user", ["mintick"]]);
});

test("nothing given and no sidecar: the run goes ahead, resolved false, warning first in the result", async () => {
  const r = await backtest({});
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument!.resolved, false);
  assert.equal(r.data.applied_runtime.syminfo.resolved, false);
  assert.equal(r.data.applied_runtime.syminfo.reason, "no symbol, syminfo or sidecar was given");
  assert.equal(r.data.warnings.length, 1);
  assert.match(r.data.warnings[0], /^instrument grid unavailable for bars-\d+\.csv \(no symbol, syminfo or sidecar was given\): order quantity is not floored to a lot size, so the run can contain sub-lot margin-call rows that TradingView does not book/);
  assert.equal(Object.keys(r.data)[0], "warnings");
  assert.deepEqual(hits, []);
});

test("Binance unreachable: still runs, unresolved, the reason and a warning", async () => {
  binanceDown = true;
  const r = await backtest({ symbol: "BTCUSDT" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument!.resolved, false);
  assert.match(calls[0]!.instrument!.reason!, /^Binance spot exchangeInfo unavailable: Binance 451/);
  assert.match(r.data.warnings[0], /^instrument grid unavailable for Binance spot BTCUSDT \(Binance spot exchangeInfo unavailable/);
});

test("a symbol Binance does not list: still runs, unresolved", async () => {
  const r = await backtest({ symbol: "NOPEUSDT" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.applied_runtime.syminfo.reason, "NOPEUSDT is not in Binance spot exchangeInfo");
  assert.equal(r.data.warnings.length, 1);
});

test("a report too large to return inline still states the instrument and the warnings", async () => {
  bigReport = true;
  const r = await backtest({ report_path: join(dir, "big-report.json") });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.applied_runtime.syminfo.resolved, false);
  assert.equal(r.data.warnings.length, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "big-report.json"), "utf8")).applied_runtime.syminfo.resolved, false);
});

test("an engine image that does not report or apply the instrument is named in the result", async () => {
  reportSyminfo = "missing";
  const missing = await backtest({ symbol: "BTCUSDT" });
  assert.equal(missing.isError, false, missing.text);
  assert.equal(missing.data.warnings.length, 1);
  assert.match(missing.data.warnings[0], /did not report the instrument it applied/);
  reportSyminfo = "unapplied";
  const unapplied = await backtest({ symbol: "BTCUSDT" });
  assert.equal(unapplied.data.warnings.length, 1);
  assert.match(unapplied.data.warnings[0], /did not apply the instrument's lot grid \(no instrument was supplied\)/);
});

test("the grid names an engine that did not apply the instrument once, not once per combination", async () => {
  reportSyminfo = "unapplied";
  const r = await call("backtest_pine_grid", {
    source: PINE, ohlcv_csv_path: bars(), symbol: "BTCUSDT", overrides: { commission_value: [0.04, 0.1, 0.2] },
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
  assert.deepEqual([inst.resolved, inst.qty_step, inst.mintick, inst.tickerid], [true, 0.00001, 0.01, "BINANCE:BTCUSDT"]);
  assert.equal(inst.source.kind, "binance_exchange_info");
  assert.match(inst.source.fetched_at, /^\d{4}-\d\d-\d\dT/);
  const onDisk = JSON.parse(readFileSync(sidecarPath(out), "utf8"));
  assert.deepEqual(onDisk, { ...inst, csv: { interval: "4h", first_open_time: 1000, last_open_time: 3000, bars: 3 } });
});

test("backtest_pine finds the sidecar of a fetched CSV: no symbol, no lookup, no warning", async () => {
  const out = join(dir, "eth-4h.csv");
  await call("fetch_binance_ohlcv", fetchArgs(out, { symbol: "ETHUSDT" }));
  hits = [];
  const r = await call("backtest_pine", { source: PINE, ohlcv_csv_path: out });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(hits, []);
  const inst = calls[0]!.instrument!;
  assert.deepEqual([inst.resolved, inst.qty_step, inst.ticker], [true, 0.0001, "ETHUSDT"]);
  assert.deepEqual(inst.source, { kind: "binance_exchange_info", market: "spot", symbol: "ETHUSDT", via: "sidecar" });
  assert.equal(inst.source!.fetched_at, undefined, "a fetch time would change the fingerprint of an identical run");
  assert.equal(r.data.warnings, undefined);
});

test("a sidecar the CSV no longer matches is ignored, and says why", async () => {
  const out = join(dir, "stale-4h.csv");
  await call("fetch_binance_ohlcv", fetchArgs(out));
  writeFileSync(out, `${HEADER}\n5000,1,2,0.5,1.5,10\n6000,1,2,0.5,1.5,10\n`);
  const r = await call("backtest_pine", { source: PINE, ohlcv_csv_path: out });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0]!.instrument!.resolved, false);
  assert.match(calls[0]!.instrument!.reason!, /^sidecar ignored: stale-4h\.csv\.instrument\.json was written for bars 1000\.\.3000 and the CSV now holds 5000\.\.6000/);
});

test("usdt_perp fetch records the USD-M instrument", async () => {
  const out = join(dir, "btc-perp.csv");
  const r = await call("fetch_binance_ohlcv", fetchArgs(out, { market: "usdt_perp" }));
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([r.data.instrument.qty_step, r.data.instrument.tickerid], [0.001, "BINANCE:BTCUSDT.P"]);
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
    source: PINE, ohlcv_csv_path: bars(), symbol: "BTCUSDT",
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
  assert.equal(r.data.warnings.length, 1);
});
