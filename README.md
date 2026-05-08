# `@pineforge/codegen-mcp`

Local stdio MCP server: bridges an AI agent to the hosted PineForge codegen API
**and** the user's local Docker daemon. The OHLCV file never leaves the user's
machine — only the Pine source travels to the API.

## Tools

| name                   | runs on              | quota                                          | purpose                                                                  |
| ---------------------- | -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `transpile_pine`       | remote API           | counts (refunded on compile error)             | Pine v6 → C++ translation unit                                           |
| `get_quota`            | remote API           | free                                           | Read current month's quota usage                                         |
| `list_engine_params`   | local (no I/O)       | free                                           | Catalog of every `overrides` + `runtime` knob accepted by the backtests  |
| `backtest_pine`        | local Docker         | counts 1 (the transpile call inside)           | Single backtest of a Pine source against an OHLCV CSV                    |
| `backtest_pine_grid`   | local Docker         | counts 1 (transpiled once for the whole sweep) | Cartesian sweep of `inputs` × `overrides` reusing one compile            |
| `fetch_binance_ohlcv`  | Binance public API   | free                                           | Write a backtest-ready CSV from Binance spot or USDT-perp klines         |
| `binance_symbols`      | Binance public API   | free                                           | List / filter Binance symbols (5-min in-process cache)                   |
| `pull_engine_image`    | local Docker         | free                                           | Pre-pull the `pineforge-engine` runtime image                            |

## Install

```bash
npx -y @pineforge/codegen-mcp
```

Requires:
- Node ≥ 20
- Docker daemon running locally
- A PineForge API key (`pf_…`)

## Auth

Set env vars:

```bash
export PINEFORGE_API_KEY="pf_..."
export PINEFORGE_GATEWAY="https://codegen.pineforge.dev"   # optional
```

## Client configuration

### Claude Desktop / generic JSON

```jsonc
{
  "mcpServers": {
    "pineforge-codegen": {
      "command": "npx",
      "args": ["-y", "@pineforge/codegen-mcp"],
      "env": {
        "PINEFORGE_API_KEY": "pf_..."
      }
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add pineforge-codegen \
  --transport stdio \
  --env PINEFORGE_API_KEY=pf_... \
  -- npx -y @pineforge/codegen-mcp
```

### Cursor

Settings → MCP → New MCP Server → paste the JSON config above.

## `list_engine_params` — discover knobs

Free, local, zero-I/O catalog of every key accepted by `backtest_pine` /
`backtest_pine_grid`, split into two groups:

- **`strategy_overrides`** — the 9 `strategy(...)` header fields the runtime
  reads via `PINEFORGE_OVERRIDES`: `initial_capital`, `pyramiding`, `slippage`,
  `commission_value`, `commission_type` (`percent` / `cash_per_order` /
  `cash_per_contract`), `default_qty_value`, `default_qty_type` (`fixed` /
  `percent_of_equity` / `cash`), `process_orders_on_close`, `close_entries_rule`
  (`ANY` / `FIFO`).
- **`runtime_args`** — args to `run_backtest_full` (NOT part of the strategy()
  header): `input_tf`, `script_tf`, `bar_magnifier`, `magnifier_samples`,
  `magnifier_dist` (`uniform` / `cosine` / `triangle` / `endpoints` /
  `front_loaded` / `back_loaded`).

Each entry is `{key, type, enum?, description}`. Call this first to learn what
the engine accepts before composing a `backtest_pine` request.

## `backtest_pine` example

```jsonc
{
  "source": "//@version=6\nstrategy(\"sma cross\")\n...",
  "ohlcv_csv_path": "./btcusdt_15m_7d.csv",

  // Optional: override Pine input.*() values without touching the source.
  // Keys = the second arg of input.*(...) (e.g. "Fast Length").
  "inputs":    { "Fast Length": 8, "Slow Length": 21 },

  // Optional: override strategy(...) header fields. Each key is typed —
  // call list_engine_params for the catalog.
  "overrides": {
    "initial_capital":    100000,
    "default_qty_type":   "percent_of_equity",
    "default_qty_value":  10,
    "commission_type":    "percent",
    "commission_value":   0.04,
    "slippage":           2,
    "pyramiding":         0,
    "process_orders_on_close": true,
    "close_entries_rule": "ANY"
  },

  // Optional: engine runtime args (NOT strategy() header). Use script_tf
  // to aggregate the input CSV into a coarser strategy timeframe — the
  // engine REJECTS script_tf finer than input_tf with a structured error
  // ({"engine":"pineforge","error":"..."}, exit code 1).
  "runtime": {
    "input_tf":          "15",
    "script_tf":         "60",
    "bar_magnifier":     true,
    "magnifier_samples": 8,
    "magnifier_dist":    "endpoints"
  }
}
```

