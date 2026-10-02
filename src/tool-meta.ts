/**
 * The title and MCP tool annotations of every tool, in one table: createServer
 * spreads each entry into registerTool, so tools/list carries them (Tool.title,
 * and Tool.annotations with the hint names of the MCP spec since 2025-03-26).
 *
 * The hints describe what a call does outside the conversation:
 *   - readOnlyHint: true for the lookups and for transpile_pine and
 *     check_tradingview_parity, which work in a temporary directory they delete.
 *     backtest_pine and backtest_pine_grid write a report file when the result is
 *     too large to return; fetch_binance_ohlcv writes its CSV; the image tools
 *     pull the engine image. (In Docker mode the first docker run of a missing
 *     image pulls it, as any docker run does; that is not counted here.)
 *   - destructiveHint: true where the tool writes a file at a path the caller
 *     names, which replaces a file already there.
 *   - idempotentHint: false where a repeat writes another report file, or
 *     fetches newer bars into the same file (end_time defaults to now).
 *   - openWorldHint: true where the tool reaches Binance's public API or the
 *     image registry.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface ToolMeta {
  title: string;
  annotations: Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;
}

const LOOKUP = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES_REPORT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const IMAGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const TOOL_META = {
  transpile_pine: { title: "Transpile Pine to C++", annotations: LOOKUP },
  backtest_pine: { title: "Backtest a Pine strategy", annotations: WRITES_REPORT },
  backtest_pine_grid: { title: "Sweep strategy parameters", annotations: WRITES_REPORT },
  check_tradingview_parity: { title: "Check TradingView parity", annotations: { ...LOOKUP, openWorldHint: true } },
  fetch_binance_ohlcv: {
    title: "Fetch Binance OHLCV to a file",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  binance_symbols: { title: "List Binance symbols", annotations: { ...LOOKUP, openWorldHint: true } },
  list_engine_params: { title: "List engine parameters", annotations: LOOKUP },
  list_coverage_topics: { title: "List Pine coverage topics", annotations: LOOKUP },
  get_coverage_topic: { title: "Get a Pine coverage topic", annotations: LOOKUP },
  check_pine_feature: { title: "Check a Pine feature", annotations: LOOKUP },
  pull_engine_image: { title: "Pull the engine image", annotations: IMAGE },
  check_engine_image: { title: "Check the engine image", annotations: IMAGE },
  engine_info: { title: "Get engine info", annotations: LOOKUP },
} as const satisfies Record<string, ToolMeta>;
