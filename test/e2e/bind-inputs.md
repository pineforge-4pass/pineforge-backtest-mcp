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
and then a failing engine run whose real trace exits `4` with
`[pineforge] backtest failed` (the private-feed rule under **Fail closed** below).
The readable `022` control must pass on both revisions. The corrected revision
must pass all four tests with real reports.

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

## Live-bind container probe receipt (private-feed only)

The host-account privacy witness above is unchanged. While the real source is live,
the observer also reads the engine's own `/in/ohlcv.csv` bind once from a container
and records that read in its own receipt. The receipt is evidence for the verifier,
not a backtest result. It never enters the engine's trace, stdin, stdout, stderr or
exit status, the harness assertions do not read it, and original main must still fail
the engine's own assertions as the private-feed rule under **Fail closed** describes.
The pass-through of the engine's command is unchanged. The probe is the only Docker
command the observer starts on its own, and it adds one short container run before the
engine starts. It shows only whether the image's default user can read the live bind
with `cat`. It says nothing about why the engine failed or passed: the engine's own
trace, MCP result and TAP remain the only engine evidence.

**Trigger.** The observer is about to start an engine `docker run` that has a `-v`
bind to `/in/ohlcv.csv` while `PF_BIND_CONTROL` is set, which is the existing
private-feed control condition. Only `private-feed` meets it. The transpile call, every
other case and the no-Docker local case never trigger and never get a receipt. Each
triggering invocation, retries included, gets its own probe and its own receipt. A
probe is never repeated, shared between invocations, or rebuilt from a copy after
cleanup.

**Probe.** Before the engine starts, the observer runs the real Docker CLI
(`PF_BIND_REAL_DOCKER`, called directly, so it adds no `docker-*.json`) with exactly
this argv:

```text
$PF_BIND_REAL_DOCKER run --rm --pull=never --network=none --log-driver=none -e LC_ALL=C
  -v <the engine's own -v value for /in/ohlcv.csv, byte for byte>
  --entrypoint cat $PINEFORGE_IMAGE /in/ohlcv.csv
```

The bind is taken from the very argv the engine then runs, so the probe reads the
engine's own live mount. It runs the pinned image digest as the image's default user:
`PINEFORGE_IMAGE` is the `repository@digest` the harness builds from
`release-lock.json`; there is no `--user`, privilege, capability or security option,
no pull and no network. Only this probe disables container logging so Docker does not
persist the CSV. Its stdout remains attached; no daemon setting or engine argv changes.
stdin is `/dev/null`. The one process in the probe container is
`cat /in/ohlcv.csv`, started directly as the entrypoint: no shell, no UID command and
no hash tool runs there. The observer captures the real stdout bytes, the stderr and
the exit status in memory. stderr goes into the receipt as text and is never
forwarded. The stdout bytes are never written to disk, printed or forwarded: the
observer computes their count and their SHA-256 on the host from exactly the captured
bytes and keeps only those two values. The observer runs no probe and marks the receipt
`invalid` unless `PINEFORGE_IMAGE` is a digest reference equal to the last element of
the engine's own argv, the engine's bind is exactly `SOURCE:/in/ohlcv.csv:ro`, and a
fresh `lstat` of `SOURCE` is a regular file equal to the record it took when it parsed
that argv. It waits at most 60 seconds for the probe. The engine then runs unchanged,
whatever the probe found.

**Reader and expected output.** The reader is the pinned release image's own `cat`
(GNU coreutils), started directly as the entrypoint with `/in/ohlcv.csv` as its only
argument. `docker/Dockerfile` describes that image as a Debian/glibc-compatible base
that runs as a non-root user. The C locale gives `cat` its plain glibc diagnostic.
Nothing else runs in the probe container, so it reports neither a uid nor a hash: the
user is the image's default user, which the harness measured on its own as
`engineUid` (see the inputs below), and the hash is the observer's own. No other reader
is substituted: an image without `cat`, or whose `cat` words its denial differently from
GNU `cat`, gives an `invalid` receipt and the proof is refused.

| Revision and bind | Exit | Stdout | Stderr |
| --- | --- | --- | --- |
| Original main: the caller's own `0600` CSV, bound directly | `1` | empty, 0 bytes | `cat: /in/ohlcv.csv: Permission denied` and LF |
| Corrected revision: the staged `0644` copy under a private `0700` parent | `0` | the file's exact bytes, which the observer reduces to a byte count and a SHA-256 | empty |

The observer accepts the original-main denial only for exit `1` (GNU `cat`'s own
failure status), an empty stdout, and a stderr that is exactly the line above, whose
message text it maps to `EACCES` through its own errno table. It accepts the corrected
revision's read only for exit `0`, an empty stderr, a nonzero byte count, and a
SHA-256, computed on the host from the captured stdout bytes, that equals
`source.sha256`, the hash it took of the staged copy when it parsed the engine argv.
Any other exit, stdout or stderr is `invalid`, including a Docker or setup failure,
`ENOENT`, an exit `0` that read no byte, and bytes that do not hash to the staged copy.

