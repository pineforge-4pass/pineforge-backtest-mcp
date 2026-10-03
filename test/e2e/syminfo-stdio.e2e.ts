/**
 * stdio E2E for the instrument grid: a real MCP client spawns the server and runs
 * backtest_pine on a frozen BTCUSDT 4h feed (EMA 20/50 crossover, 100% of equity,
 * 0.1% commission) through the real engine image. Without an instrument the engine
 * books five sub-lot margin-call rows (27 rows; the first is 2.598e-08 BTC); with the
 * instrument's lot size it books none (22 rows). Every row is compared with the ones
 * the engine harness produced on the same feed (test/fixtures/syminfo).
 *
 *   PF_E2E_SYMINFO_CSV   the frozen feed (2188 bars; sha256 checked), on this machine
 *   PF_E2E_SYMINFO_PINE  the Pine file, default test/fixtures/syminfo/btc-ema-crossover.pine
 *   PF_E2E_SERVER        JSON argv of the server, default ["node","dist/index.js"] (the Docker runner,
 *                        on this machine's docker daemon)
 *   PF_E2E_DOCKER_IMAGE  instead: run the Glama image (the in-process runner) with `docker run -i
 *                        --network host --user <uid>:<gid> -v $PF_E2E_MOUNT:/work`; then also set
 *                        PF_E2E_MOUNT (a host dir holding the feed and the workdir),
 *                        PF_E2E_PATH_MAP="$PF_E2E_MOUNT=/work" and PF_E2E_STUB_PORT
 *   PF_E2E_PATH_MAP      "<host prefix>=<server prefix>" for paths in tool args (Docker image)
 *   PF_E2E_STUB_PORT     port of the local Binance stub (default: any free one)
 *   PF_E2E_WORKDIR       where fetch_binance_ohlcv writes (default test/.tmp-e2e-syminfo-<time>)
 *
 * The stub serves the recorded exchangeInfo (test/fixtures/binance) and the feed's own
 * klines, so the box needs no Binance. The server is started with the stub's URLs and
 * PINEFORGE_MAX_INLINE_BYTES raised (the report is ~265 KB).
 *
 * Run: node --import tsx --test test/e2e/syminfo-stdio.e2e.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connect, pathMapper } from "./client.js";

/** The server under test, started with `env` (the stub's URLs, the inline limit). */
function startServer(env: Record<string, string>): Promise<Client> {
  const image = process.env.PF_E2E_DOCKER_IMAGE;
  if (!image) return connect({ env });
  const mount = process.env.PF_E2E_MOUNT;
  assert.ok(mount, "PF_E2E_DOCKER_IMAGE needs PF_E2E_MOUNT");
  const flags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return connect({
    argv: ["docker", "run", "-i", "--rm", "--network", "host", "--user", `${process.getuid!()}:${process.getgid!()}`,
      "-v", `${mount}:/work`, ...flags, image],
  });
}

const here = (rel: string) => new URL(rel, import.meta.url);
const EXPECTED = JSON.parse(readFileSync(here("../fixtures/syminfo/btcusdt-4h-ema-trades.json"), "utf8")) as {
  pine_sha256: string; csv_sha256: string; bars: number; gridless: Row[]; gridded: Row[];
};
const SPOT_INFO = readFileSync(here("../fixtures/binance/spot-exchangeinfo.json"), "utf8");
const FAPI_INFO = readFileSync(here("../fixtures/binance/fapi-exchangeinfo.json"), "utf8");

const CSV_PATH = process.env.PF_E2E_SYMINFO_CSV;
const PINE_PATH = process.env.PF_E2E_SYMINFO_PINE ?? new URL("../fixtures/syminfo/btc-ema-crossover.pine", import.meta.url).pathname;
const map = pathMapper();
const WORKDIR = resolve(process.env.PF_E2E_WORKDIR ?? join(process.cwd(), "test", `.tmp-e2e-syminfo-${Date.now()}`));

// The 11 fields the px-dust lane compared, row by row.
const FIELDS = ["entry_time", "exit_time", "entry_price", "exit_price", "qty", "pnl", "commission",
  "entry_bar_index", "exit_bar_index", "open_at_end", "entry_incarnation"] as const;
type Row = Record<(typeof FIELDS)[number], number | boolean>;
const rowsOf = (trades: Array<Record<string, unknown>>): Row[] =>
  trades.map((t) => Object.fromEntries(FIELDS.map((f) => [f, t[f]])) as Row);

