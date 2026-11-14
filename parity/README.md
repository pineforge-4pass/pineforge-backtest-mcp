# parity: the grading core of check_tradingview_parity

`pf_parity.py` grades a TradingView "List of trades" export against PineForge's
run of the same Pine script, with the grader behind the published corpus
figures. It runs inside the pineforge-release image (python3 3.11, g++, the
engine under `$PINEFORGE_PREFIX`), stdlib only.

```
python3 parity/pf_parity.py < request.json > response.json
```

One JSON request on stdin, one JSON response on stdout. Exit 0 for every
answer, user errors included (`{"ok": false, "error": "<kind>", "message": "..."}`);
non-zero only when the driver itself fails.

## What a run does

1. Checks the request: the trade list's columns and rows, the chart timezone
   (an IANA name the grader reads with the same UTC offsets as the timezone
   database), Pine input names the harness reads itself (refused), trades
   before the range start, bars inside the range.
2. Lays out a temporary folder: `strategy.pine`, `tv_trades.csv`,
   `inputs.json`, and `metrics.json` when a range end is given.
3. Transpiles and compiles the script exactly as the release `entrypoint.sh`
   does (bundled codegen; `g++ -std=c++17 -O2 -ffp-contract=off -fPIC -shared
   ... -Wl,--whole-archive libpineforge.a`).
