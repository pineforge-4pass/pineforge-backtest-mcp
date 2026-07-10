# Legal information

Summary of licensing, third-party components, and trademarks for `@pineforge/backtest-mcp`. **Not** legal advice; consult counsel for your use case.

## License

This MCP server is distributed under the **MIT License** — see [LICENSE](LICENSE).

It is a thin local bridge. The components it drives have **their own** licenses:

- The **PineForge engine** Docker image it runs is **Apache-2.0** ([`pineforge-engine`](https://github.com/pineforge-4pass/pineforge-engine)).
- The **transpiler** bundled inside that image, [`pineforge-codegen`](https://github.com/pineforge-4pass/pineforge-codegen-oss), is **source-available** under the **PolyForm Noncommercial License 1.0.0** (free for personal trading; commercial license for funds/products/hosted use). Running the local loop for your own trading is covered by that license's Personal Trading exception; commercial or hosted use requires a commercial license — email **luis@4pass.com.tw**.

## How it runs (data handling)

Fully local. The server bridges an MCP client to the user's **own** Docker daemon and to **Binance's public market-data API**. No API key; transpile and backtest run on the user's machine. OHLCV file paths are scoped to the working directory by default. The server does not transmit user source or data to PineForge.

## Third-party components

Node dependencies are declared in `package.json` and carry their own upstream licenses (MIT/BSD/Apache-style per package). Binance public market data is factual price/volume data.

## Trademarks and affiliation

**TradingView** and **PineScript** are trademarks of their respective owners; **Binance** is a trademark of its owner. This project is **not** affiliated with, endorsed by, or certified by any of them. Uses of "PineScript v6" and "Binance" are **nominative** — describing the input language and the public data source only.

## No warranty

Provided **"AS IS"** under the MIT License, without warranty of any kind. Backtest results are **not** investment advice and carry no warranty of trading outcomes.
