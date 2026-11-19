# Bind input regression: supervisor runbook

Run on the approved AWS Spot proof box with a local Docker daemon, as the ordinary
host UID that will run MCP. Use a traversable local temp root such as `/tmp`.
The sealed kit provisions `pfobserver` with a fixed, different nonzero UID, no
home, and a nologin shell. It authorizes `sudo -n -u pfobserver` for the observer's
read probe. The observer records the invocation with an absolute Python path and
`-I`. Do not run the harness or MCP as root. Preload the pinned release image.
The harness verifies the local digest and measures the image's default UID with
`id -u`; it rejects a host UID that matches the image UID. Use Python 3, Node
with the repository's test dependencies, and a shared host filesystem for the
observer, the local daemon, and both accounts.

Use **the same harness files** from the corrected checkout for all runs. The
sealed kit ties each installed entrypoint to its exact source commit and built
tarball hash.
Pass the absolute Node binary and installed JavaScript entrypoint as JSON argv.
The stdio transport launches Node directly on `with-umask.mjs`, which applies the
mask in the spawned process before loading that entrypoint. From the candidate
test checkout set:

```sh
export TMPDIR=/tmp
export PF_BIND_REAL_DOCKER=/absolute/path/to/docker
export PF_BIND_OTHER_USER=pfobserver
export PF_BIND_REVISION=2b10595fe5be422d418e6fd3c862b3912c4f78ff
export PF_BIND_EVIDENCE=/absolute/existing/private/evidence/parent
export PF_E2E_SERVER='["/absolute/path/to/node","/absolute/parent/install/node_modules/@pineforge/backtest-mcp/dist/index.js"]'
unset PINEFORGE_PARITY_DIR
node --import tsx --test \
  --test-name-pattern='^(umask-077|umask-027|private-feed|readable-control)$' \
  test/e2e/bind-inputs.e2e.ts
```

Repeat those four cases on the exact corrected revision, with `PF_BIND_REVISION`,
`PF_BIND_EVIDENCE` and `PF_E2E_SERVER` changed to the corrected SHA, a new evidence
directory, and the corrected install. Expect original main (`2b10595f`) to fail
all three negative cases: `077` and `027` fail with `[Errno 13]` opening
`/in/strategy.pine`; `022` with `0600` caller data has a successful transpile
and then `[Errno 13]` opening `/in/ohlcv.csv`. The readable `022` control must
pass on both revisions. The corrected revision must pass all four tests with
real reports.

For the snapshot first-read proof, set `PF_BIND_FOREIGN_FIXTURES` to an absolute
path to a fresh fixture directory on the local filesystem. Provision all its
ancestors as searchable by the MCP user and the fixture directory as `0755`
owned by `pfobserver`; it becomes the server's cwd so path scoping stays on.
Use ordinary files and no extended/default ACLs on the fixture or staging
paths. The kit's provisioning step writes the three files below, assigns them
to `pfobserver` (whose nonzero UID differs from the MCP UID), then sets their
exact modes. The harness and MCP run with ordinary user credentials and no
capabilities; the harness verifies that it can actually read the bytes before
each call. An existing file with the wrong owner, mode, or content fails setup.

| File | Mode | Exact contents (UTF-8, LF, final newline, no BOM) |
| --- | --- | --- |
| `chart.csv` | `0044` | `chart` in the harness: header `timestamp,open,high,low,close,volume`. Three rows, indexed 0–2, with timestamp `1788220800000 + i * 900000`, open/close `100`, high `120` on row index 2 and `101` otherwise, low `99`, volume `15`. |
| `fine.csv` | `0044` | `tvFine` in the harness: header `time,open,high,low,close,Volume`. Forty-five rows, indexed 0–44, with time `1788220800 + i * 60` (epoch seconds), open/close `100`, high `120` on row index 36 and `101` otherwise, low `99`, volume `1`. |
| `fine-readable.csv` | `0644` | Byte-identical to `fine.csv`; an owner-readable magnifier control lets the chart case reach the chart's first read. |