**Kit prerequisite (the later R12 kit; neither this harness nor the observer does it).**
Before any proof case runs on the authorized box, the kit runs `command -v cat` once in
the same pinned image as the same default user: the real Docker CLI, the same
`PINEFORGE_IMAGE`, `--pull=never --network=none`, and no `--user`, privilege,
capability or security option. `command -v` is a shell builtin, so this one preflight
uses the image's `sh` as its entrypoint, with `command -v cat` as the `-c` script; the
probe itself runs no shell. The kit records the real exit status and the path the shell
printed. If the exit status is not `0`, the kit stops with that same exit status before
any case starts and never substitutes another reader or another failure. A missing
record, or one with a nonzero exit or no printed path, refuses the proof even when cases
ran. This runbook assumes no probe success or availability: the preflight passing does
not make any receipt valid, and a probe whose `cat` still fails to run is an `invalid`
receipt.

**Receipt.** `live-bind-probe-<token>.json` in the case directory (`private-feed`),
beside its engine trace `docker-<token>.json`, where `<token>` is the random part of
the trace name. The name starts with `live-bind-probe-`, so neither the harness's
`^docker-.*\.json$` trace enumeration nor its `docker-` prefix check can see it. It is
created exclusively as a regular file with mode `0600` after the engine has finished
and its trace is complete, so it can name that trace by its final SHA-256. Schema
`pineforge-bind-live-probe/v2` (it replaces the earlier `v1`, whose reader was a shell
that also printed a uid and a hash):

| Field | Content |
| --- | --- |
| `schema` | `pineforge-bind-live-probe/v2` |
| `trace.name`, `trace.sha256` | The engine trace this receipt belongs to, and the SHA-256 of that file's final bytes |
| `image.pin`, `image.engine` | `PINEFORGE_IMAGE` as the harness exported it, and the last element of the engine's own `docker run` argv |
| `bind` | The engine's own `-v` value for `/in/ohlcv.csv`, byte for byte (`null` unless the argv has exactly one) |
| `source.path`, `source.engine` | The bind source, and the stat the observer recorded for it when it parsed the engine argv (the same record the engine trace keeps under `mounts["/in/ohlcv.csv"].source`) |
| `source.before`, `source.after` | A fresh `lstat` taken immediately before and immediately after the probe |
| `source.sha256` | The observer's own host-side SHA-256 of the source, taken when it parsed the engine argv |
| `probe.argv` | The exact argv that was executed |
| `probe.exit`, `probe.stderr` | The probe's own raw exit status and complete stderr text |
| `probe.stdoutBytes`, `probe.stdoutSha256` | How many bytes the probe wrote to stdout, and the SHA-256 the observer computed on the host from exactly those captured bytes (empty output hashes as empty input). The bytes themselves are never stored |
| `probe.startedNs`, `probe.endedNs` | Wall-clock nanoseconds around the probe |
| `outcome.kind` | `read`, `denied` or `invalid` |
| `outcome.errno` | The errno whose message `cat` printed, found in the observer's own errno table (`EACCES` when `denied`) |
| `outcome.sha256` | The hash of the captured stdout bytes, equal to `probe.stdoutSha256` (`read` only) |
| `outcome.reason` | Why the receipt is `invalid`, otherwise `null` |

The raw `probe.*` fields are the evidence; `outcome` is a convenience the verifier
recomputes. When a probe could not run or could not finish, the `probe.*` fields it never
reached are `null` and `outcome.reason` says why. The receipt has no `probe.stdout`
and no uid field: it never holds CSV bytes, and a receipt with either is not this
schema.

**Association.** One-to-one. Each triggering trace, meaning a `private-feed`
`docker-*.json` that has a `/in/ohlcv.csv` mount and a `privacy` record, has exactly one
receipt with its token, whose `trace.name` is that trace and whose `trace.sha256` is
that file's SHA-256 in the evidence pack listing. Each receipt names exactly one such
trace. Original main has one receipt per engine invocation that bound the caller's
CSV (at least one). The corrected revision has exactly one, because the harness
expects exactly two Docker traces there: the transpile call and the run. Every other
case has none.

**Independent inputs the verifier must check.**

- The pin: `repository@digest` from `release-lock.json` and `image` from `identity.json`.
  Both must equal `image.pin`, `image.engine` and the image element of `probe.argv`.
