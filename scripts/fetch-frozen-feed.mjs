// Provenance check only; runtime CI consumes the committed CSV without fetching.
// Usage: node scripts/fetch-frozen-feed.mjs [output.csv]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const START = Date.parse("2025-10-04T00:00:00Z");
const END = Date.parse("2026-10-03T12:00:00Z");
const INTERVAL = 4 * 60 * 60 * 1000;
const SHA256 = "92210de855452cf82ad7d1be6c47ef68948fbbee94929df11d991c4d54ad91c6";
const BARS = 2188;
const fixture = new URL("../test/fixtures/syminfo/btcusdt-4h-2188.csv", import.meta.url);
assert.ok(process.argv.length <= 3, "usage: node scripts/fetch-frozen-feed.mjs [output.csv]");

const rows = [];
for (let cursor = START; cursor <= END;) {
  const limit = Math.min(1000, (END - cursor) / INTERVAL + 1);
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.search = new URLSearchParams({
    symbol: "BTCUSDT", interval: "4h", startTime: String(cursor), endTime: String(END), limit: String(limit),
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Binance klines: HTTP ${response.status}: ${await response.clone().text()}`);
  const page = await response.json();
  assert.ok(Array.isArray(page) && page.length > 0 && page.length <= limit, "empty/invalid Binance page");
  for (const kline of page) {
    assert.ok(Array.isArray(kline) && kline.length >= 6, "malformed Binance kline");
    assert.equal(kline[0], cursor, "missing, duplicate, unordered or out-of-window bar");
    assert.ok(cursor <= END, "bar past the frozen window");
    const values = kline.slice(1, 6);
    assert.ok(values.every((value) => typeof value === "string" && /^\d+\.\d{8}$/.test(value)),
      "Binance must supply the original 8-decimal OHLCV strings");
    rows.push([cursor, ...values].join(","));
    cursor += INTERVAL;
  }
}
assert.equal(rows.length, BARS, "wrong frozen bar count");
const bytes = Buffer.from(["timestamp,open,high,low,close,volume", ...rows, ""].join("\n"), "utf8");
const hash = createHash("sha256").update(bytes).digest("hex");
assert.equal(hash, SHA256, "Binance no longer reproduces the frozen CSV; do not replace the fixture");
assert.deepEqual(bytes, readFileSync(fixture), "committed CSV differs from the verified Binance bytes");
// Write only after every provenance check passes. With no output, verify only.
if (process.argv[2]) writeFileSync(process.argv[2], bytes);
console.log(`Reproduced ${BARS} bars, ${bytes.length} bytes, sha256 ${hash}`);
console.log(`Matches ${fileURLToPath(fixture)}`);
