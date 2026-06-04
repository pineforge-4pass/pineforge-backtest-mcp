# Demo GIF

`../../assets/demo.gif` is a recording of a **real** Claude Code session driving
this MCP — no scripting. A user asks (in plain language) to write a breakout
PineScript, then to backtest it on real Binance BTC data, then to grid-search
the lookback. Claude calls the pineforge tools live (`transpile_pine`,
`fetch_binance_ohlcv`, `backtest_pine`, `backtest_pine_grid`) — and even hits a
real engine quirk (`ta.highest(...)[1]`), diagnoses it, and retries.

Rendered with [`vhs`](https://github.com/charmbracelet/vhs) from `session.tape`.

## Reproduce

The recording runs the real `claude` CLI against an **isolated** config so the
session is clean (only this MCP, no other plugins/hooks). Auth is inherited
from the environment (Vertex / `ANTHROPIC_*` env vars).

```bash
# 1. self-contained image (the MCP the session talks to)
docker build -f docker/Dockerfile -t pineforge-codegen-mcp:local .   # or use ghcr :latest

# 2. isolated HOME with only the pineforge MCP + tools pre-approved
mkdir -p /tmp/pf-home/.claude /tmp/pf-sandbox
cat > /tmp/pf-home/.claude.json <<'JSON'
{ "numStartups": 50, "installMethod": "native",
  "hasCompletedOnboarding": true, "lastOnboardingVersion": "2.1.86", "theme": "dark",
  "mcpServers": { "pineforge": { "type": "stdio", "command": "docker",
    "args": ["run","--rm","-i","-v","/tmp/pf-sandbox:/work","ghcr.io/pineforge-4pass/pineforge-codegen-mcp:latest"] } },
  "projects": { "/private/tmp/pf-sandbox": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
JSON
cat > /tmp/pf-home/.claude/settings.json <<'JSON'
{ "permissions": { "allow": ["mcp__pineforge__transpile_pine","mcp__pineforge__fetch_binance_ohlcv","mcp__pineforge__backtest_pine","mcp__pineforge__backtest_pine_grid","mcp__pineforge__binance_symbols","mcp__pineforge__list_engine_params","mcp__pineforge__engine_info"] } }
JSON

# 3. record (run from the sandbox so /work maps correctly)
cd /tmp/pf-sandbox && vhs /path/to/session.tape

# 4. trim the launch frames + compress, then copy into the repo
gifsicle --unoptimize session.gif "#80-" -O3 --lossy=90 -o demo.gif
cp demo.gif <repo>/assets/demo.gif
```

`session.tape` pins `--model claude-opus-4-8` (the isolated HOME otherwise
defaults to a model id that isn't available on this account). Requires `vhs`,
`gifsicle`, `ffmpeg`, Docker, and outbound network (live Binance fetch).
