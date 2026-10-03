// The public texts of the tools that take an instrument say where its numbers come from, and say the same
// thing: the lot size is TradingView's reading (Binance's step only for a symbol TradingView does not list,
// TradingView's usual 0.001 for a listing newer than the table), the tick size and currencies are Binance's.
// A real Client on an in-memory transport reads tools/list; the sentence below is the oracle, written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { EngineRunner } from "../src/engine.js";

const SOURCES =
  "The lot size is TradingView's own reading for the symbol, from a measured table shipped with this server " +
  "(Binance's LOT_SIZE.stepSize only for a symbol TradingView does not list; TradingView's usual 0.001 for a " +
  "listing newer than the table); the tick size and currencies come from Binance's public exchangeInfo " +
  "(or from the sidecar next to a CSV fetched by fetch_binance_ohlcv).";
const WRONG = /lot size and tick size come from Binance's public exchangeInfo/;

async function tools() {
  const server = createServer({ mode: "local" } as unknown as EngineRunner, { imageTools: false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "descriptions-test", version: "1" });
  await server.connect(b);
  await client.connect(a);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

test("backtest_pine, backtest_pine_grid and check_tradingview_parity state where the lot size and tick size come from", async () => {
  const list = await tools();
  for (const name of ["backtest_pine", "backtest_pine_grid", "check_tradingview_parity"]) {
    const description = list.find((t) => t.name === name)!.description!;
    assert.ok(description.includes(SOURCES), `${name}: ${description}`);
    assert.ok(!WRONG.test(description), `${name} still says the lot size comes from Binance's exchangeInfo`);
  }
  assert.match(list.find((t) => t.name === "backtest_pine")!.description!, / `syminfo` goes over all of it\./);
});

test("the symbol and market arguments say the same, with the three tiers, the measured shares and the warnings", async () => {
  for (const name of ["backtest_pine", "backtest_pine_grid"]) {
    const props = ((await tools()).find((t) => t.name === name)!.inputSchema as any).properties;
    const symbol = props.symbol.description as string;
    assert.ok(symbol.includes(SOURCES), `${name} symbol: ${symbol}`);
    assert.match(symbol, /USDT-M BTCUSDT is 0\.000001 on TradingView, 0\.001 on Binance/);
    assert.match(symbol, /90\.6% of Binance spot symbols and 97\.5% of USDT-M ones/);
    assert.match(symbol, /comes with a warning/);
    assert.ok(!WRONG.test(symbol));
    assert.match(props.market.description, /default; a warning says when it is assumed/);
    assert.match(props.syminfo.description, /win over what `symbol` or the CSV's sidecar gives/);
  }
});

test("fetch_binance_ohlcv says what it records: the same three tiers for the lot size, the exchange's tick and currencies", async () => {
  const text = (await tools()).find((t) => t.name === "fetch_binance_ohlcv")!.description!;
  assert.match(text, /lot size: TradingView's own reading from a measured table shipped with this server, Binance's LOT_SIZE\.stepSize for a symbol TradingView does not list, TradingView's usual 0\.001 for a listing newer than the table/);
  assert.match(text, /tick size and currencies from Binance's public exchangeInfo/);
  assert.match(text, /<output_path>\.instrument\.json/);
});

test("the README says the same sentence, the three-tier rule and the measured shares", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes(SOURCES), "the README does not carry the tools' sentence about the lot size and tick size");
  assert.match(readme, /TradingView's usual 0\.001/);
  assert.match(readme, /90\.6% of spot symbols \(1,237 of 1,366\) and 97\.5% of USD-M ones \(510 of 523\)/);
  assert.match(readme, /`source\.kind`[^.]*`default`/);
  assert.doesNotMatch(readme, /lot size and tick size come from Binance's public exchangeInfo/);
});
