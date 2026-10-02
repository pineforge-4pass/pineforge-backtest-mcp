// tools/list carries a title and the four MCP annotation hints on every tool, in
// both server modes (Docker: the image tools; in-process: engine_info). A real
// Client on an in-memory transport to the server createServer() builds, with a
// runner that runs nothing. The table below is the oracle, written out by hand
// (not imported from src/tool-meta.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { EngineRunner } from "../src/engine.js";

//            title                             readOnly destructive idempotent openWorld
const SHARED: Record<string, [string, boolean, boolean, boolean, boolean]> = {
  transpile_pine: ["Transpile Pine to C++", true, false, true, false],
  backtest_pine: ["Backtest a Pine strategy", false, true, false, false],
  backtest_pine_grid: ["Sweep strategy parameters", false, true, false, false],
  check_tradingview_parity: ["Check TradingView parity", true, false, true, true],
  fetch_binance_ohlcv: ["Fetch Binance OHLCV to a file", false, true, false, true],
  binance_symbols: ["List Binance symbols", true, false, true, true],
  list_engine_params: ["List engine parameters", true, false, true, false],
  list_coverage_topics: ["List Pine coverage topics", true, false, true, false],
  get_coverage_topic: ["Get a Pine coverage topic", true, false, true, false],
  check_pine_feature: ["Check a Pine feature", true, false, true, false],
};
const DOCKER_ONLY: typeof SHARED = {
  pull_engine_image: ["Pull the engine image", false, false, true, true],
  check_engine_image: ["Check the engine image", false, false, true, true],
};
const LOCAL_ONLY: typeof SHARED = {
  engine_info: ["Get engine info", true, false, true, false],
};

async function listTools(mode: "docker" | "local") {
  const runner = { mode } as unknown as EngineRunner;
  const server = createServer(runner, { imageTools: mode === "docker" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "annotations-test", version: "1" });
  await server.connect(b);
  await client.connect(a);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

for (const [mode, extra] of [["docker", DOCKER_ONLY], ["local", LOCAL_ONLY]] as const) {
  test(`tools/list (${mode} mode): every tool has its title and all four annotation hints`, async () => {
    const want = { ...SHARED, ...extra };
    const tools = await listTools(mode);
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(want).sort());
    for (const t of tools) {
      const [title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = want[t.name]!;
      assert.equal(t.title, title, `${t.name}: title`);
      assert.deepEqual(t.annotations, { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }, `${t.name}: annotations`);
    }
  });
}
