import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EngineRunner, ParityCall } from "../src/engine.js";
import { parityToolResult, type ParityDeps } from "../src/parity-tool.js";
import { reportXlsx, SAMPLE_PROPERTIES } from "./fixtures/parity/xlsx.js";

const CSV = readFileSync(new URL("./fixtures/parity/tv_trades.csv", import.meta.url), "utf8");
const PINE = '//@version=6\nstrategy("x")\n';

// A runner that records the grading core's request instead of running it.
function fakeRunner(): EngineRunner & { calls: ParityCall[]; bars: string[]; magnifiers: Array<string | undefined> } {
  const calls: ParityCall[] = [];
  const bars: string[] = [];
  const magnifiers: Array<string | undefined> = [];
  return {
    mode: "local",
    calls,
    bars,
    magnifiers,
    async parity(call: ParityCall) {
      calls.push(call);
      bars.push(readFileSync(call.barsPath, "utf8"));
      magnifiers.push(call.magnifierBarsPath ? readFileSync(call.magnifierBarsPath, "utf8") : undefined);
      return { ok: true, tier: "excellent", tier_meaning: "m", checks: [], matched: 5,
        unmatched_tradingview: 0, unmatched_pineforge: 0, mismatches: [], warnings: [] };
    },
    transpile: async () => "", backtest: async () => ({}), engineInfo: async () => ({ mode: "local", baked_in: true, version: null }),
    checkImage: async () => ({ mode: "local", baked_in: true, version: null }),
    pullImage: async (image: string) => ({ image, pulled: false, output: "" }),
  } as EngineRunner & { calls: ParityCall[]; bars: string[]; magnifiers: Array<string | undefined> };
}

const fetched: Array<unknown[]> = [];
const deps: ParityDeps = {
  resolvePath: (p) => resolve(p),
  async fetchBinanceCsv(...a) {
    fetched.push(a);
    return { csv: "timestamp,open,high,low,close,volume\n1743379200000,1,1,1,1,1\n", bars: 1 };
  },
};

async function barsFile(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-"));
  const p = join(dir, "bars.csv");
  await writeFile(p, text);
  return p;
}

const base = { pine: PINE, tradingview_trades: CSV, timeframe: "15", range_start: "2025-03-31T00:00:00Z", chart_timezone: "Asia/Taipei" };

