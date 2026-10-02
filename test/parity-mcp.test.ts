// check_tradingview_parity (and backtest_pine's shared path rule) through the
// public MCP interface: a real Client on an in-memory transport to the server
// createServer() builds, with a runner that records instead of running Docker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { EngineRunner, ParityCall } from "../src/engine.js";
import { reportXlsx, SAMPLE_PROPERTIES, zip } from "./fixtures/parity/xlsx.js";

const CSV = readFileSync(new URL("./fixtures/parity/tv_trades.csv", import.meta.url), "utf8");
const PINE = '//@version=6\nstrategy("x")\n';
const BARS = "timestamp,open,high,low,close,volume\n1743379200000,1,1,1,1,1\n";
const SECRET = "pf-secret-marker-7f3a";

const calls: ParityCall[] = [];
const runner = {
  mode: "local",
  async parity(call: ParityCall) {
    calls.push(call);
    return { ok: true, tier: "excellent", tier_meaning: "m", checks: [], matched: 5,
      unmatched_tradingview: 0, unmatched_pineforge: 0, mismatches: [], warnings: [] };
  },
  transpile: async () => "// cpp",
  backtest: async () => ({ ok: true }),
  engineInfo: async () => ({ mode: "local", baked_in: true, version: null }),
  checkImage: async () => ({ mode: "local", baked_in: true, version: null }),
  pullImage: async (image: string) => ({ image, pulled: false, output: "" }),
} as unknown as EngineRunner;

let client: Client;
let outside: string;   // a folder outside cwd
let inside: string;    // a folder inside cwd
const base = { pine: PINE, tradingview_trades: CSV, timeframe: "15", range_start: "2025-03-31T00:00:00Z", chart_timezone: "Asia/Taipei" };

before(async () => {
  assert.notEqual(process.env.PINEFORGE_ALLOW_ANYWHERE, "1", "these cases need the cwd scope");
  outside = mkdtempSync(join(tmpdir(), "pf-mcp-outside-"));
  writeFileSync(join(outside, "bars.csv"), BARS);
  writeFileSync(join(outside, "secret.txt"), `${SECRET}\nmore\n`);
  inside = mkdtempSync(join(process.cwd(), "test", ".tmp-pf-mcp-"));
  symlinkSync(join(outside, "bars.csv"), join(inside, "link.csv"));
  mkdirSync(join(inside, "sub"));
  symlinkSync(outside, join(inside, "sub", "dir-link"));
  writeFileSync(join(inside, "secret.csv"), `${SECRET}\nmore\n`);
  writeFileSync(join(inside, "bars.csv"), BARS);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(runner, { imageTools: false }).connect(b);
  client = new Client({ name: "parity-mcp-test", version: "0.0.0" });
  await client.connect(a);
});

after(async () => {
  await client?.close();
  rmSync(inside, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function parity(args: Record<string, unknown>) {
  const r = await client.callTool({ name: "check_tradingview_parity", arguments: args });
  return { isError: r.isError === true, data: r.structuredContent as Record<string, any>, text: JSON.stringify(r.content) };
}

test("a bars path inside cwd is used", async () => {
  const n = calls.length;
  const r = await parity({ ...base, ohlcv_csv_path: join(inside, "bars.csv") });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls.length, n + 1);
});

test("bars paths that leave cwd are refused: absolute, absolute with '..', relative '..', symlinked file and folder", async () => {
  const cwd = process.cwd();
  const escapes = [
    join(outside, "bars.csv"),
    `${cwd}/${"../".repeat(cwd.split("/").length)}${outside.slice(1)}/bars.csv`,
    relative(cwd, join(outside, "bars.csv")),
    join(inside, "link.csv"),
    join(inside, "sub", "dir-link", "bars.csv"),
  ];
  const n = calls.length;
  for (const p of escapes) {
    const r = await parity({ ...base, ohlcv_csv_path: p });
    assert.equal(r.isError, true, p);
    assert.equal(r.data.error, "no_bars", p);
    assert.match(String(r.data.message), /is outside cwd .*after resolving '\.\.' and symlinks/, p);
  }
  assert.equal(calls.length, n, "nothing outside cwd reached the runner");
});

test("backtest_pine shares the rule: '..' and symlink escapes are refused", async () => {
  const cwd = process.cwd();
  for (const p of [`${cwd}/${"../".repeat(cwd.split("/").length)}${outside.slice(1)}/bars.csv`, join(inside, "link.csv")]) {
    const r = await client.callTool({ name: "backtest_pine", arguments: { source: PINE, ohlcv_csv_path: p } });
    assert.equal(r.isError, true, p);
    assert.match(JSON.stringify(r.content), /is outside cwd/, p);
  }
});

test("a file that is not bars is refused without echoing its content", async () => {
  const r = await parity({ ...base, ohlcv_csv_path: join(inside, "secret.csv") });
  assert.equal(r.data.error, "no_bars");
  assert.ok(!r.text.includes(SECRET), r.text);
  const b = await client.callTool({ name: "backtest_pine", arguments: { source: PINE, ohlcv_csv_path: join(inside, "secret.csv") } });
  assert.equal(b.isError, true);
  assert.ok(!JSON.stringify(b.content).includes(SECRET), JSON.stringify(b.content));
});

test("a sparse-coordinate XLSX gets a typed error and the server keeps serving", async () => {
  const bomb = zip([
    { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="List of trades" r:id="rId1"/></sheets></workbook>') },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row r="1"><c r="ZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>') },
  ]).toString("base64");
  const r = await parity({ ...base, tradingview_trades: bomb, ohlcv_csv_path: join(inside, "bars.csv") });
  assert.equal(r.data.error, "bad_trades_csv");
  assert.match(String(r.data.message), /outside Excel's grid/);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "check_tradingview_parity"));
  const ok = await parity({ ...base, ohlcv_csv_path: join(inside, "bars.csv") });
  assert.equal(ok.isError, false);
});

test("XLSX Properties range in a DST fold: entry inside it is not 'before the range start' (Europe/Berlin)", async () => {
  const tape = "Trade number,Type,Date and time,Signal,Price USDT,Size (qty),Net PnL USDT\n" +
    "1,Exit long,2025-10-26 02:45,x,103,1,1\n1,Entry long,2025-10-26 02:30,L,101,1,1\n";
  const props = SAMPLE_PROPERTIES.map((row) => (row[0] === "Trading range" ? ["Trading range", "2025-10-26 02:15 — 2025-10-26 02:45"] : row));
  const xlsx = reportXlsx(tape, props).toString("base64");
  const n = calls.length;
  const r = await parity({ pine: PINE, tradingview_trades: xlsx, chart_timezone: "Europe/Berlin", ohlcv_csv_path: join(inside, "bars.csv") });
  assert.equal(r.isError, false, r.text);
  const req = calls[n]!.request;
  assert.equal(req.range_start_ms, 1761437700000); // 00:15Z, Python's fold=0 reading
  assert.equal(req.range_end_ms, 1761439500000);
  const same = await parity({ pine: PINE, tradingview_trades: xlsx, chart_timezone: "Europe/Berlin", range_start: "2025-10-26T00:15:00Z", ohlcv_csv_path: join(inside, "bars.csv") });
  assert.equal(same.isError, false, same.text);
});
