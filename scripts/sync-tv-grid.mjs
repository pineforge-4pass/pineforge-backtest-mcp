#!/usr/bin/env node
// Regenerate src/tv-grid.generated.json, the lot sizes TradingView reports for Binance symbols,
// from a table of TradingView's own syminfo receipts (schema pineforge-tv-syminfo-receipts/v1):
//
//   node scripts/sync-tv-grid.mjs <path to tv-grid-table.json>
//
// Only the two Binance venues are read: each symbol's `mincontract`, the venue's `not_on_tv` list (the
// symbols TradingView does not list), and, per market, TradingView's usual lot size (0.001) with the
// share of the readings that are it, written only when that share is at least 0.80. The output is
// deterministic (sorted, one symbol per line), so re-running on the same table changes nothing.
// A table that is not complete, has a value outside 1e-12..1e12, or has no usable `not_on_tv`, is refused,
// not trimmed. `content_sha256` covers all of it: the readings, then each market's not-on-TradingView
// symbols (`not_on_tv <market>`, one per line), then each market's default (`defaults <market>`,
// `mincontract=.. share=.. n=..` or `none`). `--out <path>` writes elsewhere (the tests do).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_SCHEMA = "pineforge-tv-syminfo-receipts/v1";
const OUTPUT_SCHEMA = "pineforge-tv-grid/v1";
const MARKETS = { spot: "crypto.binance.com.spot", usdt_perp: "crypto.binance.com.perp-usdt" };
const DEFAULT_OUT = fileURLToPath(new URL("../src/tv-grid.generated.json", import.meta.url));
const USUAL_MINCONTRACT = 0.001;
const USUAL_MIN_SHARE = 0.8;
const SYMBOL = /^[\x21-\x7e]{1,64}$/;