4. Runs `vendor/run_strategy.py` (ctypes runner) in a subprocess with its own
   process group, a timeout (`PF_PARITY_TIMEOUT_MS`, default 600000) and
   capped output. This is the corpus gate's harness: it windows the run on the
   TradingView tape (first computed bar, TV's range end, the entry window).
5. Grades with `vendor/verify_corpus.py` `analyze_strategy()`, lists the
   mismatches by replaying the grader's own pairing functions, checks the
   timezone, and deletes the folder.

Request fields: `pine`, `tradingview_trades_csv`, `chart_timezone`,
`timeframe`, `range_start_ms`, `range_end_ms` (null: the tape's last row),
`inputs`, `strategy_overrides`, `runtime` (`input_tf`, `script_tf`,
`bar_magnifier`, `magnifier_samples`, `magnifier_dist`), `ohlcv_csv_path`
(`timestamp,open,high,low,close,volume`, epoch ms), `magnifier_ohlcv_csv_path`,
`max_mismatches` (default 10, max 50), `workdir`. `meta_passthrough` is for the
corpus test only: a probe's whole inputs.json used as is; the MCP tools never
send it.

## What a runner must do

The driver's children (the transpile step, g++ and its compilers, the harness
with the user's `.so` loaded in it) each run in their own session, so the
driver can kill each one's whole subtree. The driver kills and reaps them when
it gets SIGTERM, SIGINT or SIGHUP, and on every exit path; on Linux each child
also gets SIGKILL if the driver dies without doing that (`PR_SET_PDEATHSIG`),
and the driver gets SIGTERM if the process that started it dies.
`pf_parity_killtest.py` checks all three in the release image.

A runner (the local MCP's LocalRunner, the hosted container's `/parity` route)
must:

1. Start `python3 pf_parity.py` in its own process group (Node:
   `spawn(..., { detached: true })`), the request on stdin, and read stdout
   until the process closes. Its own working folder goes in `workdir`.
2. Set `PF_PARITY_TIMEOUT_MS` (the driver's deadline) at least 15 s before
   the runner's stop. At the stop, send SIGTERM to the driver's process group,
   then SIGKILL to the group if it has not exited 5 s later. SIGKILL first
   would leave the driver no chance to kill its children (the Linux backstop
   still takes the direct children, not their descendants). The hosted
   container uses a 40 s deadline, SIGTERM at 55 s and SIGKILL at 60 s; the
   local MCP stops the driver 30 s after `PINEFORGE_PARITY_TIMEOUT_MS`.
3. Mark the request: give the driver an environment value unique to the
   request (`PF_PARITY_REQUEST=<id>`, inherited by every descendant; each child
   also starts in the request's folder). Once the driver has exited, by any
   signal or none, kill every process that carries the value or works in the
   folder, until none is left. This takes compiler grandchildren a SIGKILLed
   driver could not.
4. Treat exit 0 as an answer (`ok` true or false) and anything else as an
   internal failure; after a stop, answer `timeout` itself.
5. Remove `workdir` after the driver has closed and the request is swept, not
   before.

Under Docker the container is the boundary instead: `docker kill` on the
container ends every process in it (the DockerRunner does this past the
timeout).

## Vendored files

The `pineforge-release` dispatch calls `scripts/release-consumer.mjs receive`.
For releases with the engine parity contract (1.11.0 onward), that receiver
downloads the hub manifest, verifies the artifacts and engine tag/commit, then
fetches `scripts/<name>` from that immutable engine commit on GitHub. It checks
each byte against `versions.engine.parity.payload_sha256` in the verified
release manifest. It never fetches engine main.

The six-file contract is `derive_corpus_feeds.py`, `parity_paths.py`,
`pf_release_run.py`, `run_parity_jailed.py`, `run_strategy.py`, and
`verify_corpus.py`. All six must verify before any vendor file is written.
The receiver also generates `vendor/SHA256SUMS`, this source statement, and
the driver's grader hash/source. The local driver still imports the grader
and harness from `parity/vendor`; the harness imports the feed derivation.
The other three files travel with the release payload even though the offline
driver does not directly invoke their entry points.

<!-- parity-source:start -->
Refresh pending: this checkout still has the historical three-file set.
`verify_corpus.py` and `derive_corpus_feeds.py` came from engine v1.2.0 commit
`792a6b5b09be0608e616acdc3bb5f64f551e8163`; `run_strategy.py` came from commit
`b3192bfc2f5a24bf4efd6d1d01e01e8fe619dfed`. These bytes have not been
verified as the 1.12.0 payload. `vendor/SHA256SUMS` records their exact hashes.
<!-- parity-source:end -->

The complete local `vendor` inventory is exactly the six payload files plus
`SHA256SUMS`; extra entries (including directories or symlinks) are rejected.
The driver and this README remain outside `vendor`. Verification compares the
installed driver's grader hash/source assignments and the exact README source
block with values derived from the validated release lock, including the engine
tag/commit and release manifest hash. The committed release lock/manifest bind
the payload hashes to the engine release. This receiver reproduces
the engine descriptor and engine sums hashes through `validateReady`; no offline
consumer requires a local `PARITY-MANIFEST.json`, so no duplicate is installed.

Missing bytes fail with `PARITY_PAYLOAD_MISSING`; changed bytes fail with
`PARITY_DIGEST_MISMATCH`. Fetch failures, malformed manifests (including missing
hashes), inconsistent manifest/sums, and invalid provenance fail with
`PARITY_FETCH_FAILED`, `PARITY_MANIFEST_INVALID`,
`PARITY_MANIFEST_SUMS_MISMATCH`, and `PARITY_PROVENANCE_INVALID`.
Extra or non-file vendor entries fail with `PARITY_INVENTORY_INVALID`;
missing inventory members fail with `PARITY_PAYLOAD_MISSING`.
Altered installed provenance fails with `PARITY_PROVENANCE_INVALID`.
Every failure exits nonzero; previous bytes never authorize the failed update.
Both the source-artifact release check and runtime E2E verify the local inventory
before they proceed. Historical events before 1.11.0 retain their existing path.

For a proof checkout with its ready lock and matching manifest already pinned:

```
node scripts/release-parity.mjs update
node scripts/release-parity.mjs verify
```

These invoke the same updater used by the receiver, without creating a release
PR. Run the tests and release-image corpus checks on the designated proof host.

## Tests

- `python3 parity/pf_parity_selftest.py`: request validation and the
  timezone check (no engine needed).
- `scripts/parity-corpus/run.py`: every corpus probe through the driver,
  tiers compared with the published validation report (in the image).
- `scripts/parity-corpus/negative.py`: changed tapes and wrong settings on
  real probes (in the image).
