# `@pineforge/codegen-mcp`

Local stdio MCP server: bridges an AI agent to the hosted PineForge codegen API
**and** the user's local Docker daemon. The OHLCV file never leaves the user's
machine — only the Pine source travels to the API.

## Tools

| name | runs on | quota |
|---|---|---|
| `transpile_pine`     | remote API   | counts (refunded on compile error) |
| `get_quota`          | remote API   | free |
| `backtest_pine`      | local Docker | counts 1 (the transpile call inside) |
| `pull_engine_image`  | local Docker | free |

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
export PINEFORGE_GATEWAY="https://codegen-gateway.luis-fca.workers.dev"   # optional
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

## `backtest_pine` example

```jsonc
{
  "source": "//@version=6\nstrategy(\"sma cross\")\n...",
  "ohlcv_csv_path": "./btcusdt_15m_7d.csv"
}
```

Returns the same JSON schema as the standalone `pineforge-engine` Docker image:

```jsonc
{
  "engine": "pineforge",
  "summary": { "total_trades": 49, "net_pnl": -190.85, ... },
  "trades": [ ... ],
  "elapsed_seconds": 0.0042,
  "_meta": { "strategy_cpp_bytes": 5079, "image": "ghcr.io/.../pineforge-engine:latest" }
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