const DUST = 0.00001;
const INSTRUMENT = {
  qty_step: 0.00001, mintick: 0.01, pointvalue: 1, mincontract: 0.00001, type: "crypto",
  currency: "USDT", basecurrency: "BTC", ticker: "BTCUSDT", tickerid: "BINANCE:BTCUSDT",
};
const WARNING_START =
  "instrument grid unavailable for ";
const WARNING_BODY =
  "order quantity is not floored to a lot size, so the run can contain sub-lot margin-call rows that TradingView does not book";

let pine: string;
let feed: string;
let stub: Server;
let stubUrl: string;
const stubHits: string[] = [];
let client: Client;

function klinesOf(csv: string, start: number, end: number, limit: number): unknown[] {
  const out: unknown[] = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const [t, o, h, l, c, v] = line.split(",") as [string, string, string, string, string, string];
    const ts = Number(t);
    if (ts < start || ts > end) continue;
    out.push([ts, o, h, l, c, v, ts + 14_399_999, "0", 0, "0", "0", "0"]);
    if (out.length >= limit) break;
  }
  return out;
}

before(async () => {
  assert.ok(CSV_PATH, "PF_E2E_SYMINFO_CSV must name the frozen 2188-bar BTCUSDT 4h feed");
  feed = readFileSync(CSV_PATH, "utf8");
  pine = readFileSync(PINE_PATH, "utf8");
  assert.equal(createHash("sha256").update(feed).digest("hex"), EXPECTED.csv_sha256, "not the feed the expected rows were recorded on");
  assert.equal(createHash("sha256").update(pine).digest("hex"), EXPECTED.pine_sha256, "not the Pine the expected rows were recorded on");
  mkdirSync(WORKDIR, { recursive: true });

  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    stubHits.push(url.pathname);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v3/exchangeInfo") res.end(SPOT_INFO);
    else if (url.pathname === "/fapi/v1/exchangeInfo") res.end(FAPI_INFO);
    else if (url.pathname === "/api/v3/klines") {
      const q = url.searchParams;
      res.end(JSON.stringify(klinesOf(feed, Number(q.get("startTime") ?? 0), Number(q.get("endTime") ?? Infinity), Number(q.get("limit") ?? 1000))));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((ok) => stub.listen(Number(process.env.PF_E2E_STUB_PORT ?? 0), "127.0.0.1", ok));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  client = await startServer({
    PINEFORGE_BINANCE_SPOT_URL: stubUrl,
    PINEFORGE_BINANCE_FAPI_URL: stubUrl,
    PINEFORGE_MAX_INLINE_BYTES: "50000000",
  });
});

after(async () => {
  await client?.close();
  await new Promise<void>((ok) => (stub ? stub.close(() => ok()) : ok()));
  rmSync(WORKDIR, { recursive: true, force: true });
});

async function tool(name: string, args: Record<string, unknown>, c: Client = client) {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).map((x) => x.text ?? "").join("\n");
  assert.notEqual(r.isError, true, `${name} failed: ${text.slice(0, 600)}`);
  return JSON.parse(text) as Record<string, any>;
}

const backtest = (extra: Record<string, unknown> = {}, path = CSV_PATH!) =>
  tool("backtest_pine", { source: pine, ohlcv_csv_path: map(path), ...extra });

const summarize = (rows: Row[]) =>
  `${rows.length} rows, ${rows.filter((r) => (r.qty as number) < DUST).length} below ${DUST}` +
  (rows.length > 1 ? `, second row qty ${rows[1]!.qty}` : "");

test("BEFORE: no instrument given: the engine runs gridless (27 rows, 5 dust), and says so", async () => {
  const r = await backtest();
  const rows = rowsOf(r.trades);
  assert.deepEqual(rows, EXPECTED.gridless, `rows differ from the gridless engine tape (${summarize(rows)})`);
  assert.equal(rows.filter((x) => (x.qty as number) < DUST).length, 5);
  assert.equal(rows[1]!.qty, 2.5981822415754863e-08);
  assert.equal(r.applied_runtime.syminfo.resolved, false);
  assert.equal(r.applied_runtime.syminfo.reason, "no symbol, syminfo or sidecar was given");
  assert.equal(r.fingerprint.provenance.runtime.syminfo.resolved, false);
  assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1, `warnings: ${JSON.stringify(r.warnings)}`);
  assert.ok(r.warnings[0].startsWith(WARNING_START), r.warnings[0]);
  assert.ok(r.warnings[0].includes(`(no symbol, syminfo or sidecar was given): ${WARNING_BODY}`), r.warnings[0]);
});

