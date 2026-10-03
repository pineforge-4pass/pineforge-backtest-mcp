/**
 * The title and MCP tool annotations of every tool, in one table per runner
 * mode: createServer spreads each entry into registerTool, so tools/list carries
 * them (Tool.title, and Tool.annotations with the hint names of the MCP spec
 * since 2025-03-26).
 *
 * The hints describe what a call does outside the conversation:
 *   - readOnlyHint: true for the lookups and check_tradingview_parity, which
 *     works in a temporary directory it deletes; in-process, transpile_pine too.
 *     backtest_pine and backtest_pine_grid write a report file when the result is
 *     too large to return; fetch_binance_ohlcv writes its CSV (and the instrument
 *     file next to it); the image tools pull the engine image. In Docker mode
 *     transpile_pine takes an `image`, which docker run pulls from its registry
 *     when it is missing: there it is not read-only and open-world. The two
 *     backtests are open-world in both modes: their `symbol` is looked up in
 *     Binance's public exchangeInfo (and in Docker mode `image` is pulled too).
 *     (check_tradingview_parity runs the default image only; its first pull, as
 *     any docker run's, is not counted.)
 *   - destructiveHint: true where the tool writes a file at a path the caller
 *     names, which replaces a file already there.
 *   - idempotentHint: false where a repeat writes another report file, or
 *     fetches newer bars into the same file (end_time defaults to now).
 *   - openWorldHint: true where the tool reaches Binance's public API or an
 *     image registry.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface ToolMeta {
  title: string;
  annotations: Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;
}

const LOOKUP = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES_REPORT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const WRITES_REPORT_OPEN = { ...WRITES_REPORT, openWorldHint: true } as const;
const PULLS_IMAGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function toolMeta(mode: "docker" | "local") {
  const docker = mode === "docker";
  return {
    transpile_pine: { title: "Transpile Pine to C++", annotations: docker ? PULLS_IMAGE : LOOKUP },
    backtest_pine: { title: "Backtest a Pine strategy", annotations: WRITES_REPORT_OPEN },
    backtest_pine_grid: { title: "Sweep strategy parameters", annotations: WRITES_REPORT_OPEN },
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
    pull_engine_image: { title: "Pull the engine image", annotations: PULLS_IMAGE },
    check_engine_image: { title: "Check the engine image", annotations: PULLS_IMAGE },
    engine_info: { title: "Get engine info", annotations: LOOKUP },
  } satisfies Record<string, ToolMeta>;
}