test("CSV + explicit settings + your bars: the core gets the request", async () => {
  const r = fakeRunner();
  const path = await barsFile("timestamp,open,high,low,close,volume\n1743379200000,1,1,1,1,1\n");
  const out = await parityToolResult(r, { ...base, ohlcv_csv_path: path, inputs: { "Max contracts": 5 } }, deps);
  assert.equal(out.isError, false);
  const req = r.calls[0]!.request;
  assert.equal(r.calls[0]!.barsPath, path);
  assert.equal(req.chart_timezone, "Asia/Taipei");
  assert.equal(req.timeframe, "15");
  assert.equal(req.range_start_ms, Date.UTC(2025, 2, 31));
  assert.equal(req.range_end_ms, null);
  assert.deepEqual(req.inputs, { "Max contracts": 5 });
  assert.equal(req.max_mismatches, 10);
  assert.equal("meta_passthrough" in req, false);
  assert.match(out.content[0]!.text, /^Tier: excellent/);
  assert.match(out.content[0]!.text, /Range end: not given, so the export's last row \(2025-04-01 08:00 Asia\/Taipei\) ends the run\./);
  assert.deepEqual(JSON.parse(out.content[1]!.text), out.structuredContent);
});

test("XLSX report: Properties fill the settings; a disagreeing input is an error naming both", async () => {
  const r = fakeRunner();
  const props = SAMPLE_PROPERTIES.map((r) => (r[0] === "Trading range" ? ["Trading range", "Mar 31, 2025, 00:00 — Apr 1, 2025, 08:00"] : r));
  const xlsx = reportXlsx(CSV, props).toString("base64");
  const ok = await parityToolResult(r, { pine: PINE, tradingview_trades: xlsx, chart_timezone: "Asia/Taipei" }, deps);
  assert.equal(ok.isError, false, ok.content[0]!.text);
  const req = r.calls[0]!.request;
  assert.equal(req.timeframe, "15");
  assert.equal(req.range_start_ms, Date.UTC(2025, 2, 30, 16, 0));
  assert.equal(req.range_end_ms, Date.UTC(2025, 3, 1, 0, 0));
  assert.deepEqual((req.strategy_overrides as Record<string, unknown>).pyramiding, 5);
  assert.deepEqual(fetched.at(-1)?.slice(0, 3), ["usdt_perp", "ETHUSDT", "15m"]);
  assert.match(ok.content[0]!.text, /From the export's Properties: symbol, timeframe, range_start, range_end/);
  const bad = await parityToolResult(r, { pine: PINE, tradingview_trades: xlsx, chart_timezone: "Asia/Taipei", timeframe: "60" }, deps);
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error, "conflicting_setting");
  assert.match(bad.content[0]!.text, /timeframe: you passed "60", the export's Properties say "15"/);
});

test("bars: TradingView chart export is converted; other symbols without bars are refused", async () => {
  const r = fakeRunner();
  const tv = await barsFile("time,open,high,low,close,Volume\n1743379200,10,11,9,10.5,100\n2025-03-31T00:15:00Z,10.5,12,10,11,50\n");
  const out = await parityToolResult(r, { ...base, ohlcv_csv_path: tv }, deps);
  assert.equal(out.isError, false, out.content[0]!.text);
  assert.equal(r.bars[0], "timestamp,open,high,low,close,volume\n1743379200000,10,11,9,10.5,100\n1743380100000,10.5,12,10,11,50\n");
  const bom = await barsFile("\uFEFFtimestamp,open,high,low,close,volume\n1743379200000,1,1,1,1,1\n");
  const withBom = await parityToolResult(r, { ...base, ohlcv_csv_path: bom }, deps);
  assert.equal(withBom.isError, false, withBom.content[0]!.text);
  assert.equal(r.bars.at(-1), "timestamp,open,high,low,close,volume\n1743379200000,1,1,1,1,1\n");
  const aapl = await parityToolResult(r, { ...base, symbol: "NASDAQ:AAPL" }, deps);
  assert.equal(aapl.structuredContent.error, "no_bars");
  assert.match(String(aapl.structuredContent.message), /NASDAQ:AAPL has no bars source here.*ohlcv_csv/);
  const down = await parityToolResult(r, { ...base, symbol: "BINANCE:NOPEUSDT" }, {
    ...deps,
    fetchBinanceCsv: async () => { throw new Error('Binance 400: {"code":-1121,"msg":"Invalid symbol."}'); },
  });
  assert.equal(down.structuredContent.error, "no_bars");
  assert.match(String(down.structuredContent.message), /Fetching BINANCE:NOPEUSDT 15m klines from Binance failed: Binance 400/);
  const none = await parityToolResult(r, { ...base }, deps);
  assert.equal(none.structuredContent.error, "missing_setting");
  const both = await parityToolResult(r, { ...base, ohlcv_csv: "x", ohlcv_csv_path: tv }, deps);
  assert.match(String(both.structuredContent.message), /not both/);
});

test("trades before the range start and oversized Binance ranges are refused before any run", async () => {
  const r = fakeRunner();
  const late = await parityToolResult(r, { ...base, symbol: "BINANCE:ETHUSDT.P", range_start: "2025-03-31T01:00:00Z" }, deps);
  assert.equal(late.structuredContent.error, "trades_before_range_start");
  const long = await parityToolResult(r, { ...base, symbol: "BINANCE:ETHUSDT.P", timeframe: "1", range_start: "2020-01-01" }, deps);
  assert.equal(long.structuredContent.error, "no_bars");
  assert.match(String(long.structuredContent.message), /fetch limit is 100000/);
  const big = await parityToolResult(r, { ...base, symbol: "BINANCE:ETHUSDT.P", pine: "x".repeat(256 * 1024 + 1) }, deps);
  assert.match(String(big.structuredContent.message), /larger than 256 KiB/);
  assert.equal(r.calls.length, 0);
});

test("LocalRunner.parity: request on stdin, bars path and a jail that is gone afterwards", async () => {
  process.env.PINEFORGE_PARITY_DIR = resolve("test/fixtures/fake-parity");
  try {
    const { LocalRunner } = await import("../src/engine.js");
    const runner = new LocalRunner(resolve("test/fixtures/fake-prefix"));
    const path = await barsFile("timestamp,open,high,low,close,volume\n1,1,1,1,1,1\n");
    const res = await runner.parity({ request: { pine: PINE, max_mismatches: 3 }, barsPath: path, magnifierBarsPath: path }) as Record<string, any>;
    assert.equal(res.ok, true);
    assert.equal(res.ohlcv_csv_path, path);
    assert.equal(res.bars_head, "timestamp,open,high,low,close,volume");
    assert.equal(res.workdir_exists, true);
    assert.equal(existsSync(res.workdir), false, "jail left behind");
    assert.equal(res.timeout_ms, "600000");
    assert.equal(res.request.max_mismatches, 3);
    assert.equal(res.request.magnifier_ohlcv_csv_path, path);
    await assert.rejects(runner.parity({ request: { pine: "exit 3" }, barsPath: path }), /grading core failed \(exit 3\):\ndriver failed on purpose/);
    // A process the driver leaves behind in the jail (its own session) is swept before parity() returns.
    const left = await runner.parity({ request: { pine: "orphan" }, barsPath: path }) as Record<string, any>;
    assert.equal(left.marked, true, "the request's processes carry PF_PARITY_REQUEST");
    assert.ok(Number.isInteger(left.orphan));
    assert.throws(() => process.kill(left.orphan, 0), /ESRCH/, "the orphan outlived parity()");
  } finally {
    delete process.env.PINEFORGE_PARITY_DIR;
  }
});

test("Binance magnifier fetch uses actual chart opens within the harness bounds, including the final bar's tail", async () => {
  const r = fakeRunner();
  const start = Date.UTC(2025, 2, 31);
  const fetched: unknown[][] = [];
  const head = "timestamp,open,high,low,close,volume\n";
  const out = await parityToolResult(r, {
    ...base, pine: 'strategy("x", use_bar_magnifier=((true)))', symbol: "BINANCE:ETHUSDT.P",
    range_end: "2025-03-31T00:30:00Z",
  }, {
    ...deps,
    async fetchBinanceCsv(...a) {
      fetched.push(a);
      // Include one padding bar past the harness end; the feed must stop before its tail.
      return { csv: head + [0, 15, 30, 45].map((m) => `${start + m * 60_000},1,1,1,1,1\n`).join(""), bars: 4 };
    },
  });
  assert.equal(out.isError, false, out.content[0]!.text);
  assert.deepEqual(fetched[1], ["usdt_perp", "ETHUSDT", "1m", start, start + 45 * 60_000 - 1, 45]);
  assert.ok(r.calls[0]!.magnifierBarsPath);
  assert.match(r.magnifiers[0]!, /^timestamp,/);
  assert.match(String(out.structuredContent.magnifier_bars_source), /Binance.*1m/);
  assert.equal(existsSync(r.calls[0]!.magnifierBarsPath!), false, "temporary magnifier feed removed after the run");
});

test("the Binance limit counts both feeds and refuses before fetching too many minute bars", async () => {
  const r = fakeRunner();
  const start = Date.UTC(2025, 2, 31);
  const end = start + 70 * 86_400_000;
  const calls: unknown[][] = [];
  const out = await parityToolResult(r, {
    ...base, pine: 'strategy("x", use_bar_magnifier=true)', symbol: "BINANCE:ETHUSDT.P",
    range_end: new Date(end).toISOString(),
  }, {
    ...deps,
    async fetchBinanceCsv(...a) {
      calls.push(a);
      return { csv: `timestamp,open,high,low,close,volume\n${start},1,1,1,1,1\n${end},1,1,1,1,1\n`, bars: 6722 };
    },
  });
  assert.equal(out.structuredContent.error, "no_bars");
  assert.match(String(out.structuredContent.message), /chart bars plus .*1-minute magnifier bars.*100000 bars in total/);
  assert.equal(calls.length, 1);
  assert.equal(r.calls.length, 0);
});

test("supplied magnifier feeds share the chart formats and do not cause a network fetch", async () => {
  const r = fakeRunner();
  const own = "timestamp,open,high,low,close,volume\n1743379200000,1,1,1,1,1\n";
  const tv = "time,open,high,low,close,Volume\n1743379200,1,1,1,1,1\n";
  const noNetwork = { ...deps, fetchBinanceCsv: async () => { throw new Error("unexpected fetch"); } };
  const args = { ...base, pine: 'strategy("x", use_bar_magnifier=true)', ohlcv_csv: own };
  for (const magnifier_ohlcv_csv of [own, tv, "\uFEFF" + own]) {
    const out = await parityToolResult(r, { ...args, magnifier_ohlcv_csv }, noNetwork);
    assert.equal(out.isError, false, out.content[0]!.text);
    assert.equal(r.magnifiers.at(-1), own);
    assert.equal(r.bars.at(-1), own);
  }
  const missing = await parityToolResult(r, args, noNetwork);
  assert.equal(missing.isError, false);
  assert.equal(r.calls.at(-1)!.magnifierBarsPath, undefined);
  const both = await parityToolResult(r, { ...args, magnifier_ohlcv_csv: own, magnifier_ohlcv_csv_path: "fine.csv" }, noNetwork);
  assert.equal(both.structuredContent.error, "bad_request");
  assert.match(String(both.structuredContent.message), /magnifier_ohlcv_csv or magnifier_ohlcv_csv_path, not both/);
});

test("feed selection: a multiline title keeps the declared magnifier; bar_magnifier false (input or XLSX) fetches and budgets no minute bars", async () => {
  const start = Date.UTC(2025, 2, 31);
  const head = "timestamp,open,high,low,close,volume\n";
  const run = async (extra: Record<string, unknown>, chartBars = 4, end = "2025-03-31T00:30:00Z") => {
    const r = fakeRunner();
    const fetched: unknown[][] = [];
    const out = await parityToolResult(r, { ...base, symbol: "BINANCE:ETHUSDT.P", range_end: end, ...extra }, {
      ...deps,
      async fetchBinanceCsv(...a) {
        fetched.push(a);
        return { csv: head + [0, 15, 30, 45].map((m) => `${start + m * 60_000},1,1,1,1,1\n`).join(""), bars: chartBars };
      },
    });
    return { out, fetched, r };
  };
  const multiline = await run({ pine: '//@version=6\nstrategy("""multi\nline""", use_bar_magnifier=true)\n' });
  assert.equal(multiline.out.isError, false, multiline.out.content[0]!.text);
  assert.deepEqual(multiline.fetched.map((a) => a[2]), ["15m", "1m"]);
  assert.ok(multiline.r.calls[0]!.magnifierBarsPath);
  const wrapped = await run({ pine: '//@version=6\nstrategy("multi\n     line", use_bar_magnifier=true)\n' });
  assert.deepEqual(wrapped.fetched.map((a) => a[2]), ["15m", "1m"]);
  // The review's case: 70 days of 15m bars would need 100,815 minute bars; with the magnifier off none are budgeted.
  const off = await run({ pine: 'strategy("x", use_bar_magnifier=true)', runtime: { bar_magnifier: false } }, 6722,
    new Date(start + 70 * 86_400_000).toISOString());
  assert.equal(off.out.isError, false, off.out.content[0]!.text);
  assert.deepEqual(off.fetched.map((a) => a[2]), ["15m"]);
  assert.equal(off.r.calls[0]!.magnifierBarsPath, undefined);
  const props = SAMPLE_PROPERTIES.map((row) => (row[0] === "Trading range" ? ["Trading range", "Mar 31, 2025, 00:00 — Mar 31, 2025, 08:30"] : row));
  const xlsx = reportXlsx(CSV, props).toString("base64");
  const fromXlsx = await run({ pine: 'strategy("x", use_bar_magnifier=true)', tradingview_trades: xlsx, timeframe: undefined, range_start: undefined, range_end: undefined });
  assert.equal(fromXlsx.out.isError, false, fromXlsx.out.content[0]!.text);
  assert.equal(fromXlsx.r.calls[0]!.request.runtime && (fromXlsx.r.calls[0]!.request.runtime as Record<string, unknown>).bar_magnifier, false);
  assert.deepEqual(fromXlsx.fetched.map((a) => a[2]), ["15m"]);
});
