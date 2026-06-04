# Demo GIF

`../../assets/demo.gif` is rendered from these two files with
[`vhs`](https://github.com/charmbracelet/vhs):

- `demo.mjs` — drives the **container** (`pineforge-codegen-mcp:local`) over MCP
  stdio and pretty-prints one call each of `engine_info`, `fetch_binance_ohlcv`,
  `transpile_pine`, `backtest_pine`, `backtest_pine_grid`.
- `demo.tape` — the vhs script (window size, font, timing).

## Regenerate

```bash
# 1. build the local image
docker build -f docker/Dockerfile -t pineforge-codegen-mcp:local .

# 2. render (from this directory; vhs writes demo.gif here)
vhs demo.tape

# 3. copy into the repo
cp demo.gif ../../assets/demo.gif
```

Requires `vhs` (`brew install vhs`), Docker, and outbound network (the demo
fetches live Binance klines). The demo mounts the current dir into the
container at `/work`, so run it from a writable scratch dir if needed.