test("AFTER: syminfo given: the lot grid is applied (22 rows, 0 dust), as the engine harness books it", async () => {
  const r = await backtest({ syminfo: INSTRUMENT });
  const rows = rowsOf(r.trades);
  assert.equal(rows.length, 22, `expected 22 rows, got ${summarize(rows)}`);
  assert.equal(rows.filter((x) => (x.qty as number) < DUST).length, 0, `dust rows remain: ${summarize(rows)}`);
  assert.equal(rows[0]!.qty, 0.08166000000000001);
  assert.equal(rows[1]!.qty, 0.08031);
  assert.deepEqual(rows, EXPECTED.gridded);
  assert.equal(r.warnings, undefined);
  // what was applied is in the report and in the fingerprint
  const applied = r.applied_runtime.syminfo;
  assert.deepEqual(
    { ...applied, source: undefined },
    { schema: "pineforge-instrument/v1", resolved: true, ...INSTRUMENT, source: undefined },
  );
  assert.deepEqual(applied.source, { kind: "user" });
  assert.deepEqual(r.fingerprint.provenance.runtime.syminfo, applied);
  assert.equal(r.applied_runtime.input_tf, "", "the engine's own applied_runtime fields are still there");
  assert.equal(r.summary.total_trades, 22);
});

test("a gridless and a gridded run never share a fingerprint", async () => {
  const gridless = await backtest();
  const gridded = await backtest({ syminfo: INSTRUMENT });
  assert.match(gridless.fingerprint.digest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(gridless.fingerprint.digest, gridded.fingerprint.digest);
  // and the same instrument twice is the same fingerprint (nothing volatile in what is applied)
  const again = await backtest({ syminfo: INSTRUMENT });
  assert.equal(again.fingerprint.digest, gridded.fingerprint.digest);
});

test("symbol: the instrument resolved from Binance's exchangeInfo gives the same rows", async () => {
  stubHits.length = 0;
  const r = await backtest({ symbol: "BTCUSDT" });
  assert.deepEqual(rowsOf(r.trades), EXPECTED.gridded);
  assert.deepEqual(stubHits, ["/api/v3/exchangeInfo"]);
  const applied = r.applied_runtime.syminfo;
  assert.deepEqual({ ...applied, source: undefined }, { schema: "pineforge-instrument/v1", resolved: true, ...INSTRUMENT, source: undefined });
  assert.deepEqual(applied.source, { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT", via: "symbol" });
  assert.equal(r.warnings, undefined);
});

test("fetch_binance_ohlcv records the instrument; backtest_pine uses it with no symbol", async () => {
  const out = join(WORKDIR, "btcusdt-4h.csv");
  const fetched = await tool("fetch_binance_ohlcv", {
    symbol: "BTCUSDT", interval: "4h", limit: EXPECTED.bars,
    start_time: 1759536000000, end_time: 1791028800000, output_path: map(out),
  });
  assert.equal(fetched.bars, EXPECTED.bars);
  assert.equal(fetched.instrument.resolved, true);
  assert.equal(fetched.instrument.qty_step, 0.00001);
  assert.equal(fetched.instrument.source.kind, "binance_exchange_info");
  assert.ok(String(fetched.instrument_path).endsWith("btcusdt-4h.csv.instrument.json"));
  assert.equal(fetched.warnings, undefined);
  assert.equal(readFileSync(out, "utf8"), feed, "the fetched CSV is the frozen feed");

  stubHits.length = 0;
  const r = await backtest({}, out);
  assert.deepEqual(rowsOf(r.trades), EXPECTED.gridded);
  assert.deepEqual(stubHits, [], "the sidecar was enough: nothing was looked up");
  assert.deepEqual(r.applied_runtime.syminfo.source, { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT", via: "sidecar" });
  assert.equal(r.warnings, undefined);
});

test("a report too large to return inline still carries the instrument and the warning", async () => {
  const small = await startServer({
    PINEFORGE_BINANCE_SPOT_URL: stubUrl, PINEFORGE_BINANCE_FAPI_URL: stubUrl, PINEFORGE_MAX_INLINE_BYTES: "20000",
  });
  try {
    const r = await tool("backtest_pine", {
      source: pine, ohlcv_csv_path: map(CSV_PATH!), report_path: map(join(WORKDIR, "offloaded.json")),
    }, small);
    assert.equal(r.truncated, true);
    assert.equal(r.applied_runtime.syminfo.resolved, false);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.total_trades, 27);
  } finally {
    await small.close();
  }
});
