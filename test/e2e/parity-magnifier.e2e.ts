/** Real-engine magnifier regressions over MCP stdio; Binance is not mocked. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callParity, connect } from "./client.js";
import { env, listProbes, probeCall } from "./corpus.js";

const start = Date.UTC(2026, 8, 1);
const header = "timestamp,open,high,low,close,volume\n";
const chart = header + Array.from({ length: 3 }, (_, i) =>
  `${start + i * 900_000},100,${i === 2 ? 120 : 101},99,100,15\n`).join("");
const fineRows = Array.from({ length: 45 }, (_, i) =>
  `${start + i * 60_000},100,${i === 36 ? 120 : 101},99,100,1\n`);
const pine = `//@version=6
strategy("tail", use_bar_magnifier=((true)), initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("X", "L", limit=110)
`;
const args = {
  pine,
  tradingview_trades: "Trade #,Type,Date and time,Signal,Price USDT,Size (qty),Net P&L USDT\n" +
    "1,Exit long,2026-09-01 00:30,X,110,1,10\n1,Entry long,2026-09-01 00:15,L,100,1,10\n",
  timeframe: "15", chart_timezone: "UTC", range_start: new Date(start).toISOString(),
  range_end: new Date(start + 1_800_000).toISOString(), ohlcv_csv: chart,
};
const harnessLog = (data: Record<string, unknown> | undefined) =>
  ((data?.window as { harness_log?: string[] } | undefined)?.harness_log ?? []).join("\n");

test("the magnifier reads the final chart bar's tail; user feeds and missing-feed warning", async () => {
  const client = await connect();
  const dir = mkdtempSync(join(tmpdir(), "CHECK-OWN-local-fix2-magnifier-"));
  try {
    const full = await callParity(client, { ...args, magnifier_ohlcv_csv: header + fineRows.join("") });
    console.log(`full 45-minute feed: ${full.data?.tier}; ${harnessLog(full.data)}`);
    assert.equal(full.data?.tier, "excellent", full.text);
    assert.match(harnessLog(full.data), /magnifier: declared:/);
    assert.doesNotMatch(full.formatted, /ran without one/);

    const path = join(dir, "fine.csv");
    writeFileSync(path, header + fineRows.slice(0, 31).join(""));
    const cut = await callParity(client, { ...args, magnifier_ohlcv_csv_path: path });
    console.log(`truncated 31-minute feed: ${cut.data?.tier}`);
    assert.equal(cut.data?.tier, "moderate", cut.text);
    assert.match(harnessLog(cut.data), /magnifier: declared:/);

    const tvFine = "time,open,high,low,close,Volume\n" + fineRows.map((row) => {
      const [ms, ...rest] = row.trim().split(",");
      return [Number(ms) / 1000, ...rest].join(",") + "\n";
    }).join("");
    writeFileSync(path, tvFine);
    const converted = await callParity(client, { ...args, magnifier_ohlcv_csv_path: path });
    assert.equal(converted.data?.tier, "excellent", converted.text);
    assert.deepEqual(converted.data?.metrics, full.data?.metrics);

    const missing = await callParity(client, args);
    assert.equal(missing.data?.ok, true, missing.text);
    assert.match(harnessLog(missing.data), /magnifier: declared-not-run:/);
    assert.match(missing.formatted, /declares the bar magnifier but ran without one.*fills inside bars may differ from TradingView's/);
    console.log(`missing feed: warning shown; ${harnessLog(missing.data)}`);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a magnifier-declaring corpus probe fetches chart and 1-minute bars from Binance", async () => {
  const p = listProbes(env("PF_E2E_CORPUS")).find((p) => p.slug === "barstate-isconfirmed-magnifier-on-01a")!;
  assert.ok(p);
  const { args: request } = probeCall(p, env("PF_E2E_FEED_15M"), env("PF_E2E_FEED_1M"));
  delete request.ohlcv_csv_path;
  // Five complete corpus trades keep the live fetch within the public bar cap.
  request.tradingview_trades = readFileSync(join(p.dir, "tv_trades.csv"), "utf8")
    .split(/\r?\n/).slice(0, 11).join("\n") + "\n";
  request.range_start = "2025-03-31T00:00:00Z";
  // The same script with its title as a multiline triple-quoted string, which
  // codegen 1.0.1 accepts and still reads as declaring the magnifier.
  const title = '"PF barstate-magnifier probe 01a - isconfirmed ON"';
  assert.ok(String(request.pine).includes(title));
  const variants: Array<[string, string]> = [
    ["ordinary title", String(request.pine)],
    ["multiline triple-quoted title", String(request.pine).replace(title, '"""PF barstate-magnifier probe 01a\nisconfirmed ON"""')],
  ];
  const client = await connect();
  try {
    const tiers: unknown[] = [];
    for (const [label, pine] of variants) {
      const out = await callParity(client, { ...request, pine });
      assert.equal(out.data?.ok, true, out.text);
      assert.match(harnessLog(out.data), /magnifier: declared:.*input_tf=1.*magnifier on/, label);
      assert.match(String(out.data?.bars_source), /Binance.*15m/);
      assert.match(String(out.data?.magnifier_bars_source), /Binance.*1m/, label);
      assert.doesNotMatch(out.formatted, /ran without one/);
      tiers.push([out.data?.tier, out.data?.matched]);
      console.log(`LIVE ${p.slug} (${label}, first 5 complete trades): tier ${out.data?.tier}, matched ${out.data?.matched}; ` +
        `${out.data?.bars_source}; magnifier ${out.data?.magnifier_bars_source}; ${harnessLog(out.data)}`);
    }
    assert.deepEqual(tiers[1], tiers[0]);
  } finally {
    await client.close();
  }
});
