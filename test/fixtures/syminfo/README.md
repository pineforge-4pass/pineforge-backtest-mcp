# Frozen BTCUSDT feed and engine expectations

`btcusdt-4h-2188.csv` is the committed runtime E2E input. CI reads it locally;
no feed URL, Actions variable, or Binance access is needed for the BTC fixture.
`PF_E2E_SYMINFO_CSV` remains an optional local path override, and must contain
the same SHA-256-checked bytes.

| Property | Value |
|---|---|
| Source | Binance public spot REST `GET https://api.binance.com/api/v3/klines` |
| Parameters | `symbol=BTCUSDT`, `interval=4h`, `startTime=<page cursor>`, `endTime=1791028800000`, `limit=<remaining bars, at most 1000>` |
| First bar open (inclusive) | 2025-10-04 00:00 UTC (`1759536000000`) |
| Last bar open (inclusive) | 2026-10-03 12:00 UTC (`1791028800000`) |
| Bars | 2188, contiguous at 14,400,000 ms intervals |
| Bytes | 193,446 |
| SHA-256 | `92210de855452cf82ad7d1be6c47ef68948fbbee94929df11d991c4d54ad91c6` |
| Encoding | UTF-8 without BOM, LF, final newline |
| Columns | `timestamp,open,high,low,close,volume`; epoch ms; original Binance 8-decimal strings |

Run `node scripts/fetch-frozen-feed.mjs` from the repository root to re-fetch
the fixed window, assert its hash and compare every byte with the committed
fixture. An optional output path saves the verified bytes:
`node scripts/fetch-frozen-feed.mjs /tmp/btcusdt-4h-2188.csv`.
The script refuses changed upstream data before writing any output. It is a
provenance tool, separate from runtime CI.

The old feed with hash
`a53fc5ab420604ad47b0bae1cceed0ccce45e2ff63804e1d2ab8421efc5cecfb`
was lost and could not be reproduced byte-for-byte. The old
`btcusdt-4h-ema-trades.json` is deliberately retained until the supervisor
reviews a fresh engine recording. The syminfo E2E fails with a regeneration
message when its `csv_sha256` differs from the frozen fixture; comparisons
and suite inventories remain strict.

To record replacement expectations, run the **Regenerate syminfo expected
trades** Actions workflow, job `regenerate-syminfo-trades`, on the desired ref:

```sh
gh workflow run regenerate-syminfo-trades.yml --ref rc/offline-gates
```

The workflow must first be available to GitHub Actions (new dispatch workflows
normally need a copy on the default branch). It has no inputs and no dependency
on the runtime gate, which remains red while expectations are stale. It runs
`btc-ema-crossover.pine` through the `release-lock.json` digest-pinned runtime
on the committed CSV in both modes: `gridless` uses engine defaults;
`gridded` applies qty_step/mincontract 0.00001, mintick 0.01, pointvalue 1,
type crypto, currency USDT, and basecurrency BTC. The recording refuses an
instrument fallback and extracts the same 11 fields compared by the E2E.

Download artifact `syminfo-expected-trades-<run_id>-<run_attempt>` from the run.
It contains `btcusdt-4h-ema-trades.json` with the new CSV hash and provenance
text, both full engine reports, generated C++, and `provenance.json` with
the source SHA, run identity and runtime lock. Review the reports and JSON,
then copy only the reviewed expected-trades JSON into this directory and
commit it. The workflow never edits repository expectations or pushes changes.