- The default user: `engineUid` and `imageUser` from `identity.json`, which the harness
  measured on its own before any case (`id -u` in the pinned image, and the image
  configuration's `User`), never from the probe. `engineUid` must be nonzero and differ
  from `host.uid`. The probe argv has no user option, so `cat` ran as that default user.
  The receipt carries no uid because the probe runs no command that could report one.
  The source's owner and mode explain the result: original main's source belongs to
  `host.uid` with mode `0600`, which the default non-root user cannot read, and the
  corrected revision's copy is `0644`.
- The expected bytes: the verifier's own SHA-256 and byte length of
  `test/fixtures/syminfo/btcusdt-4h-2188.csv` from the same checkout as the harness (the
  harness's `csv`). Never copy them from a receipt or a trace.
- The kit's `command -v cat` record (see the kit prerequisite): the real exit `0` and
  the printed path, for the same pinned image and default user, recorded before any case
  ran.
- The engine trace in the evidence pack: its SHA-256 from the pack listing, its argv (the
  bind), its `mounts["/in/ohlcv.csv"].source` and `.sha256`, and its own `exit` and
  `stderr`, which still carry the engine's red or green.
- The revision's real source from that trace: original main binds the caller's own
  `0600` file owned by the host uid, which is not under the staging directory; the
  corrected revision binds a regular `0644` copy under a private `0700` `pineforge-bt-*`
  parent of the per-run staging directory.
- The pack listing: the receipt is a regular `0600` file in the `private-feed` directory,
  smaller than the fixture itself (a receipt that held the CSV could not be). Its mtime
  is not earlier than the trace's, and `probe.endedNs`, in whole seconds, is not later
  than the trace's mtime, because the probe ends before the engine starts.

**Fail closed.** Reject the proof when any of these holds:

- A triggering trace has no receipt, or has more than one.
- A receipt exists in another case, has no triggering trace, or names a trace whose
  name or SHA-256 does not match the pack (missing, extra, stale, late or misbound).
- The receipt is not valid JSON, has another `schema` (the earlier `v1` included), lacks
  a field, has a field the table above does not list (`probe.stdout` in particular), or
  is not a regular `0600` file.
- `outcome.kind` is `invalid`, or differs from what `probe.exit`, `probe.stdoutBytes`,
  `probe.stdoutSha256` and `probe.stderr` literally show when the verifier classifies
  them itself, or those fields hold anything beyond the documented output, in
  particular any CSV bytes.
- Two receipts carry the same probe evidence (the same trace, or the same
  `probe.startedNs` or `probe.endedNs`), which is shared or reused evidence.
- The images are not one and the same pinned `repository@digest`, or `probe.argv` is
  not exactly the argv above (any added or missing option, a shell or any other
  entrypoint, another command or target), or `bind` is not the trace argv's own `-v`
  value ending in `:ro`.
- `source.engine`, `source.before`, `source.after` and the trace's source record differ
  in path, inode, device, owner or mode, or the source is not the revision's real
  source described above.
- `identity.json` lacks `engineUid` or `imageUser`, or `engineUid` is `0` or equals the
  host uid.
- Original main: the receipt is not `denied` with `EACCES`, exit `1`, `probe.stdoutBytes`
  `0` (so `probe.stdoutSha256` is the SHA-256 of empty input) and exactly the stderr
  above. A read that succeeds, a Docker or setup failure (exit `125` to `127` or
  Docker's own error text), a timeout, `ENOENT` or any other exit or output fails it.
  The `0600` mode and the host owner must explain the denial, and the corrected
  revision's `read` by the same reader must show that the reader works.
- Corrected revision: the receipt is not `read` with exit `0`, an empty stderr,
  `probe.stdoutBytes` equal to the verifier's own fixture byte length, and
  `outcome.sha256` equal to `probe.stdoutSha256`, the verifier's own fixture hash and
  `source.sha256`. If attached stdout does not stream with `--log-driver=none`,
  the missing or incomplete bytes fail the head probe and the kit; there is no fallback.
- The kit's `command -v cat` record is missing, shows a nonzero exit or no printed path,
  is not for the same pinned image and default user, or any case ran without it.
- Separation fails: the engine trace's `exit` and `stderr` are not the engine's own, or
  do not tie to the same call's real evidence. On original main the `private-feed`
  run's real engine trace exits `4` and its `stderr` carries
  `[pineforge] backtest failed`; `mcp.json` in the same case directory is that call's
  error result; and TAP records the harness's `match` failure for `private-feed` at
  `test/e2e/bind-inputs.e2e.ts` `230:10`, reached from `261:9`. All three belong to
  one evidence directory (`custody.json` names its case and run). This runbook neither
  requires nor implies `[Errno 13]` in that engine trace: the permission denial comes
  only from the separate live-bind probe, and it can neither replace the engine's own
  error nor be attributed to it. Separation also fails when receipt text appears in the
  trace's `stderr`, or the ordinary trace count, exits or `custody.json` differ from
  what the unchanged harness expects.

## Bind inventory

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
