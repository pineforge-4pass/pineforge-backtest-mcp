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
import { parseTvGrid, resetTvGrid, tvDefaultLot, tvGridPath, tvLotStep, tvNotListed, TV_GRID_SCHEMA } from "../src/tv-grid.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts", "sync-tv-grid.mjs");
const MINI = join(root, "test", "fixtures", "tv-grid", "mini-table.json");
const ASSET = join(root, "src", "tv-grid.generated.json");
const work = mkdtempSync(join(tmpdir(), "pf-tvgrid-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sync = (table: string, ...extra: string[]) =>
  spawnSync("node", [SCRIPT, table, ...extra], { encoding: "utf8" });

type Section = {
  spot: Record<string, number>;
  usdt_perp: Record<string, number>;
  not_on_tv: Record<string, string[]>;
  defaults: Record<string, { mincontract: number; share: number; n: number }>;
};
const MARKETS = ["spot", "usdt_perp"] as const;

/**
 * The text the script hashes: each market's readings (`symbol=value` per line, sorted), then each market's
 * not-on-TradingView symbols, then each market's default (or `none`).
 */
function canonical(g: Section): string {
  const readings = MARKETS.map((m) => `${m}\n${Object.keys(g[m]).sort().map((s) => `${s}=${g[m][s]}\n`).join("")}`).join("");
  const unlisted = MARKETS.map((m) => `not_on_tv ${m}\n${(g.not_on_tv[m] ?? []).map((s) => `${s}\n`).join("")}`).join("");
  const defaults = MARKETS.map((m) => {
    const d = g.defaults[m];
    return `defaults ${m}\n${d ? `mincontract=${d.mincontract} share=${d.share} n=${d.n}\n` : "none\n"}`;
  }).join("");
  return readings + unlisted + defaults;
}

/** A receipts table made from the small fixture: `edit` changes it. Returns the path. */
const SPOT_VENUE = "crypto.binance.com.spot";
const PERP_VENUE = "crypto.binance.com.perp-usdt";
function tableFile(edit: (t: any) => void): string {
  const t = JSON.parse(readFileSync(MINI, "utf8"));
  edit(t);
  const path = join(work, `table-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(t));
  return path;
}
/** `count` symbols on a venue, the first `atDefault` of them read 0.001 and the rest 0.01. */
const readings = (count: number, atDefault: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`S${String(i).padStart(3, "0")}USDT`, { mincontract: i < atDefault ? 0.001 : 0.01 }]));
/** The `defaults` block the script writes for a spot venue of those readings. */
function spotDefaults(count: number, atDefault: number) {
  const out = join(work, `defaults-${count}-${atDefault}.json`);
  const r = sync(tableFile((t) => { t.rows[SPOT_VENUE] = readings(count, atDefault); }), "--out", out);
  assert.equal(r.status, 0, r.stderr);
  return parseTvGrid(readFileSync(out, "utf8")).defaults;
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

test("src/tv-grid.generated.json: the symbols TradingView does not list, and TradingView's usual lot size per market", () => {
  const g = parseTvGrid(readFileSync(ASSET, "utf8"));
  // the usual lot size, with the share of readings it rests on (pinned literals: 1,237 of 1,366 and 510 of 523 read 0.001)
  assert.deepEqual(g.defaults, {
    spot: { mincontract: 0.001, share: 0.9056, n: 1366 },
    usdt_perp: { mincontract: 0.001, share: 0.9751, n: 523 },
  });
  for (const m of MARKETS) {
    const values = Object.values(g[m]);
    assert.equal(g.defaults![m]!.n, values.length, m);
    assert.equal(g.defaults![m]!.share, Math.round((values.filter((v) => v === 0.001).length / values.length) * 1e4) / 1e4, m);
  }
  // the symbols Binance lists that TradingView does not: sorted, and none of them has a reading
  assert.equal(g.not_on_tv!.spot!.length, 18);
  assert.deepEqual(g.not_on_tv!.usdt_perp, ["STGUSDT"]);
  assert.ok(g.not_on_tv!.spot!.includes("AIXBTUSDC") && g.not_on_tv!.spot!.includes("USDTUAH"));
  for (const m of MARKETS) {
    const list = g.not_on_tv![m]!;
    assert.deepEqual(list, [...list].sort(), `${m} not_on_tv is not sorted`);
    assert.deepEqual(list.filter((s) => Object.prototype.hasOwnProperty.call(g[m], s)), [], `${m}: listed and read`);
  }
});

test("the generated file's content hash matches what it holds, readings, unlisted symbols and defaults (a hand edit is noticed), and its symbols are sorted", () => {
  const g = parseTvGrid(readFileSync(ASSET, "utf8")) as unknown as Section;
  assert.equal(g.content_sha256 as unknown, sha(canonical(g)));
  for (const m of MARKETS) {
    const keys = Object.keys(g[m]);
    assert.deepEqual(keys, [...keys].sort(), `${m} is not sorted`);
  }
  // each part is under the hash: changing one of them (and nothing else) is a different hash
  const spotList = g.not_on_tv.spot!;
  assert.notEqual(sha(canonical({ ...g, not_on_tv: { ...g.not_on_tv, spot: spotList.slice(1) } })), g.content_sha256 as unknown);
  assert.notEqual(sha(canonical({ ...g, defaults: { ...g.defaults, usdt_perp: { ...g.defaults.usdt_perp!, share: 0.9 } } })), g.content_sha256 as unknown);
  assert.notEqual(sha(canonical({ ...g, defaults: { spot: g.defaults.spot! } })), g.content_sha256 as unknown);
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
  // the unlisted symbols of Binance's two venues (the fixture lists one, on spot), and no default: 1 of 3 and 0 of 2 read 0.001
  assert.deepEqual(g.not_on_tv, { spot: ["AIXBTUSDC"], usdt_perp: [] });
  assert.deepEqual(g.defaults, {});
  assert.equal(g.content_sha256, sha(
    "spot\n1000SATSUSDT=0.001\nBTCUSDT=0.00001\nXRPUSDT=1\nusdt_perp\nBTCUSDT=0.000001\nETHUSDT=0.0001\n" +
    "not_on_tv spot\nAIXBTUSDC\nnot_on_tv usdt_perp\n" +
    "defaults spot\nnone\ndefaults usdt_perp\nnone\n"));
  assert.ok(text.includes('    "BTCUSDT": 0.00001,\n    "XRPUSDT": 1\n  },'), "one symbol per line");
  assert.ok(!text.includes("bybit"), "other venues are not carried");
  assert.ok(text.includes('    "spot": [\n      "AIXBTUSDC"\n    ],\n    "usdt_perp": []\n  },'), "one unlisted symbol per line");
  assert.ok(text.endsWith("}\n"));
});

test("sync-tv-grid is deterministic: the same table gives the same bytes", () => {
  const a = join(work, "a.json");
  const b = join(work, "b.json");
  assert.equal(sync(MINI, "--out", a).status, 0);
  assert.equal(sync(MINI, "--out", b).status, 0);
  assert.equal(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
});

test("sync-tv-grid on the real-size shares: the default is rounded to 4 decimals", () => {
  // 1,237 of 1,366 spot readings are 0.001 (0.90556...), 510 of 523 USD-M ones (0.97514...)
  assert.deepEqual(spotDefaults(1366, 1237), { spot: { mincontract: 0.001, share: 0.9056, n: 1366 } });
  const out = join(work, "perp-defaults.json");
  assert.equal(sync(tableFile((t) => { t.rows[PERP_VENUE] = readings(523, 510); }), "--out", out).status, 0);
  assert.deepEqual(parseTvGrid(readFileSync(out, "utf8")).defaults, { usdt_perp: { mincontract: 0.001, share: 0.9751, n: 523 } });
});

test("sync-tv-grid carries a default only when at least 80% of a market's readings are 0.001 (both sides of the line)", () => {
  assert.deepEqual(spotDefaults(5, 4), { spot: { mincontract: 0.001, share: 0.8, n: 5 } }, "4 of 5 is exactly 0.8: carried");
  assert.deepEqual(spotDefaults(100, 80), { spot: { mincontract: 0.001, share: 0.8, n: 100 } }, "80 of 100: carried");
  assert.deepEqual(spotDefaults(100, 79), {}, "79 of 100: not carried");
  assert.deepEqual(spotDefaults(4, 3), {}, "3 of 4 is 0.75: not carried");
  assert.deepEqual(spotDefaults(1, 1), { spot: { mincontract: 0.001, share: 1, n: 1 } }, "every reading: carried, share 1");
  assert.deepEqual(spotDefaults(1, 0), {}, "no reading at 0.001: not carried");
  // a market is judged on its own readings: spot qualifies, USD-M (2 of 5) does not, and the reverse
  const out = join(work, "two-markets.json");
  const both = tableFile((t) => { t.rows[SPOT_VENUE] = readings(10, 9); t.rows[PERP_VENUE] = readings(5, 2); });
  assert.equal(sync(both, "--out", out).status, 0);
  assert.deepEqual(parseTvGrid(readFileSync(out, "utf8")).defaults, { spot: { mincontract: 0.001, share: 0.9, n: 10 } });
  // only a reading of exactly 0.001 counts: a neighbouring value does not
  const near = tableFile((t) => { t.rows[SPOT_VENUE] = { A: { mincontract: 0.001 }, B: { mincontract: 0.0010000001 }, C: { mincontract: 0.0009999999 } }; });
  assert.equal(sync(near, "--out", out).status, 0);
  assert.deepEqual(parseTvGrid(readFileSync(out, "utf8")).defaults, {});
});

test("sync-tv-grid: the content hash covers the unlisted symbols and the defaults, and the output stays deterministic", () => {
  const a = join(work, "hash-a.json");
  const b = join(work, "hash-b.json");
  const c = join(work, "hash-c.json");
  assert.equal(sync(tableFile((t) => { t.not_on_tv[SPOT_VENUE] = ["AIXBTUSDC"]; }), "--out", a).status, 0);
  assert.equal(sync(tableFile((t) => { t.not_on_tv[SPOT_VENUE] = ["AIXBTUSDC", "OTHERUSDC"]; }), "--out", b).status, 0);
  assert.equal(sync(tableFile((t) => { t.not_on_tv[SPOT_VENUE] = ["AIXBTUSDC"]; t.not_on_tv[PERP_VENUE] = ["STGUSDT"]; }), "--out", c).status, 0);
  const [ga, gb, gc] = [a, b, c].map((p) => parseTvGrid(readFileSync(p, "utf8")));
  assert.deepEqual([ga.spot, ga.usdt_perp], [gb.spot, gb.usdt_perp], "the readings did not change");
  assert.notEqual(ga.content_sha256, gb.content_sha256, "a symbol more in not_on_tv: another hash");
  assert.notEqual(ga.content_sha256, gc.content_sha256, "a symbol more in not_on_tv of the other market: another hash");
  // the readings that make a default are in the maps, so a default changes the hash too
  const d1 = join(work, "hash-d1.json");
  const d2 = join(work, "hash-d2.json");
  assert.equal(sync(tableFile((t) => { t.rows[SPOT_VENUE] = readings(5, 4); }), "--out", d1).status, 0);
  assert.equal(sync(tableFile((t) => { t.rows[SPOT_VENUE] = readings(5, 3); }), "--out", d2).status, 0);
  assert.notEqual(parseTvGrid(readFileSync(d1, "utf8")).content_sha256, parseTvGrid(readFileSync(d2, "utf8")).content_sha256);
  // same table, same bytes; a list in another order or with a repeat is the same sorted, distinct list
  const shuffled = join(work, "hash-shuffled.json");
  const sorted = join(work, "hash-sorted.json");
  assert.equal(sync(tableFile((t) => { t.not_on_tv[SPOT_VENUE] = ["ZZZUSDC", "AAAUSDC", "ZZZUSDC", "MMMUSDC"]; }), "--out", shuffled).status, 0);
  assert.equal(sync(tableFile((t) => { t.not_on_tv[SPOT_VENUE] = ["AAAUSDC", "MMMUSDC", "ZZZUSDC"]; }), "--out", sorted).status, 0);
  // (the two source tables are different bytes, so only their recorded hash, the `source` line, differs)
  const withoutSource = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => !l.startsWith('  "source"')).join("\n");
  assert.equal(withoutSource(shuffled), withoutSource(sorted));
  assert.deepEqual(parseTvGrid(readFileSync(sorted, "utf8")).not_on_tv!.spot, ["AAAUSDC", "MMMUSDC", "ZZZUSDC"]);
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
    ["no not_on_tv", table((t) => { delete t.not_on_tv; }), /has no not_on_tv/],
    ["not_on_tv a list", table((t) => { t.not_on_tv = ["AIXBTUSDC"]; }), /has no not_on_tv/],
    ["a venue's not_on_tv not a list", table((t) => { t.not_on_tv["crypto.binance.com.spot"] = "AIXBTUSDC"; }), /not_on_tv of crypto\.binance\.com\.spot is not a list of symbols/],
    ["a bad unlisted symbol", table((t) => { t.not_on_tv["crypto.binance.com.spot"] = ["AIXBTUSDC", "BAD SYMBOL"]; }), /not_on_tv of crypto\.binance\.com\.spot is not a list of symbols/],
    ["an unlisted number", table((t) => { t.not_on_tv["crypto.binance.com.perp-usdt"] = [5]; }), /not_on_tv of crypto\.binance\.com\.perp-usdt is not a list of symbols/],
    ["measured and unlisted", table((t) => { t.not_on_tv["crypto.binance.com.spot"] = ["BTCUSDT"]; }), /crypto\.binance\.com\.spot: BTCUSDT is both read and not on TradingView/],
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

test("tvNotListed and tvDefaultLot: by market (and exact symbol, any case); the real table lists 18 unlisted spot symbols and one USD-M", () => {
  assert.equal(tvNotListed("spot", "AIXBTUSDC"), true);
  assert.equal(tvNotListed("spot", "aixbtusdc"), true);
  assert.equal(tvNotListed("usdt_perp", "AIXBTUSDC"), false, "the spot list is not the USD-M list");
  assert.equal(tvNotListed("usdt_perp", "STGUSDT"), true);
  assert.equal(tvNotListed("spot", "STGUSDT"), false);
  assert.equal(tvNotListed("spot", "BTCUSDT"), false, "a symbol with a reading is listed");
  for (const name of ["NEWCOINUSDT", "", "constructor", "__proto__", "toString"]) assert.equal(tvNotListed("spot", name), false, name);
  assert.deepEqual(tvDefaultLot("spot"), { mincontract: 0.001, share: 0.9056, n: 1366 });
  assert.deepEqual(tvDefaultLot("usdt_perp"), { mincontract: 0.001, share: 0.9751, n: 523 });
});

test("an older-shaped table (no not_on_tv, no defaults) still loads: nothing is unlisted and there is no default", () => {
  const old = JSON.parse(readFileSync(ASSET, "utf8"));
  delete old.not_on_tv;
  delete old.defaults;
  const path = join(work, "older-shape.json");
  writeFileSync(path, JSON.stringify(old));
  const saved = process.env.PINEFORGE_TV_GRID;
  process.env.PINEFORGE_TV_GRID = path;
  resetTvGrid();
  try {
    assert.equal(tvLotStep("spot", "BTCUSDT"), 0.00001, "the readings are there");
    assert.equal(tvNotListed("spot", "AIXBTUSDC"), false);
    assert.equal(tvDefaultLot("spot"), undefined);
    assert.equal(tvDefaultLot("usdt_perp"), undefined);
    assert.equal(parseTvGrid(JSON.stringify(old)).defaults, undefined);
  } finally {
    if (saved === undefined) delete process.env.PINEFORGE_TV_GRID; else process.env.PINEFORGE_TV_GRID = saved;
    resetTvGrid();
  }
  assert.equal(tvNotListed("spot", "AIXBTUSDC"), true, "the real table is back");
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
  // a new section that is there must be sound
  assert.throws(() => parseTvGrid(bad((g) => { g.not_on_tv = []; })), /not_on_tv is not an object of symbol lists/);
  assert.throws(() => parseTvGrid(bad((g) => { g.not_on_tv.spot = "AIXBTUSDC"; })), /not_on_tv\.spot is not a list of symbols/);
  assert.throws(() => parseTvGrid(bad((g) => { g.not_on_tv.usdt_perp = [1]; })), /not_on_tv\.usdt_perp is not a list of symbols/);
  assert.throws(() => parseTvGrid(bad((g) => { g.defaults = 0.001; })), /defaults is not an object/);
  assert.throws(() => parseTvGrid(bad((g) => { g.defaults.spot.mincontract = 0; })), /defaults\.spot has a bad mincontract/);
  assert.throws(() => parseTvGrid(bad((g) => { g.defaults.spot.share = 0.79; })), /defaults\.spot has a bad share/);
  assert.throws(() => parseTvGrid(bad((g) => { g.defaults.spot.share = 1.01; })), /defaults\.spot has a bad share/);
  assert.throws(() => parseTvGrid(bad((g) => { g.defaults.usdt_perp.n = 0; })), /defaults\.usdt_perp has a bad n/);
  assert.throws(() => parseTvGrid(bad((g) => { g.defaults.usdt_perp.n = 1.5; })), /defaults\.usdt_perp has a bad n/);
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
