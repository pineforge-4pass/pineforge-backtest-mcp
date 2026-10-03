// TradingView's lot sizes of the Binance symbols: the generated asset (shape, known values,
// its own hash), the script that writes it (deterministic, refuses a bad table), the loader,
// and that it ships (npm package, Docker image).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTvGrid, tvGridPath, tvLotStep, TV_GRID_SCHEMA } from "../src/tv-grid.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts", "sync-tv-grid.mjs");
const MINI = join(root, "test", "fixtures", "tv-grid", "mini-table.json");
const ASSET = join(root, "src", "tv-grid.generated.json");
const work = mkdtempSync(join(tmpdir(), "pf-tvgrid-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sync = (table: string, ...extra: string[]) =>
  spawnSync("node", [SCRIPT, table, ...extra], { encoding: "utf8" });

/** The text the script hashes: each market, then `symbol=value` per line, sorted. */
function canonical(g: { spot: Record<string, number>; usdt_perp: Record<string, number> }): string {
  return (["spot", "usdt_perp"] as const)
    .map((m) => `${m}\n${Object.keys(g[m]).sort().map((s) => `${s}=${g[m][s]}\n`).join("")}`)
    .join("");
}

// ─── the shipped asset ────────────────────────────────────────────────────

test("src/tv-grid.generated.json: shape, counts, and TradingView's own values for known symbols", () => {
  const g = parseTvGrid(readFileSync(ASSET, "utf8"));
  assert.equal(g.schema, TV_GRID_SCHEMA);
  assert.equal(g.source.schema, "pineforge-tv-syminfo-receipts/v1");
  assert.match(g.source.generated_utc, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(g.source.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(g.source.venues, { spot: "crypto.binance.com.spot", usdt_perp: "crypto.binance.com.perp-usdt" });
  assert.deepEqual(g.counts, { spot: Object.keys(g.spot).length, usdt_perp: Object.keys(g.usdt_perp).length });
  assert.ok(g.counts.spot > 1000 && g.counts.usdt_perp > 400, JSON.stringify(g.counts));
  // the values measured on TradingView directly
  assert.equal(g.spot.BTCUSDT, 0.00001);
  assert.equal(g.spot.ETHUSDT, 0.0001);
  assert.equal(g.usdt_perp.BTCUSDT, 0.000001);
  assert.equal(g.usdt_perp.ETHUSDT, 0.0001);
  assert.equal(g.spot.DOGEUSDT, 0.001);
  assert.equal(g.usdt_perp.DOGEUSDT, 0.001);
  // and where TradingView is not Binance's exchange step (spot XRP 0.1, spot DOGE 1, USD-M BTC 0.001)
  assert.equal(g.spot.XRPUSDT, 1);
});

test("the generated file's content hash matches its maps (a hand edit is noticed), and its symbols are sorted", () => {
  const g = parseTvGrid(readFileSync(ASSET, "utf8"));
  assert.equal(g.content_sha256, sha(canonical(g)));
  for (const m of ["spot", "usdt_perp"] as const) {
    const keys = Object.keys(g[m]);
    assert.deepEqual(keys, [...keys].sort(), `${m} is not sorted`);
  }
});

test("the recorded source sha256 is the table's: checked against the table when PF_TV_GRID_SOURCE names it", { skip: !process.env.PF_TV_GRID_SOURCE }, () => {
  const source = process.env.PF_TV_GRID_SOURCE!;
  const g = parseTvGrid(readFileSync(ASSET, "utf8"));
  assert.equal(sha(readFileSync(source)), g.source.sha256, "the shipped table was made from another file");
  const again = join(work, "again.json");
  assert.equal(sync(source, "--out", again).status, 0);
  assert.equal(readFileSync(again, "utf8"), readFileSync(ASSET, "utf8"), "re-running the script on that table changes the asset");
});

// ─── the script ───────────────────────────────────────────────────────────

test("sync-tv-grid on a small table: Binance's two venues only, sorted, one symbol per line, source and hash recorded", () => {
  const out = join(work, "mini.json");
  const r = sync(MINI, "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /spot 3, usdt_perp 2 symbols, source 2026-10-03T19:19:21Z sha256 [0-9a-f]{12}/);
  const text = readFileSync(out, "utf8");
  const g = parseTvGrid(text);
  assert.deepEqual(g.spot, { "1000SATSUSDT": 0.001, BTCUSDT: 0.00001, XRPUSDT: 1 });
  assert.deepEqual(g.usdt_perp, { BTCUSDT: 0.000001, ETHUSDT: 0.0001 });
  assert.deepEqual(Object.keys(g.spot), ["1000SATSUSDT", "BTCUSDT", "XRPUSDT"]);
  assert.deepEqual(g.source, {
    schema: "pineforge-tv-syminfo-receipts/v1", generated_utc: "2026-10-03T19:19:21Z",
    sha256: sha(readFileSync(MINI)), venues: { spot: "crypto.binance.com.spot", usdt_perp: "crypto.binance.com.perp-usdt" },
  });
  assert.deepEqual(g.counts, { spot: 3, usdt_perp: 2 });
  assert.equal(g.content_sha256, sha("spot\n1000SATSUSDT=0.001\nBTCUSDT=0.00001\nXRPUSDT=1\nusdt_perp\nBTCUSDT=0.000001\nETHUSDT=0.0001\n"));
  assert.ok(text.includes('    "BTCUSDT": 0.00001,\n    "XRPUSDT": 1\n  },'), "one symbol per line");
  assert.ok(!text.includes("bybit") && !text.includes("AIXBTUSDC"), "other venues and unlisted symbols are not carried");
  assert.ok(text.endsWith("}\n"));
});

test("sync-tv-grid is deterministic: the same table gives the same bytes", () => {
  const a = join(work, "a.json");
  const b = join(work, "b.json");
  assert.equal(sync(MINI, "--out", a).status, 0);
  assert.equal(sync(MINI, "--out", b).status, 0);
  assert.equal(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
});

test("sync-tv-grid refuses what it cannot trust, writes nothing, and says why", () => {
  const mini = JSON.parse(readFileSync(MINI, "utf8"));
  const table = (edit: (t: any) => void) => {
    const t = JSON.parse(JSON.stringify(mini));
    edit(t);
    const path = join(work, `bad-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(t));
    return path;
  };
  const cases: Array<[string, string, RegExp]> = [
    ["incomplete", table((t) => { t.complete = false; }), /is not complete .*still being refreshed/],
    ["no complete flag", table((t) => { delete t.complete; }), /is not complete/],
    ["wrong schema", table((t) => { t.schema = "pineforge-tv-syminfo-receipts/v2"; }), /is not a pineforge-tv-syminfo-receipts\/v1 table/],
    ["no generated_utc", table((t) => { delete t.generated_utc; }), /has no generated_utc/],
    ["a venue missing", table((t) => { delete t.rows["crypto.binance.com.perp-usdt"]; }), /has no rows for crypto\.binance\.com\.perp-usdt/],
    ["an empty venue", table((t) => { t.rows["crypto.binance.com.spot"] = {}; }), /crypto\.binance\.com\.spot has no rows/],
    ["a zero", table((t) => { t.rows["crypto.binance.com.spot"].BTCUSDT.mincontract = 0; }), /1 rows without a usable mincontract \(BTCUSDT=0\)/],
    ["a string", table((t) => { t.rows["crypto.binance.com.spot"].BTCUSDT.mincontract = "0.001"; }), /BTCUSDT="0\.001"/],
    ["null", table((t) => { t.rows["crypto.binance.com.perp-usdt"].ETHUSDT.mincontract = null; }), /ETHUSDT=null/],
    ["out of range", table((t) => { t.rows["crypto.binance.com.spot"].XRPUSDT.mincontract = 1e13; }), /XRPUSDT=10000000000000/],
    ["a bad symbol", table((t) => { t.rows["crypto.binance.com.spot"]["BAD SYMBOL"] = { mincontract: 1 }; }), /BAD SYMBOL=1/],
  ];
  for (const [name, path, why] of cases) {
    const out = join(work, `refused-${name.replace(/\W/g, "")}.json`);
    const r = sync(path, "--out", out);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, why, name);
    assert.match(r.stderr, /^sync-tv-grid: /, name);
    assert.equal(existsSync(out), false, `${name}: wrote a file`);
  }
  assert.equal(sync(join(work, "no-such-table.json")).status !== 0, true);
  const notJson = join(work, "not-json.json");
  writeFileSync(notJson, "{oops");
  assert.match(sync(notJson).stderr, /is not JSON/);
  assert.match(spawnSync("node", [SCRIPT], { encoding: "utf8" }).stderr, /usage: node scripts\/sync-tv-grid\.mjs <path to tv-grid-table\.json>/);
});

// ─── the loader ───────────────────────────────────────────────────────────

test("tvLotStep: by market and exact symbol (any case); a missing symbol, and names of Object.prototype, are none", () => {
  assert.equal(tvLotStep("spot", "BTCUSDT"), 0.00001);
  assert.equal(tvLotStep("spot", "btcusdt"), 0.00001);
  assert.equal(tvLotStep("usdt_perp", "BTCUSDT"), 0.000001);
  assert.notEqual(tvLotStep("spot", "XRPUSDT"), tvLotStep("usdt_perp", "XRPUSDT"));
  for (const name of ["NOPEUSDT", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(tvLotStep("spot", name), undefined, name);
  }
  assert.equal(tvGridPath(), ASSET);
});

test("parseTvGrid refuses anything that is not a generated table", () => {
  const good = JSON.parse(readFileSync(ASSET, "utf8"));
  const bad = (edit: (g: any) => void) => { const g = JSON.parse(JSON.stringify(good)); edit(g); return JSON.stringify(g); };
  assert.throws(() => parseTvGrid("{oops"));
  assert.throws(() => parseTvGrid(bad((g) => { g.schema = "other"; })), /not a pineforge-tv-grid\/v1 file/);
  assert.throws(() => parseTvGrid(bad((g) => { g.spot = {}; })), /missing, empty or holds a bad value/);
  assert.throws(() => parseTvGrid(bad((g) => { g.usdt_perp.BTCUSDT = 0; })), /bad value/);
  assert.throws(() => parseTvGrid(bad((g) => { g.usdt_perp.BTCUSDT = "1"; })), /bad value/);
  assert.throws(() => parseTvGrid(bad((g) => { delete g.source.sha256; })), /source block is incomplete/);
});

// ─── shipping ─────────────────────────────────────────────────────────────

test("the table is in the npm package and the Glama image, where tvGridPath() looks for it", () => {
  const files = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] }).files;
  assert.ok(files.includes("src/tv-grid.generated.json"), `package.json files: ${files.join(", ")}`);
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const listed = (JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
  assert.ok(listed.includes("src/tv-grid.generated.json"), "npm pack does not list the table");
  const dockerfile = readFileSync(join(root, "docker", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY --from=mcp \/app\/src\/tv-grid\.generated\.json \.\/src\/tv-grid\.generated\.json$/m);
  // dist/tv-grid.js (WORKDIR /app/dist next to ../src) is where the Dockerfile copies dist to
  assert.match(dockerfile, /^COPY --from=mcp \/app\/dist \.\/dist$/m);
});
