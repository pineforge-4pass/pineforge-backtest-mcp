# Legal information

Summary of licensing, third-party components, and trademarks for `@pineforge/backtest-mcp`. **Not** legal advice; consult counsel for your use case.

## License

This MCP server is distributed under the **MIT License** — see [LICENSE](LICENSE).

It is a thin local bridge. The components it drives have **their own** licenses:

- The **PineForge engine** Docker image it runs is **Apache-2.0** ([`pineforge-engine`](https://github.com/pineforge-4pass/pineforge-engine)).
- `parity/vendor/` holds three unmodified `scripts/` files of pineforge-engine v1.2.0 (`verify_corpus.py`, `run_strategy.py`, `derive_corpus_feeds.py`), **Apache-2.0**, used by `check_tradingview_parity`.
- The **transpiler** bundled inside that image, [`pineforge-codegen`](https://github.com/pineforge-4pass/pineforge-codegen-oss), is **source-available** (not OSI open source). From codegen 1.2.0 it is under the **PineForge Source License 1.1**; its [`LICENSE`](https://github.com/pineforge-4pass/pineforge-codegen-oss/blob/main/LICENSE) is the controlling text and this is only a summary. Noncommercial use is free, and so is **Personal Trading**: a natural person researching, developing or backtesting strategies and trading their own account with their own capital. **Investment management** (using it to manage, advise on or trade investment capital, or to research, develop or backtest strategies for it, whoever the capital belongs to, your own included) is **Commercial Use** for every individual and organization unless it is Personal Trading; so is any other use that is not free, such as use by or for a company or fund, embedding the software or its output in a product or service for others, or operating a hosted or public-facing service. Commercial Use needs a commercial license: email **enterprise@pineforge.dev**. Releases up to and including 1.1.0 were published under the license text that came with them (the PolyForm Noncommercial License 1.0.0 with a PineForge supplement), and copies of those releases keep it.

## How it runs (data handling)

Fully local. The server bridges an MCP client to the user's **own** Docker daemon and to **Binance's public market-data API**. No API key; transpile, backtest and parity grading run on the user's machine (the TradingView trade list passed to `check_tradingview_parity` included). OHLCV file paths are scoped to the working directory by default. The server does not transmit user source or data to PineForge.

## Third-party components

Node dependencies are declared in `package.json` and carry their own upstream licenses (MIT/BSD/Apache-style per package). Binance public market data is factual price/volume data.

## Trademarks and affiliation

**TradingView** and **PineScript** are trademarks of their respective owners; **Binance** is a trademark of its owner. This project is **not** affiliated with, endorsed by, or certified by any of them. Uses of "PineScript v6" and "Binance" are **nominative** — describing the input language and the public data source only.

## No warranty

Provided **"AS IS"** under the MIT License, without warranty of any kind. Backtest results are **not** investment advice and carry no warranty of trading outcomes.