function fail(message) {
  process.stderr.write(`sync-tv-grid: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
let out = DEFAULT_OUT;
const outAt = args.indexOf("--out");
if (outAt >= 0) {
  out = args[outAt + 1] ?? fail("--out needs a path");
  args.splice(outAt, 2);
}
if (args.length !== 1) fail("usage: node scripts/sync-tv-grid.mjs <path to tv-grid-table.json> [--out <path>]");

const bytes = readFileSync(args[0]);
let table;
try {
  table = JSON.parse(bytes.toString("utf8"));
} catch (e) {
  fail(`${args[0]} is not JSON: ${e.message}`);
}
if (table?.schema !== SOURCE_SCHEMA) fail(`${args[0]} is not a ${SOURCE_SCHEMA} table (schema ${JSON.stringify(table?.schema)})`);
if (table.complete !== true) fail(`${args[0]} is not complete (its "complete" is ${JSON.stringify(table.complete)}): it is still being refreshed`);
if (typeof table.generated_utc !== "string" || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(table.generated_utc)) {
  fail(`${args[0]} has no generated_utc`);
}
const notListed = table.not_on_tv;
if (typeof notListed !== "object" || notListed === null || Array.isArray(notListed)) {
  fail(`${args[0]} has no not_on_tv (an object of symbol lists by venue): it cannot tell a symbol TradingView does not list from a new one`);
}

const grids = {};
const notOnTv = {};
const defaults = {};
for (const [market, venue] of Object.entries(MARKETS)) {
  const rows = table.rows?.[venue];
  if (typeof rows !== "object" || rows === null || Array.isArray(rows)) fail(`${args[0]} has no rows for ${venue}`);
  const bad = [];
  const entries = [];
  for (const symbol of Object.keys(rows).sort()) {
    const value = rows[symbol]?.mincontract;
    const ok = typeof value === "number" && Number.isFinite(value) && value >= 1e-12 && value <= 1e12 && SYMBOL.test(symbol);
    if (ok) entries.push([symbol, value]);
    else bad.push(`${symbol}=${JSON.stringify(rows[symbol]?.mincontract)}`);
  }
  if (bad.length) fail(`${venue}: ${bad.length} rows without a usable mincontract (${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", ..." : ""})`);
  if (entries.length === 0) fail(`${venue} has no rows`);
  grids[market] = entries;

  // The symbols TradingView does not list (a venue with none may be left out); none may also have a reading.
  const unlisted = notListed[venue] ?? [];
  if (!Array.isArray(unlisted) || !unlisted.every((s) => typeof s === "string" && SYMBOL.test(s))) {
    fail(`not_on_tv of ${venue} is not a list of symbols`);
  }
  const both = unlisted.filter((s) => Object.prototype.hasOwnProperty.call(rows, s)).sort();
  if (both.length) fail(`${venue}: ${both[0]} is both read and not on TradingView${both.length > 1 ? ` (and ${both.length - 1} more)` : ""}`);
  notOnTv[market] = [...new Set(unlisted)].sort();

  // TradingView's usual lot size, where it is what at least 80% of the readings say.
  const share = entries.filter(([, v]) => v === USUAL_MINCONTRACT).length / entries.length;
  if (share >= USUAL_MIN_SHARE) {
    defaults[market] = { mincontract: USUAL_MINCONTRACT, share: Math.round(share * 1e4) / 1e4, n: entries.length };
  }
}

// What the file holds, as text, for the hash that lets a test notice a hand edit.
const markets = Object.keys(MARKETS);
const canonical =
  markets.map((m) => `${m}\n${grids[m].map(([s, v]) => `${s}=${v}\n`).join("")}`).join("") +
  markets.map((m) => `not_on_tv ${m}\n${notOnTv[m].map((s) => `${s}\n`).join("")}`).join("") +
  markets.map((m) => {
    const d = defaults[m];
    return `defaults ${m}\n${d ? `mincontract=${d.mincontract} share=${d.share} n=${d.n}\n` : "none\n"}`;
  }).join("");

const block = (entries) => `{\n${entries.map(([s, v]) => `    ${JSON.stringify(s)}: ${JSON.stringify(v)}`).join(",\n")}\n  }`;
const listBlock = (list) => (list.length ? `[\n${list.map((s) => `      ${JSON.stringify(s)}`).join(",\n")}\n    ]` : "[]");
const notOnTvBlock = `{\n${markets.map((m) => `    ${JSON.stringify(m)}: ${listBlock(notOnTv[m])}`).join(",\n")}\n  }`;
const defaultsBlock = Object.keys(defaults).length
  ? `{\n${Object.entries(defaults).map(([m, d]) => `    ${JSON.stringify(m)}: ${JSON.stringify(d)}`).join(",\n")}\n  }`
  : "{}";
const text =
  "{\n" +
  `  "schema": ${JSON.stringify(OUTPUT_SCHEMA)},\n` +
  `  "_comment": "Generated by scripts/sync-tv-grid.mjs from TradingView's own syminfo.mincontract; do not edit.",\n` +
  `  "source": ${JSON.stringify({
    schema: SOURCE_SCHEMA,
    generated_utc: table.generated_utc,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    venues: MARKETS,
  })},\n` +
  `  "counts": ${JSON.stringify(Object.fromEntries(Object.keys(MARKETS).map((m) => [m, grids[m].length])))},\n` +
  `  "content_sha256": ${JSON.stringify(createHash("sha256").update(canonical).digest("hex"))},\n` +
  `  "defaults": ${defaultsBlock},\n` +
  `  "not_on_tv": ${notOnTvBlock},\n` +
  `  "spot": ${block(grids.spot)},\n` +
  `  "usdt_perp": ${block(grids.usdt_perp)}\n` +
  "}\n";
writeFileSync(out, text);
const usual = markets.filter((m) => defaults[m]).map((m) => `${m} ${defaults[m].mincontract} (${defaults[m].share} of ${defaults[m].n})`);
process.stdout.write(
  `wrote ${out}: spot ${grids.spot.length}, usdt_perp ${grids.usdt_perp.length} symbols, ` +
  `source ${table.generated_utc} sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}; ` +
  `not on TradingView: spot ${notOnTv.spot.length}, usdt_perp ${notOnTv.usdt_perp.length}; ` +
  `usual lot size: ${usual.length ? usual.join(", ") : "none"}\n`,
);
