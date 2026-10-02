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
function fakeRunner(): EngineRunner & { calls: ParityCall[]; bars: string[] } {
  const calls: ParityCall[] = [];
  const bars: string[] = [];
  return {
    mode: "local",
    calls,
    bars,
    async parity(call: ParityCall) {
      calls.push(call);
      bars.push(readFileSync(call.barsPath, "utf8"));
      return { ok: true, tier: "excellent", tier_meaning: "m", checks: [], matched: 5,
        unmatched_tradingview: 0, unmatched_pineforge: 0, mismatches: [], warnings: [] };
    },
    transpile: async () => "", backtest: async () => ({}), engineInfo: async () => ({ mode: "local", baked_in: true, version: null }),
    checkImage: async () => ({ mode: "local", baked_in: true, version: null }),
    pullImage: async (image: string) => ({ image, pulled: false, output: "" }),
  } as EngineRunner & { calls: ParityCall[]; bars: string[] };
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
    const res = await runner.parity({ request: { pine: PINE, max_mismatches: 3 }, barsPath: path }) as Record<string, any>;
    assert.equal(res.ok, true);
    assert.equal(res.ohlcv_csv_path, path);
    assert.equal(res.bars_head, "timestamp,open,high,low,close,volume");
    assert.equal(res.workdir_exists, true);
    assert.equal(existsSync(res.workdir), false, "jail left behind");
    assert.equal(res.timeout_ms, "600000");
    assert.equal(res.request.max_mismatches, 3);
    await assert.rejects(runner.parity({ request: { pine: "exit 3" }, barsPath: path }), /grading core failed \(exit 3\):\ndriver failed on purpose/);
  } finally {
    delete process.env.PINEFORGE_PARITY_DIR;
  }
});
