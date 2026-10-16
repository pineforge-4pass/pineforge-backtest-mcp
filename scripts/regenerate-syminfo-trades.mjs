// Dispatch-only engine recording. Output stays in .release-ci for human review.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DockerRunner } from "../dist/engine.js";
import { readLock, sha256 } from "./release-contract.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Record expected trades on the CI runner via regenerate-syminfo-trades.yml");
const lock = readLock();
const image = `${lock.image.repository}@${lock.image.digest}`;
// Explicit constructor pins both transpile and backtest, regardless of env overrides.
const runner = new DockerRunner(image);
const csvPath = resolve("test/fixtures/syminfo/btcusdt-4h-2188.csv");
const csv = readFileSync(csvPath);
const pine = readFileSync("test/fixtures/syminfo/btc-ema-crossover.pine");
const inventory = JSON.parse(readFileSync("test/fixtures/release/runtime-inventory.json", "utf8"));
const previous = JSON.parse(readFileSync("test/fixtures/syminfo/btcusdt-4h-ema-trades.json", "utf8"));
assert.equal(sha256(csv), inventory.syminfo_feed_sha256, "wrong frozen feed");
assert.equal(csv.toString("utf8").trimEnd().split("\n").length - 1, inventory.syminfo_bars, "wrong bar count");
assert.equal(sha256(pine), previous.pine_sha256, "Pine changed; review the strategy separately");

const output = resolve(".release-ci/syminfo-regeneration");
mkdirSync(output, { recursive: true });
const cppPath = resolve(output, "strategy.cpp");
writeFileSync(cppPath, await runner.transpile(pine.toString("utf8")));
const instrument = {
  schema: "pineforge-instrument/v1", resolved: true,
  qty_step: 0.00001, mintick: 0.01, pointvalue: 1, mincontract: 0.00001, type: "crypto",
  currency: "USDT", basecurrency: "BTC", source: { kind: "user" },
};
const fields = ["entry_time", "exit_time", "entry_price", "exit_price", "qty", "pnl", "commission",
  "entry_bar_index", "exit_bar_index", "open_at_end", "entry_incarnation"];
const tapes = {};
for (const mode of ["gridless", "gridded"]) {
  const notices = [];
  const report = await runner.backtest({
    cppPath, csvPath, ...(mode === "gridded" ? { instrument } : {}), notices,
  });
  assert.deepEqual(notices, [], `${mode}: engine fell back from the requested instrument`);
  assert.ok(report && Array.isArray(report.trades) && report.trades.length > 0, `${mode}: no engine trades`);
  assert.ok(!report.error, `${mode}: engine returned an error`);
  if (mode === "gridded") {
    assert.deepEqual(report.applied_runtime?.syminfo, instrument, "engine must apply the complete requested grid");
  } else {
    assert.equal(report.applied_runtime?.syminfo, undefined, "gridless must use engine defaults");
  }
  tapes[mode] = report.trades.map((trade) => Object.fromEntries(fields.map((field) => {
    const value = trade[field];
    assert.ok(field === "open_at_end" ? typeof value === "boolean" : typeof value === "number" && Number.isFinite(value),
      `${mode}: missing/invalid engine trade field ${field}`);
    return [field, value];
  })));
  writeFileSync(resolve(output, `${mode}-report.json`), JSON.stringify(report, null, 2) + "\n");
}
const expected = {
  _about: "BTCUSDT 4h EMA 20/50 crossover (btc-ema-crossover.pine), 100% equity, 0.1% commission. " +
    "New in-repo 2188-bar Binance spot REST feed, 2025-10-04 00:00 through 2026-10-03 12:00 UTC, " +
    `CSV sha256 ${sha256(csv)}. Primary position rows (11 compared fields) recorded by pinned runtime ${image} ` +
    `(release ${lock.release_version}, hub commit ${lock.hub_commit}): 'gridless' = engine defaults (no qty_step), ` +
    "'gridded' = qty_step 0.00001 + mintick 0.01 + pointvalue 1 + type crypto + currency USDT + basecurrency BTC + mincontract 0.00001.",
  pine_sha256: sha256(pine), csv_sha256: sha256(csv), bars: inventory.syminfo_bars,
  gridless: tapes.gridless, gridded: tapes.gridded,
};
writeFileSync(resolve(output, "btcusdt-4h-ema-trades.json"), JSON.stringify(expected, null, 1) + "\n");
writeFileSync(resolve(output, "provenance.json"), JSON.stringify({
  source_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID,
  run_attempt: process.env.GITHUB_RUN_ATTEMPT, image, lock,
  csv_sha256: expected.csv_sha256, pine_sha256: expected.pine_sha256,
  gridless_rows: tapes.gridless.length, gridded_rows: tapes.gridded.length,
}, null, 2) + "\n");
console.log(`Recorded gridless=${tapes.gridless.length}, gridded=${tapes.gridded.length}; review ${output}/btcusdt-4h-ema-trades.json`);
