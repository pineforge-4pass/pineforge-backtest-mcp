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

`vendor/verify_corpus.py` and `vendor/derive_corpus_feeds.py` are byte-identical
to pineforge-engine v1.2.0 (commit 792a6b5b09be0608e616acdc3bb5f64f551e8163)
`scripts/` files. `vendor/run_strategy.py` is byte-identical to the same path
at engine commit b3192bfc2f5a24bf4efd6d1d01e01e8fe619dfed. These are unchanged
upstream copies; `vendor/SHA256SUMS` lists their per-file provenance and hashes:

| file | sha256 |
|---|---|
| verify_corpus.py | 431452ecddc8184937951ddf9a4c5f29029731237301967b5b480800be6fd1a6 |
| run_strategy.py | 36f7cf77e0b6355ce03f5d251c7c414f22be7da81ae4743a769f0527f06904d0 |
| derive_corpus_feeds.py | d2d848d4e8c11f5fa6cc387dc150ab5a2e67ea800a702db4e6a7c1666539d99a |

run_strategy.py imports derive_corpus_feeds.py when it loads; its other
import, pf_release_run.py, is only reached by `--runner docker`, which this
driver does not use.

To re-vendor for a new engine tag:

```
for f in verify_corpus.py run_strategy.py derive_corpus_feeds.py; do
  git -C <pineforge-engine> show <tag>:scripts/$f > parity/vendor/$f
done
(cd parity/vendor && shasum -a 256 verify_corpus.py run_strategy.py derive_corpus_feeds.py)
```

then update `vendor/SHA256SUMS`, `GRADER_SHA256` in `pf_parity.py`, the
pinned hash in `test/parity-core.test.ts`, and re-run the corpus check
(`scripts/parity-corpus/run.py`).

## Tests

- `python3 parity/pf_parity_selftest.py`: request validation and the
  timezone check (no engine needed).
- `scripts/parity-corpus/run.py`: every corpus probe through the driver,
  tiers compared with the published validation report (in the image).
- `scripts/parity-corpus/negative.py`: changed tapes and wrong settings on
  real probes (in the image).