Set `PF_BIND_REVISION`, `PF_BIND_EVIDENCE`, and `PF_E2E_SERVER` for the blocked
candidate `c343c23e5b1cf5d1740631badffbdd804ded5203`, then repeat with the exact
corrected SHA and install. Use a fresh evidence directory for each run:

```sh
node --import tsx --test --test-name-pattern='^parity-foreign-(chart|magnifier)$' \
  test/e2e/bind-inputs.e2e.ts
```

The blocked candidate must fail both tests with MCP `internal` / Node `EACCES`
opening a fresh `pineforge-pt-*` snapshot: `ohlcv-input.csv` for the chart
case and `magnifier_ohlcv-input.csv` for the magnifier case (which also
supplies the restricted chart). These failures happen before Docker; the
harness records `snapshot-first-read.json` only for that signature, and the
tests remain red. These are separate from original-main Docker `[Errno 13]`
failures. On the corrected revision both calls must produce real MCP parity
reports, attest to the converted magnifier digest in the grader, and have one
successful Docker trace with the expected digests of both read-only files
behind a live private `0700` parent. `original-read.json` and `custody.json`
record preflight reads, unchanged originals, and staging cleanup.

Run the whole file on the corrected revision too, with a **new** evidence directory.
For the no-Docker control set `PF_BIND_LOCAL_SERVER` to JSON argv for
`/absolute/path/to/node /absolute/corrected/install/node_modules/@pineforge/backtest-mcp/dist/index.local.js`
on a runner with the matching release's real engine prefix and bundled codegen
installed (set `PINEFORGE_PREFIX` if needed). This case runs on the host with the
same UID, `077`, and private data. The observer records a failure if the local
entrypoint invokes Docker. The fetched parity case uses the same live Binance
witness as `parity-magnifier.e2e.ts`; supply its `PF_E2E_CORPUS`,
`PF_E2E_FEED_15M`, and `PF_E2E_FEED_1M` and allow the runner to reach Binance.
Unmet prerequisites are unrun coverage, not passes.

Keep the TAP output and the matching evidence directory. `identity.json` records
the supplied revision label and configured entrypoint, inspected image digest
and ID, and observed UIDs. The revision label is reporting metadata; the kit
supplies the commit and tarball evidence. Each case records stdio results
(`mcp*.json`), Docker CLI arguments, exit and stderr (`docker-*.json`), and
original identities, hashes and modes and staging cleanup (`custody.json`).
Docker observation passes through the exact command. In the deliberate digest
refusal case only, it changes the disposable staged C++ after the server hashes
it, then records the real image's exact refusal.

The privacy pair records a stat of the actual live bind source before and after a
real open under the alternate UID. That open must get `EACCES`, while the very same
probe must read the disposable public control and report its hash. The original
private CSV remains unchanged. The normal, differently owned engine must read the
staged bind and produce a report with the sidecar's provenance and a live lot grid.
Parity keeps the host UID and checks both CSVs as read-only staged binds plus the
unchanged private writable jail. No parity permission failure is expected on the
corrected revision.

| Input or scratch | Container target | Mount |
| --- | --- | --- |
| Package-written Pine | `/in/strategy.pine` | Read-only file |
| Generated C++ for single and grid runs | `/in/strategy.cpp` | Read-only file |
| Caller CSV copy for single and grid runs | `/in/ohlcv.csv` | Read-only file |
| Instrument overlay child, with shim and config; ancestor stays on host | `/opt/pineforge-overlay` | Read-only directory |
| Parity chart and optional magnifier; caller, inline, converted, or fetched | `/in/ohlcv.csv`, `/in/magnifier.csv` | Read-only files |
| Installed parity core | `/opt/pf-parity` | Read-only directory |
| Same-UID parity scratch; request comes over stdin | `/jail` (includes `/jail/work`) | Writable directory |
| Local runner scratch, report outputs, downloaded caller CSV outputs, instrument sidecars | None | No direct bind |
