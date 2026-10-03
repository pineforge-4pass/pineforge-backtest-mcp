// The instrument of a backtest: spec building from recorded Binance exchangeInfo
// (spot and USD-M), validation, the user's values over it, the sidecar next to a
// CSV, resolution and its warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INSTRUMENT_SCHEMA,
  SyminfoArgSchema,
  appliedWarnings,
  cleanNumber,
  cleanString,
  csvBarRange,
  instrumentFromBinance,
  layerUserSyminfo,
  readSidecar,
  redactCredentials,
  removeSidecar,
  resolveInstrument,
  sidecarPath,
  unresolvedInstrument,
  unresolvedWarning,
  writeSidecar,
  type BinanceSymbolInfo,
  type Instrument,
} from "../src/instrument.js";

const fixture = (name: string): BinanceSymbolInfo[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/binance/${name}`, import.meta.url), "utf8")).symbols;
const SPOT = fixture("spot-exchangeinfo.json");
const FAPI = fixture("fapi-exchangeinfo.json");
const spot = (symbol: string) => SPOT.find((s) => s.symbol === symbol)!;
const fapi = (symbol: string) => FAPI.find((s) => s.symbol === symbol)!;

const tmp = mkdtempSync(join(process.cwd(), "test", ".tmp-pf-instrument-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const csv = (rows: string[] = ["1000,1,1,1,1,1", "2000,1,1,1,1,1", "3000,1,1,1,1,1"]) => {
  const path = join(tmp, `bars-${++n}.csv`);
  writeFileSync(path, ["timestamp,open,high,low,close,volume", ...rows].join("\n") + "\n");
  return path;
};

// ─── validation ───────────────────────────────────────────────────────────

test("numbers must be finite and within 1e-12..1e12", () => {
  assert.equal(cleanNumber(0.00001), 0.00001);
  assert.equal(cleanNumber(1e-12), 1e-12);
  assert.equal(cleanNumber(1e12), 1e12);
  for (const bad of [0, -1, 1e-13, 1.0000001e12, NaN, Infinity, -Infinity, "0.01", null, undefined, true, {}]) {
    assert.equal(cleanNumber(bad), undefined, String(bad));
  }
});

test("strings are 1..64 printable ASCII characters", () => {
  assert.equal(cleanString("BINANCE:BTCUSDT.P"), "BINANCE:BTCUSDT.P");
  assert.equal(cleanString("a".repeat(64)), "a".repeat(64));
  for (const bad of ["", "a".repeat(65), "café", "tab\t", "line\nbreak", 5, null, undefined]) {
    assert.equal(cleanString(bad), undefined, String(bad));
  }
  assert.equal(cleanString("a".repeat(200), 200), "a".repeat(200));
});

// ─── Binance exchangeInfo → instrument ────────────────────────────────────

test("spot BTCUSDT: lot size, tick size and names from the recorded exchangeInfo", () => {
  assert.deepEqual(instrumentFromBinance(spot("BTCUSDT"), "spot"), {
    schema: INSTRUMENT_SCHEMA, resolved: true,
    qty_step: 0.00001, mincontract: 0.00001, mintick: 0.01, pointvalue: 1,
    type: "crypto", ticker: "BTCUSDT", tickerid: "BINANCE:BTCUSDT", currency: "USDT", basecurrency: "BTC",
    source: { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT" },
  });
});

test("spot lot and tick sizes of five recorded symbols", () => {
  const got = Object.fromEntries(
    ["BTCUSDT", "ETHUSDT", "XRPUSDT", "DOGEUSDT", "SHIBUSDT"].map((s) => {
      const i = instrumentFromBinance(spot(s), "spot");
      return [s, [i.qty_step, i.mintick]];
    }),
  );
  assert.deepEqual(got, {
    BTCUSDT: [0.00001, 0.01], ETHUSDT: [0.0001, 0.01], XRPUSDT: [0.1, 0.0001],
    DOGEUSDT: [1, 0.00001], SHIBUSDT: [1, 0.00000001],
  });
});

test("the lot grid is LOT_SIZE.stepSize, not MARKET_LOT_SIZE.stepSize (0 on spot BTCUSDT) nor minQty", () => {
  const btc = spot("BTCUSDT");
  const market = (btc.filters as Array<Record<string, unknown>>).find((f) => f.filterType === "MARKET_LOT_SIZE")!;
  assert.equal(market.stepSize, "0.00000000");
  assert.equal(instrumentFromBinance(btc, "spot").qty_step, 0.00001);
  // USD-M ALLUSDT: minQty 10, stepSize 1
  assert.equal(instrumentFromBinance(fapi("ALLUSDT"), "usdt_perp").qty_step, 1);
});

test("USD-M perpetuals: .P tickerid, coarser tick and lot sizes", () => {
  const btc = instrumentFromBinance(fapi("BTCUSDT"), "usdt_perp");
  assert.deepEqual([btc.qty_step, btc.mincontract, btc.mintick, btc.tickerid, btc.ticker], [0.001, 0.001, 0.1, "BINANCE:BTCUSDT.P", "BTCUSDT.P"]);
  assert.deepEqual(btc.source, { kind: "binance_exchange_info", market: "usdt_perp", symbol: "BTCUSDT" });
  const pepe = instrumentFromBinance(fapi("1000PEPEUSDT"), "usdt_perp");
  assert.deepEqual([pepe.qty_step, pepe.mintick, pepe.basecurrency], [1, 0.0000001, "1000PEPEUSDT".slice(0, 8)]);
  assert.equal(instrumentFromBinance(fapi("TSLAUSDT"), "usdt_perp").tickerid, "BINANCE:TSLAUSDT.P");
});

test("a delivery contract is not a .P perpetual; a perpetual that is being delisted still is", () => {
  const delivery = instrumentFromBinance(fapi("BTCUSDT_261225"), "usdt_perp");
  assert.deepEqual([delivery.tickerid, delivery.ticker], ["BINANCE:BTCUSDT_261225", "BTCUSDT_261225"]);
  const delisting = instrumentFromBinance({ ...fapi("BTCUSDT"), contractType: "PERPETUAL_DELIVERING" }, "usdt_perp");
  assert.deepEqual([delisting.tickerid, delisting.ticker], ["BINANCE:BTCUSDT.P", "BTCUSDT.P"]);
  // a spot symbol is never a perpetual
  assert.equal(instrumentFromBinance(spot("BTCUSDT"), "spot").ticker, "BTCUSDT");
});

test("a missing LOT_SIZE filter leaves the instrument unresolved, with the other values", () => {
  const info: BinanceSymbolInfo = { ...spot("BTCUSDT"), filters: (spot("BTCUSDT").filters as unknown[]).filter((f) => (f as { filterType: string }).filterType !== "LOT_SIZE") };
  const got = instrumentFromBinance(info, "spot");
  assert.equal(got.resolved, false);
  assert.match(got.reason!, /no usable LOT_SIZE\.stepSize for BTCUSDT/);
  assert.equal(got.qty_step, undefined);
  assert.equal(got.mincontract, undefined);
  assert.equal(got.mintick, 0.01);
  assert.deepEqual(got.source!.dropped, ["qty_step", "mincontract"]);
});

test("zero, malformed and absent filter values are dropped", () => {
  const withLot = (stepSize: unknown, tickSize: unknown): BinanceSymbolInfo => ({
    symbol: "XUSDT", baseAsset: "X", quoteAsset: "USDT",
    filters: [{ filterType: "LOT_SIZE", stepSize }, { filterType: "PRICE_FILTER", tickSize }],
  });
  const zero = instrumentFromBinance(withLot("0.00000000", "0.01"), "spot");
  assert.equal(zero.resolved, false);
  assert.deepEqual(zero.source!.dropped, ["qty_step", "mincontract"]);
  const junk = instrumentFromBinance(withLot("abc", "-1"), "spot");
  assert.deepEqual([junk.resolved, junk.mintick, junk.source!.dropped], [false, undefined, ["qty_step", "mincontract", "mintick"]]);
  const tiny = instrumentFromBinance(withLot("1e-13", "0.01"), "spot");
  assert.equal(tiny.resolved, false);
  const noFilters = instrumentFromBinance({ symbol: "XUSDT" }, "spot");
  assert.equal(noFilters.resolved, false);
  assert.equal(noFilters.currency, undefined);
  assert.equal(noFilters.ticker, "XUSDT");
});

test("a name that is not printable ASCII or too long is dropped, not applied", () => {
  const i = instrumentFromBinance({ ...spot("BTCUSDT"), baseAsset: "BÜTC", quoteAsset: "U".repeat(65) }, "spot");
  assert.equal(i.basecurrency, undefined);
  assert.equal(i.currency, undefined);
  assert.equal(i.resolved, true);
});

// ─── the user's values ────────────────────────────────────────────────────

test("syminfo argument: strict, positive, in range", () => {
  const ok = SyminfoArgSchema.safeParse({ qty_step: 0.001, mintick: 0.5, type: "crypto", tickerid: "X:Y" });
  assert.equal(ok.success, true);
  for (const bad of [{ qty_step: 0 }, { qty_step: -1 }, { mintick: 1e13 }, { pointvalue: 1e-13 }, { type: "cré" },
    { ticker: "a".repeat(65) }, { timezone: "UTC" }, { qty_step: "0.01" }]) {
    assert.equal(SyminfoArgSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("user values alone: resolved when they hold a lot size, source user", () => {
  const got = layerUserSyminfo(undefined, { qty_step: 0.01, mintick: 0.5, pointvalue: 50 });
  assert.deepEqual(got, {
    schema: INSTRUMENT_SCHEMA, resolved: true,
    qty_step: 0.01, mincontract: 0.01, mintick: 0.5, pointvalue: 50, source: { kind: "user" },
  });
});

test("mincontract alone gives the lot size, and the reverse", () => {
  const a = layerUserSyminfo(undefined, { mincontract: 0.1 });
  assert.deepEqual([a.resolved, a.qty_step, a.mincontract], [true, 0.1, 0.1]);
  const b = layerUserSyminfo(undefined, { qty_step: 5 });
  assert.deepEqual([b.qty_step, b.mincontract], [5, 5]);
  const both = layerUserSyminfo(undefined, { qty_step: 5, mincontract: 1 });
  assert.deepEqual([both.qty_step, both.mincontract], [5, 1]);
});

test("user values without a lot size are unresolved but still carried", () => {
  const got = layerUserSyminfo(undefined, { mintick: 0.5, type: "forex" });
  assert.equal(got.resolved, false);
  assert.match(got.reason!, /no qty_step or mincontract/);
  assert.deepEqual([got.mintick, got.type], [0.5, "forex"]);
});

test("explicit values win over a resolved instrument and are named; the lot size moves together", () => {
  const base = instrumentFromBinance(spot("BTCUSDT"), "spot");
  const got = layerUserSyminfo({ ...base, source: { ...base.source!, via: "symbol" } }, { qty_step: 0.001, mintick: 0.5 });
  assert.deepEqual([got.qty_step, got.mincontract, got.mintick, got.pointvalue, got.ticker], [0.001, 0.001, 0.5, 1, "BTCUSDT"]);
  assert.deepEqual(got.source, {
    kind: "user",
    base: { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT", via: "symbol" },
    overridden: ["qty_step", "mincontract", "mintick"],
  });
});

test("values the base could not give and the user did not stay named as dropped", () => {
  const base = unresolvedInstrument("x");
  const dropped: Instrument = { ...instrumentFromBinance({ symbol: "XUSDT" }, "spot"), qty_step: undefined };
  const got = layerUserSyminfo(dropped, { mintick: 0.5 });
  assert.equal(got.resolved, false);
  assert.deepEqual(got.source!.dropped, ["qty_step", "mincontract"]);
  assert.equal(base.resolved, false);
});

// ─── sidecar ──────────────────────────────────────────────────────────────

const FEED = { interval: "4h", first_open_time: 1000, last_open_time: 3000, bars: 3 };

test("csvBarRange reads the first and last bar from the two ends", async () => {
  assert.deepEqual(await csvBarRange(csv()), { first: 1000, last: 3000 });
  const rows = Array.from({ length: 5000 }, (_, i) => `${1_700_000_000_000 + i * 60_000},1,1,1,1,1`);
  assert.deepEqual(await csvBarRange(csv(rows)), { first: 1_700_000_000_000, last: 1_700_000_000_000 + 4999 * 60_000 });
  const noTrailingNewline = join(tmp, "nonl.csv");
  writeFileSync(noTrailingNewline, "timestamp,open,high,low,close,volume\n5,1,1,1,1,1\n9,1,1,1,1,1");
  assert.deepEqual(await csvBarRange(noTrailingNewline), { first: 5, last: 9 });
  const headerOnly = join(tmp, "empty.csv");
  writeFileSync(headerOnly, "timestamp,open,high,low,close,volume\n");
  assert.equal(await csvBarRange(headerOnly), undefined);
});

test("sidecar: written next to the CSV, read back as a sidecar instrument", async () => {
  const path = csv();
  const inst = instrumentFromBinance(spot("BTCUSDT"), "spot");
  inst.source = { ...inst.source!, fetched_at: "2026-10-04T00:00:00.000Z" };
  assert.equal(await writeSidecar(path, inst, FEED), `${path}.instrument.json`);
  assert.equal(sidecarPath(path), `${path}.instrument.json`);
  const onDisk = JSON.parse(readFileSync(sidecarPath(path), "utf8"));
  assert.equal(onDisk.schema, INSTRUMENT_SCHEMA);
  assert.equal(onDisk.source.fetched_at, "2026-10-04T00:00:00.000Z");
  assert.deepEqual(onDisk.csv, { ...FEED, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  const read = await readSidecar(path);
  assert.equal(read.ignored, undefined);
  // what a run applies carries no fetch time and says where it came from
  assert.deepEqual(read.instrument, {
    ...instrumentFromBinance(spot("BTCUSDT"), "spot"),
    source: { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT", via: "sidecar" },
  });
});

test("no sidecar: nothing, and nothing ignored", async () => {
  assert.deepEqual(await readSidecar(csv()), {});
});

test("a sidecar the CSV contradicts is ignored, naming both ranges", async () => {
  const path = csv(["1000,1,1,1,1,1", "9000,1,1,1,1,1"]);
  await writeSidecar(path, instrumentFromBinance(spot("BTCUSDT"), "spot"), FEED);
  const read = await readSidecar(path);
  assert.equal(read.instrument, undefined);
  assert.match(read.ignored!, /written for bars 1000\.\.3000 and the CSV now holds 1000\.\.9000/);
});

test("a sidecar is ignored when the CSV changed though its first and last bar did not (same range, other instrument)", async () => {
  const path = csv(["1000,1,1,1,1,1", "2000,1,1,1,1,1", "3000,1,1,1,1,1"]);
  await writeSidecar(path, instrumentFromBinance(spot("BTCUSDT"), "spot"), FEED);
  assert.ok((await readSidecar(path)).instrument, "unchanged CSV: used");
  writeFileSync(path, `timestamp,open,high,low,close,volume\n1000,9,9,9,9,9\n2000,9,9,9,9,9\n3000,9,9,9,9,9\n`);
  const read = await readSidecar(path);
  assert.equal(read.instrument, undefined);
  assert.match(read.ignored!, /written for a different CSV \(the bars' range is the same, the content differs\)/);
});

test("a sidecar with only a mincontract has that lot size, and the reverse", async () => {
  const path = csv();
  writeFileSync(sidecarPath(path), JSON.stringify({ schema: INSTRUMENT_SCHEMA, mincontract: 0.25 }));
  const read = await readSidecar(path);
  assert.deepEqual([read.instrument!.resolved, read.instrument!.qty_step, read.instrument!.mincontract], [true, 0.25, 0.25]);
});

test("a hand-written sidecar without a bar range is used; its values are validated", async () => {
  const path = csv();
  writeFileSync(sidecarPath(path), JSON.stringify({
    schema: INSTRUMENT_SCHEMA, resolved: true, qty_step: 0.5, mintick: -1, ticker: "café", currency: "EUR",
    source: { kind: "user", symbol: "ABC", evil: "x" }, __proto__x: 1,
  }));
  const read = await readSidecar(path);
  assert.deepEqual(read.instrument, {
    schema: INSTRUMENT_SCHEMA, resolved: true, qty_step: 0.5, mincontract: 0.5, currency: "EUR",
    source: { kind: "user", symbol: "ABC", via: "sidecar" },
  });
});

test("a sidecar that is not ours is ignored with a reason", async () => {
  const cases: Array<[string, RegExp]> = [
    ["{oops", /not valid JSON/],
    [JSON.stringify({ schema: "other/v9" }), /not a pineforge-instrument\/v1 file/],
    [JSON.stringify([1, 2]), /not a pineforge-instrument\/v1 file/],
    ["x".repeat(70_000), /not a small regular file/],
  ];
  for (const [content, why] of cases) {
    const path = csv();
    writeFileSync(sidecarPath(path), content);
    const read = await readSidecar(path);
    assert.equal(read.instrument, undefined);
    assert.match(read.ignored!, why);
  }
});

test("writeSidecar never writes through a symbolic link already at its name", async () => {
  const path = csv();
  const target = join(tmp, `precious-${n}.txt`);
  writeFileSync(target, "keep me");
  symlinkSync(target, sidecarPath(path));
  await writeSidecar(path, instrumentFromBinance(spot("BTCUSDT"), "spot"), FEED);
  assert.equal(readFileSync(target, "utf8"), "keep me");
  assert.equal(lstatSync(sidecarPath(path)).isSymbolicLink(), false);
  assert.equal(JSON.parse(readFileSync(sidecarPath(path), "utf8")).schema, INSTRUMENT_SCHEMA);
  // a dangling link, too
  const other = csv();
  const nowhere = join(tmp, `nowhere-${n}.json`);
  symlinkSync(nowhere, sidecarPath(other));
  await writeSidecar(other, instrumentFromBinance(spot("BTCUSDT"), "spot"), FEED);
  assert.equal(existsSync(nowhere), false);
});

test("a symbolic-link sidecar is ignored, not read", async () => {
  const path = csv();
  const real = join(tmp, `real-sidecar-${n}.json`);
  writeFileSync(real, JSON.stringify({ schema: INSTRUMENT_SCHEMA, qty_step: 1 }));
  symlinkSync(real, sidecarPath(path));
  const read = await readSidecar(path);
  assert.equal(read.instrument, undefined);
  assert.match(read.ignored!, /not a small regular file/);
});

test("removeSidecar deletes it and tolerates its absence", async () => {
  const path = csv();
  await writeSidecar(path, instrumentFromBinance(spot("BTCUSDT"), "spot"), FEED);
  await removeSidecar(path);
  assert.equal(existsSync(sidecarPath(path)), false);
  await removeSidecar(path);
});

// ─── resolution ───────────────────────────────────────────────────────────

const lookupIn = (symbols: BinanceSymbolInfo[], seen: string[] = []) =>
  async (market: string, symbol: string) => {
    seen.push(`${market}:${symbol}`);
    return symbols.find((s) => s.symbol === symbol);
  };
const neverLookup = async () => { throw new Error("must not look up"); };

test("symbol: resolved from exchangeInfo (upper-cased), nothing to warn about", async () => {
  const seen: string[] = [];
  const got = await resolveInstrument({ symbol: " btcusdt " }, csv(), lookupIn(SPOT, seen));
  assert.deepEqual(seen, ["spot:BTCUSDT"]);
  assert.deepEqual(got.warnings, []);
  assert.equal(got.instrument.resolved, true);
  assert.equal(got.instrument.qty_step, 0.00001);
  assert.deepEqual(got.instrument.source, { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT", via: "symbol" });
});

test("symbol on usdt_perp reads the USD-M exchangeInfo", async () => {
  const seen: string[] = [];
  const got = await resolveInstrument({ symbol: "BTCUSDT", market: "usdt_perp" }, csv(), lookupIn(FAPI, seen));
  assert.deepEqual(seen, ["usdt_perp:BTCUSDT"]);
  assert.deepEqual([got.instrument.qty_step, got.instrument.mintick, got.instrument.tickerid], [0.001, 0.1, "BINANCE:BTCUSDT.P"]);
});

test("symbol Binance does not list: unresolved, warned, never refused", async () => {
  const got = await resolveInstrument({ symbol: "NOPEUSDT" }, csv(), lookupIn(SPOT));
  assert.equal(got.instrument.resolved, false);
  assert.equal(got.instrument.reason, "NOPEUSDT is not in Binance spot exchangeInfo");
  assert.equal(got.warnings.length, 1);
  assert.ok(got.warnings[0]!.startsWith(
    "instrument grid unavailable for Binance spot NOPEUSDT (NOPEUSDT is not in Binance spot exchangeInfo): " +
    "order quantity is not floored to a lot size, so the run can contain sub-lot margin-call rows that TradingView does not book"));
});

test("Binance unreachable: unresolved with the reason, warned, never refused", async () => {
  const got = await resolveInstrument({ symbol: "BTCUSDT" }, csv(), async () => { throw new Error("Binance 451 for https://api.binance.com/x: blocked"); });
  assert.equal(got.instrument.resolved, false);
  // fixed text in the instrument (it is part of the fingerprint); the error text is in the warning only
  assert.equal(got.instrument.reason, "Binance spot exchangeInfo unavailable");
  assert.equal(got.instrument.source!.symbol, "BTCUSDT");
  assert.equal(got.warnings.length, 1);
  assert.match(got.warnings[0]!, /\(Binance spot exchangeInfo unavailable: Binance 451 for https:\/\/api\.binance\.com\/x: blocked\): order quantity/);
});

test("the error text of an unreachable Binance never reaches the instrument, and credentials never reach the warning", async () => {
  const a = await resolveInstrument({ symbol: "BTCUSDT" }, csv(), async () => { throw new Error("fetch failed"); });
  const b = await resolveInstrument({ symbol: "BTCUSDT" }, csv(), async () => {
    throw new Error("Binance request to https://user:secret@mirror.example/api failed: Binance 503");
  });
  assert.deepEqual(a.instrument, b.instrument, "two different failures, one instrument (one fingerprint)");
  assert.ok(!JSON.stringify(b).includes("secret"), JSON.stringify(b));
  assert.match(b.warnings[0]!, /https:\/\/mirror\.example\/api/);
  assert.equal(redactCredentials("GET http://u:p@h/x and https://a@b/y"), "GET http://h/x and https://b/y");
  assert.equal(redactCredentials("no urls here"), "no urls here");
});

test("syminfo wins over symbol; both are named; the lookup still supplies the rest", async () => {
  const got = await resolveInstrument({ symbol: "BTCUSDT", syminfo: { qty_step: 0.001 } }, csv(), lookupIn(SPOT));
  assert.deepEqual([got.instrument.qty_step, got.instrument.mincontract, got.instrument.mintick, got.instrument.ticker], [0.001, 0.001, 0.01, "BTCUSDT"]);
  assert.equal(got.instrument.source!.kind, "user");
  assert.deepEqual(got.instrument.source!.overridden, ["qty_step", "mincontract"]);
  assert.deepEqual(got.warnings, []);
});

test("syminfo alone never looks anything up", async () => {
  const got = await resolveInstrument({ syminfo: { qty_step: 0.5, mintick: 0.5 } }, csv(), neverLookup);
  assert.deepEqual([got.instrument.resolved, got.instrument.qty_step, got.instrument.ticker], [true, 0.5, undefined]);
  assert.deepEqual(got.instrument.source, { kind: "user" });
  assert.deepEqual(got.warnings, []);
});

test("syminfo goes over the CSV's sidecar: a partial one keeps the sidecar's tick (no lookup)", async () => {
  const path = csv();
  await writeSidecar(path, instrumentFromBinance(spot("DOGEUSDT"), "spot"), FEED);
  const got = await resolveInstrument({ syminfo: { qty_step: 0.001 } }, path, neverLookup);
  assert.deepEqual([got.instrument.qty_step, got.instrument.mincontract, got.instrument.mintick, got.instrument.ticker], [0.001, 0.001, 0.00001, "DOGEUSDT"]);
  assert.deepEqual(got.instrument.source, {
    kind: "user",
    base: { kind: "binance_exchange_info", market: "spot", symbol: "DOGEUSDT", via: "sidecar" },
    overridden: ["qty_step", "mincontract"],
  });
  assert.deepEqual(got.warnings, []);
});

test("a resolved instrument without a mintick warns that the engine's 0.01 tick applies", async () => {
  const got = await resolveInstrument({ syminfo: { qty_step: 0.001 } }, csv(), neverLookup);
  assert.equal(got.instrument.resolved, true);
  assert.equal(got.warnings.length, 1);
  assert.match(got.warnings[0]!, /no mintick.*default tick of 0\.01.*pass `syminfo\.mintick`/);
});

test("an empty syminfo says nothing: the sidecar is still read", async () => {
  const path = csv();
  await writeSidecar(path, instrumentFromBinance(spot("ETHUSDT"), "spot"), FEED);
  const got = await resolveInstrument({ syminfo: {} }, path, neverLookup);
  assert.equal(got.instrument.resolved, true);
  assert.equal(got.instrument.source!.via, "sidecar");
  const none = await resolveInstrument({ syminfo: {} }, csv(), neverLookup);
  assert.equal(none.instrument.reason, "no symbol, syminfo or sidecar was given");
});

test("syminfo without a lot size warns", async () => {
  const got = await resolveInstrument({ syminfo: { mintick: 0.5 } }, csv(), neverLookup);
  assert.equal(got.instrument.resolved, false);
  assert.equal(got.instrument.mintick, 0.5);
  assert.equal(got.warnings.length, 1);
  assert.match(got.warnings[0]!, /^instrument grid unavailable for bars-\d+\.csv \(syminfo has no qty_step or mincontract\)/);
});

test("neither symbol nor syminfo: the sidecar next to the CSV", async () => {
  const path = csv();
  await writeSidecar(path, instrumentFromBinance(spot("ETHUSDT"), "spot"), FEED);
  const got = await resolveInstrument({}, path, neverLookup);
  assert.equal(got.instrument.resolved, true);
  assert.equal(got.instrument.qty_step, 0.0001);
  assert.deepEqual(got.instrument.source, { kind: "binance_exchange_info", market: "spot", symbol: "ETHUSDT", via: "sidecar" });
  assert.deepEqual(got.warnings, []);
});

test("neither and no sidecar: unresolved, warned, says what to pass", async () => {
  const got = await resolveInstrument({}, csv(), neverLookup);
  assert.deepEqual(got.instrument, { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "no symbol, syminfo or sidecar was given" });
  assert.equal(got.warnings.length, 1);
  assert.match(got.warnings[0]!, /^instrument grid unavailable for bars-\d+\.csv \(no symbol, syminfo or sidecar was given\): order quantity is not floored/);
  assert.match(got.warnings[0]!, /Pass `symbol`.*`syminfo`.*fetch_binance_ohlcv/);
});

test("a stale sidecar is not used and the warning says why (the instrument's reason stays fixed text)", async () => {
  const path = csv(["1000,1,1,1,1,1", "9000,1,1,1,1,1"]);
  await writeSidecar(path, instrumentFromBinance(spot("BTCUSDT"), "spot"), FEED);
  const got = await resolveInstrument({}, path, neverLookup);
  assert.equal(got.instrument.resolved, false);
  assert.equal(got.instrument.reason, "sidecar ignored");
  assert.equal(got.warnings.length, 1);
  assert.match(got.warnings[0]!, /\(sidecar ignored: bars-\d+\.csv\.instrument\.json was written for bars 1000\.\.3000 and the CSV now holds 1000\.\.9000\): order quantity/);
});

test("dropped values are warned about even when the lot size resolved", async () => {
  const lookup = async () => ({ ...spot("BTCUSDT"), filters: [{ filterType: "LOT_SIZE", stepSize: "0.001" }] });
  const got = await resolveInstrument({ symbol: "BTCUSDT" }, csv(), lookup);
  assert.equal(got.instrument.resolved, true);
  assert.deepEqual(got.instrument.source!.dropped, ["mintick"]);
  assert.equal(got.warnings.length, 2);
  assert.match(got.warnings[0]!, /instrument values dropped.*: mintick;/);
  assert.match(got.warnings[1]!, /no mintick, so the engine's default tick of 0\.01 applies/);
});

test("the warning text is the contract's", () => {
  assert.ok(unresolvedWarning("Binance spot FOO", "why").startsWith(
    "instrument grid unavailable for Binance spot FOO (why): order quantity is not floored to a lot size, " +
    "so the run can contain sub-lot margin-call rows that TradingView does not book"));
});

test("reasons are printable ASCII of at most 200 characters", () => {
  const got = unresolvedInstrument("café " + "x".repeat(300));
  assert.equal(got.reason!.length, 200);
  assert.match(got.reason!, /^caf\? /);
});

// ─── what the engine says it applied ──────────────────────────────────────

test("appliedWarnings: silent when the engine applied what was asked", () => {
  const asked = instrumentFromBinance(spot("BTCUSDT"), "spot");
  assert.deepEqual(appliedWarnings(asked, { applied_runtime: { syminfo: { resolved: true, qty_step: 0.00001 } } }), []);
  // an unresolved instrument was asked for and is reported as such: nothing more to say
  assert.deepEqual(appliedWarnings(unresolvedInstrument("x"), { applied_runtime: { syminfo: { resolved: false } } }), []);
});

test("appliedWarnings: an image that reports no instrument is named", () => {
  const asked = instrumentFromBinance(spot("BTCUSDT"), "spot");
  for (const report of [{}, { applied_runtime: {} }, { applied_runtime: { syminfo: null } }, null, "x"]) {
    const w = appliedWarnings(asked, report);
    assert.equal(w.length, 1, JSON.stringify(report));
    assert.match(w[0]!, /did not report the instrument it applied.*too old.*lot grid was probably not applied/);
  }
});

test("appliedWarnings: a resolved instrument the engine did not apply, and what it could not set", () => {
  const asked = instrumentFromBinance(spot("BTCUSDT"), "spot");
  const refused = appliedWarnings(asked, { applied_runtime: { syminfo: { resolved: false, reason: "the engine library cannot set the lot grid", skipped: ["qty_step", "mincontract"] } } });
  assert.deepEqual(refused, [
    "the engine did not apply the instrument's lot grid (the engine library cannot set the lot grid)",
    "the engine library could not set qty_step, mincontract from the instrument",
  ]);
  const partial = appliedWarnings(asked, { applied_runtime: { syminfo: { resolved: true, skipped: ["ticker"] } } });
  assert.deepEqual(partial, ["the engine library could not set ticker from the instrument"]);
});