`inputs` is forwarded as the `PINEFORGE_INPUTS` env var to the runtime image,
`overrides` as `PINEFORGE_OVERRIDES`, and each `runtime` field as a separate
`PINEFORGE_INPUT_TF` / `PINEFORGE_SCRIPT_TF` / `PINEFORGE_BAR_MAGNIFIER` /
`PINEFORGE_MAGNIFIER_SAMPLES` / `PINEFORGE_MAGNIFIER_DIST` env var. Empty /
unset → defaults from `strategy.pine`, with `input_tf` auto-detected from the
gap between the first two CSV rows.

Returns the same JSON schema as the standalone `pineforge-engine` Docker image:

```jsonc
{
  "engine": "pineforge",
  "summary": { "total_trades": 49, "net_pnl": -190.85, ... },
  "applied_inputs":    { "Fast Length": "8", "Slow Length": "21" },
  "applied_overrides": { "default_qty_value": "5" },
  "trades": [ ... ],
  "elapsed_seconds": 0.0042,
  "_meta": { "strategy_cpp_bytes": 5079, "image": "ghcr.io/.../pineforge-engine:latest" }
}
```

## `backtest_pine_grid` — parameter sweep

Transpiles the Pine source **once** (one quota hit) then runs the same
compiled binary against the cartesian product of `inputs` × `overrides`.
Returns a ranked list plus the top entry under `best`.

```jsonc
{
  "source": "//@version=6\nstrategy(\"macd\")\n...",
  "ohlcv_csv_path": "./btcusdt_15m_7d.csv",

  // Each axis is {key: list-of-values}. All combinations are tried.
  "inputs": {
    "Fast Length": [8, 12, 19],
    "Slow Length": [21, 26, 39]
  },
  "overrides": {
    "default_qty_value": [1, 5],
    "commission_value":  [0.04]
  },

  // Optional knobs:
  "fixed_inputs":     { "Source": "close" },   // applied to every combo
  "fixed_overrides":  {},                      // typed strategy() overrides
  "runtime":          { "input_tf": "15",      // engine runtime args, fixed
                        "script_tf": "60" },   // across the sweep
  "max_combinations": 64,                      // hard cap
  "concurrency":      2,                       // parallel docker runs
  "include_trades":   false,                   // omit per-trade lists
  "sort_by":          "net_pnl"                // ranking metric
}
```

## `fetch_binance_ohlcv` — pull market data

Writes a backtest-ready CSV (header `timestamp,open,high,low,close,volume`,
timestamp = open time in UNIX ms UTC) from Binance's public endpoints. No
auth required, no PineForge quota cost. Requests > 1000 bars are paginated
automatically. Output path is subject to the same cwd scope as
`ohlcv_csv_path` (relax with `PINEFORGE_ALLOW_ANYWHERE=1`).

```jsonc
{
  "symbol":      "BTCUSDT",
  "interval":    "15m",          // 1s, 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M
  "market":      "spot",         // or "usdt_perp" for USDT-margined perpetual futures
  "limit":       672,            // total bars; > 1000 paginates
  "output_path": "./btcusdt_15m_7d.csv"
  // Optional: "start_time" / "end_time" in UNIX ms UTC.
}
```

## `binance_symbols` — discover / validate symbols

Returns the list of symbols available on the Binance public API for OHLCV
fetching. Cached 5 min in-process. Use this to validate a symbol before
calling `fetch_binance_ohlcv`.

```jsonc
{
  "market":        "usdt_perp",
  "query":         "BTC",         // case-insensitive substring match
  "quote_asset":   "USDT",
  "status":        "TRADING",
  "contract_type": "PERPETUAL",   // futures-only filter
  "limit":         50
}
```

## Filesystem scope

By default, OHLCV paths must be inside the current working directory of the MCP
server process. Override with:

```bash
export PINEFORGE_ALLOW_ANYWHERE=1
```

## Other env vars

| var | default | purpose |
|---|---|---|
| `PINEFORGE_API_KEY`             | (required) | Bearer for the codegen API |
| `PINEFORGE_GATEWAY`             | production URL | Override the API host |
| `PINEFORGE_ALLOW_ANYWHERE`      | `0` | Allow OHLCV paths outside cwd |
| `PINEFORGE_DOCKER_TIMEOUT_MS`   | `120000` | Hard kill for `docker pull` / `docker run` |
