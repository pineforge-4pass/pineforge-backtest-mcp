// The instrument's prefix overlay and both runners: the overlay's structure and
// cleanup, the docker arguments, the environment the local runner gives the
// entrypoint. DockerRunner runs against a fake `docker` first on PATH; LocalRunner
// against a fake prefix whose entrypoint reports what it sees.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DockerRunner, LocalRunner, dockerBacktestArgs } from "../src/engine.js";
import {
  IMAGE_LAYOUT, IMAGE_PREFIX, OVERLAY_MOUNT, SKIP_REASONS, createOverlay, layoutOf, mentionsOverlay, overlayEnv, overlayFs,
  overlayUnavailable, shimPath, skippedWarning, tryOverlay,
} from "../src/overlay.js";
import { INSTRUMENT_SCHEMA, type Instrument } from "../src/instrument.js";

const PREFIX = resolve("test/fixtures/fake-prefix-overlay");
const BTC: Instrument = {
  schema: INSTRUMENT_SCHEMA, resolved: true, qty_step: 0.00001, mincontract: 0.00001, mintick: 0.01, pointvalue: 1,
  type: "crypto", currency: "USDT", basecurrency: "BTC",
  source: { kind: "tradingview", market: "spot", symbol: "BTCUSDT" },
};

// A private TMPDIR, so the overlays a test sees are its own.
let workRoot: string;
let savedTmp: string | undefined;
let savedPath: string | undefined;
const overlays = () => readdirSync(workRoot).filter((n) => n.startsWith("pineforge-overlay-"));

before(() => {
  workRoot = mkdtempSync(join(tmpdir(), "pf-overlay-test-"));
  savedTmp = process.env.TMPDIR;
  savedPath = process.env.PATH;
  process.env.TMPDIR = workRoot;
});
after(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  process.env.PATH = savedPath;
  rmSync(workRoot, { recursive: true, force: true });
});

// ─── overlay ──────────────────────────────────────────────────────────────

test("layoutOf lists a prefix's top level and its bin/", async () => {
  const layout = await layoutOf(PREFIX);
  assert.deepEqual([...layout.top].sort(), ["include", "lib", "pycodegen"]);
  assert.deepEqual([...layout.bin].sort(), ["entrypoint.sh", "run_json.py"]);
});

test("the overlay mirrors the prefix, except bin/run_json.py (the shim) and instrument.json", async () => {
  const layout = await layoutOf(PREFIX);
  // permissions must not depend on the caller's umask: a container user reads the overlay
  const umask = process.umask(0o077);
  let overlay: Awaited<ReturnType<typeof createOverlay>>;
  try {
    overlay = await createOverlay(BTC, PREFIX, layout);
  } finally {
    process.umask(umask);
  }
  try {
    assert.deepEqual(readdirSync(overlay.dir).sort(), ["bin", "include", "instrument.json", "lib", "pycodegen"]);
    for (const name of ["include", "lib", "pycodegen"]) {
      assert.equal(lstatSync(join(overlay.dir, name)).isSymbolicLink(), true, name);
      assert.equal(readlinkSync(join(overlay.dir, name)), join(PREFIX, name));
    }
    assert.equal(lstatSync(join(overlay.dir, "bin", "entrypoint.sh")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(overlay.dir, "bin", "entrypoint.sh")), join(PREFIX, "bin", "entrypoint.sh"));
    const runJson = join(overlay.dir, "bin", "run_json.py");
    assert.equal(lstatSync(runJson).isSymbolicLink(), false);
    assert.equal(readFileSync(runJson, "utf8"), readFileSync(shimPath(), "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(join(overlay.dir, "instrument.json"), "utf8")), BTC);
    // a container user other than the owner has to read it
    assert.equal(lstatSync(overlay.dir).mode & 0o755, 0o755);
    assert.equal(lstatSync(join(overlay.dir, "bin")).mode & 0o755, 0o755);
    assert.equal(lstatSync(runJson).mode & 0o644, 0o644);
    assert.equal(lstatSync(join(overlay.dir, "instrument.json")).mode & 0o644, 0o644);
  } finally {
    await overlay.cleanup();
  }
  assert.equal(existsSync(overlay.dir), false);
  assert.deepEqual(overlays(), []);
});

test("the image's layout: include, lib, pycodegen and bin/entrypoint.sh, targets inside the image", async () => {
  const overlay = await createOverlay(BTC, IMAGE_PREFIX, IMAGE_LAYOUT);
  try {
    assert.equal(readlinkSync(join(overlay.dir, "lib")), "/opt/pineforge/lib");
    assert.equal(readlinkSync(join(overlay.dir, "include")), "/opt/pineforge/include");
    assert.equal(readlinkSync(join(overlay.dir, "bin", "entrypoint.sh")), "/opt/pineforge/bin/entrypoint.sh");
    assert.deepEqual(readdirSync(join(overlay.dir, "bin")).sort(), ["entrypoint.sh", "run_json.py"]);
  } finally {
    await overlay.cleanup();
  }
});

test("a failing build leaves no overlay behind", async () => {
  await assert.rejects(createOverlay(BTC, PREFIX, { top: ["lib", "lib"], bin: [] }), /EEXIST/);
  assert.deepEqual(overlays(), []);
});

test("overlayEnv points the entrypoint at the overlay and the shim at the real prefix", () => {
  assert.deepEqual(overlayEnv("/ov", "/opt/pineforge"), {
    PINEFORGE_PREFIX: "/ov", PINEFORGE_SYMINFO: "/ov/instrument.json", REAL_PREFIX: "/opt/pineforge",
  });
});

// ─── docker arguments ─────────────────────────────────────────────────────

const base = { image: "img:1", cppPath: "/t/strategy.cpp", csvPath: "/t/bars.csv" };

test("docker arguments without an instrument are the ones they always were", () => {
  assert.deepEqual(dockerBacktestArgs({ ...base, inputs: { a: 1 }, runtime: { input_tf: "240" } }), [
    "run", "--rm", "--network=none",
    "-e", 'PINEFORGE_INPUTS={"a":"1"}',
    "-e", "PINEFORGE_INPUT_TF=240",
    "-v", "/t/strategy.cpp:/in/strategy.cpp:ro",
    "-v", "/t/bars.csv:/in/ohlcv.csv:ro",
    "img:1",
  ]);
});

test("docker arguments with an overlay mount it read-only and point the entrypoint at it", () => {
  const args = dockerBacktestArgs({ ...base, instrument: BTC }, "/tmp/pineforge-overlay-x");
  const pairs = args.flatMap((a, i) => (a === "-v" || a === "-e" ? [`${a} ${args[i + 1]}`] : []));
  assert.deepEqual(pairs, [
    `-v /tmp/pineforge-overlay-x:${OVERLAY_MOUNT}:ro`,
    `-e PINEFORGE_PREFIX=${OVERLAY_MOUNT}`,
    `-e PINEFORGE_SYMINFO=${OVERLAY_MOUNT}/instrument.json`,
    "-e REAL_PREFIX=/opt/pineforge",
    "-v /t/strategy.cpp:/in/strategy.cpp:ro",
    "-v /t/bars.csv:/in/ohlcv.csv:ro",
  ]);
  assert.equal(args.at(-1), "img:1");
  assert.ok(args.includes("--network=none"));
});

// ─── DockerRunner against a fake docker ───────────────────────────────────

function fakeDocker(body: string): string {
  const bin = mkdtempSync(join(workRoot, "bin-"));
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  return bin;
}

// Reports its argv, and what the overlay mounted at /opt/pineforge-overlay holds while it runs.
const DOCKER_REPORTS = `
set -euo pipefail
args=("$@")
host=""
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[i]}" in -v) v="\${args[i+1]}"; case "$v" in *:/opt/pineforge-overlay:ro) host="\${v%%:*}";; esac;; esac
done
python3 - "$host" "$@" <<'PY'
import json, os, sys
host, argv = sys.argv[1], sys.argv[2:]
out = {"argv": argv, "overlay_host": host or None}
if host:
    out["entries"] = sorted(os.listdir(host))
    out["lib_link"] = os.readlink(os.path.join(host, "lib"))
    out["shim_is_file"] = os.path.isfile(os.path.join(host, "bin", "run_json.py")) and not os.path.islink(os.path.join(host, "bin", "run_json.py"))
    out["instrument"] = json.load(open(os.path.join(host, "instrument.json")))
    out["mode"] = oct(os.stat(host).st_mode & 0o777)
print(json.dumps(out))
PY
`;

test("DockerRunner.backtest with an instrument: overlay present during the run, gone after", async () => {
  fakeDocker(DOCKER_REPORTS);
  const dir = mkdtempSync(join(workRoot, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "timestamp,open,high,low,close,volume\n");
  const out = await new DockerRunner("img:9").backtest({
    cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv"), instrument: BTC,
  }) as { argv: string[]; overlay_host: string; entries: string[]; lib_link: string; shim_is_file: boolean; instrument: Instrument; mode: string };
  assert.ok(out.overlay_host.startsWith(workRoot), "the overlay is under the OS temp dir");
  assert.deepEqual(out.entries, ["bin", "include", "instrument.json", "lib", "pycodegen"]);
  assert.equal(out.lib_link, "/opt/pineforge/lib");
  assert.equal(out.shim_is_file, true);
  assert.deepEqual(out.instrument, BTC);
  assert.equal(out.mode, "0o755");
  assert.equal(out.argv.at(-1), "img:9");
  assert.ok(out.argv.includes(`PINEFORGE_PREFIX=${OVERLAY_MOUNT}`));
  assert.equal(existsSync(out.overlay_host), false);
  assert.deepEqual(overlays(), []);
});

test("DockerRunner.backtest without an instrument mounts no overlay", async () => {
  fakeDocker(DOCKER_REPORTS);
  const dir = mkdtempSync(join(workRoot, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "x\n");
  const out = await new DockerRunner("img:9").backtest({ cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv") }) as
    { argv: string[]; overlay_host: string | null };
  assert.equal(out.overlay_host, null);
  assert.ok(!out.argv.some((a) => a.startsWith("PINEFORGE_PREFIX") || a.startsWith("PINEFORGE_SYMINFO")));
});

test("a docker failure surfaces its stderr and still removes the overlay", async () => {
  fakeDocker('echo "[pineforge] cannot apply the instrument grid: run_json.py lacks main" >&2; exit 4');
  const dir = mkdtempSync(join(workRoot, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "x\n");
  await assert.rejects(
    new DockerRunner("img:9").backtest({ cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv"), instrument: BTC }),
    /docker exited 4[\s\S]*cannot apply the instrument grid/,
  );
  assert.deepEqual(overlays(), []);
});

// ─── LocalRunner against a fake prefix ────────────────────────────────────

interface Seen {
  prefix: string; syminfo_path: string; real_prefix: string | null; lib_resolves: boolean; include_resolves: boolean;
  run_json_is_link: boolean; run_json_head: string | null; entries: string[]; bin_entries: string[];
  instrument: Instrument | null; inputs: string | null;
}

async function localRun(call: { instrument?: Instrument; inputs?: Record<string, string>; notices?: string[] }, prefix = PREFIX): Promise<Seen> {
  const dir = mkdtempSync(join(workRoot, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "timestamp,open,high,low,close,volume\n");
  return await new LocalRunner(prefix).backtest({ cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv"), ...call }) as Seen;
}

test("LocalRunner.backtest with an instrument runs the entrypoint on an overlay of its prefix", async () => {
  const seen = await localRun({ instrument: BTC, inputs: { "Fast Length": "8" } });
  assert.ok(seen.prefix.startsWith(workRoot) && seen.prefix.includes("pineforge-overlay-"), seen.prefix);
  assert.equal(seen.syminfo_path, `${seen.prefix}/instrument.json`);
  assert.equal(seen.real_prefix, PREFIX);
  assert.equal(seen.lib_resolves, true);
  assert.equal(seen.include_resolves, true);
  assert.equal(seen.run_json_is_link, false);
  assert.equal(seen.run_json_head, readFileSync(shimPath(), "utf8").split("\n")[0]);
  assert.deepEqual(seen.entries, ["bin", "include", "instrument.json", "lib", "pycodegen"]);
  assert.deepEqual(seen.bin_entries, ["entrypoint.sh", "run_json.py"]);
  assert.deepEqual(seen.instrument, BTC);
  assert.equal(seen.inputs, '{"Fast Length":"8"}');
  assert.deepEqual(overlays(), []);
});

test("LocalRunner.backtest without an instrument runs on the prefix itself", async () => {
  const seen = await localRun({});
  assert.equal(seen.prefix, PREFIX);
  assert.equal(seen.syminfo_path, "");
  assert.equal(seen.real_prefix, null);
  assert.equal(seen.instrument, null);
  assert.equal(seen.run_json_head, "#!/usr/bin/env python3");
});

test("an unresolved instrument with nothing to apply gets no overlay: the run is the prefix's own", async () => {
  const unresolved: Instrument = { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "no symbol, syminfo or sidecar was given" };
  const notices: string[] = [];
  const seen = await localRun({ instrument: unresolved, notices });
  assert.equal(seen.prefix, PREFIX);
  assert.equal(seen.syminfo_path, "");
  assert.equal(seen.instrument, null);
  assert.deepEqual(notices, [], "nothing went wrong: there was nothing to apply");
  assert.deepEqual(overlays(), []);
});

test("an unresolved instrument that still holds a tick goes through the overlay, so the report can say so", async () => {
  const partial: Instrument = { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "no lot size", mintick: 0.5 };
  const seen = await localRun({ instrument: partial });
  assert.deepEqual(seen.instrument, partial);
  assert.ok(seen.prefix.includes("pineforge-overlay-"));
});

test("a relative prefix is linked by its absolute path", async () => {
  const seen = await localRun({ instrument: BTC }, "test/fixtures/fake-prefix-overlay");
  assert.equal(seen.real_prefix, PREFIX);
  assert.equal(seen.lib_resolves, true);
});

test("concurrent local runs each get their own overlay", async () => {
  const other: Instrument = { ...BTC, qty_step: 0.1, mincontract: 0.1, currency: "EUR" };
  const [a, b] = await Promise.all([localRun({ instrument: BTC }), localRun({ instrument: other })]);
  assert.notEqual(a.prefix, b.prefix);
  assert.equal(a.instrument!.currency, "USDT");
  assert.equal(b.instrument!.currency, "EUR");
  assert.deepEqual(overlays(), []);
});

test("a local backtest failure removes its overlay", async () => {
  const broken = mkdtempSync(join(workRoot, "broken-prefix-"));
  mkdirSync(join(broken, "bin"));
  mkdirSync(join(broken, "lib"));
  writeFileSync(join(broken, "bin", "entrypoint.sh"), '#!/usr/bin/env bash\necho "boom" >&2\nexit 4\n');
  await assert.rejects(localRun({ instrument: BTC }, broken), /engine backtest failure \(exit 4\)[\s\S]*boom/);
  assert.deepEqual(overlays(), []);
});

// ─── a run never depends on its overlay ───────────────────────────────────

const NOTHING_TO_APPLY: Instrument = { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "no symbol, syminfo or sidecar was given" };
const BUILD_NOTICE = "the instrument could not be applied (the overlay of the engine prefix could not be built); the engine ran with its defaults";
const RUN_NOTICE = "the instrument could not be applied (the engine image could not use the overlay); the engine ran with its defaults";
const PLATFORM_NOTICE = "the instrument could not be applied (this platform cannot link the engine prefix); the engine ran with its defaults";

async function onPlatform<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

async function withFailingSymlink<T>(fn: () => Promise<T>): Promise<T> {
  const saved = overlayFs.symlink;
  overlayFs.symlink = async () => { throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" }); };
  try {
    return await fn();
  } finally {
    overlayFs.symlink = saved;
  }
}

function dockerInputs() {
  const dir = mkdtempSync(join(workRoot, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "timestamp,open,high,low,close,volume\n");
  return { cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv") };
}

test("the fixed texts, and when a failed run's stderr names the overlay", () => {
  assert.equal(skippedWarning(SKIP_REASONS.build), BUILD_NOTICE);
  assert.equal(skippedWarning(SKIP_REASONS.run), RUN_NOTICE);
  assert.equal(skippedWarning(SKIP_REASONS.platform), PLATFORM_NOTICE);
  assert.equal(overlayUnavailable("win32"), SKIP_REASONS.platform);
  for (const p of ["linux", "darwin", "freebsd"] as const) assert.equal(overlayUnavailable(p), undefined, p);
  const dir = "/var/folders/ab/pineforge-overlay-XyZ123";
  assert.equal(mentionsOverlay("g++: /opt/pineforge-overlay/include/pineforge/engine.hpp: No such file", dir), true);
  assert.equal(mentionsOverlay(`Mounts denied: The path ${dir} is not shared from the host`, dir), true);
  assert.equal(mentionsOverlay("strategy.cpp:3:1: error: expected ';'", dir), false);
  assert.equal(mentionsOverlay("/opt/pineforge/bin/run_json.py: not found", dir), false, "the real prefix is not the overlay");
  assert.equal(mentionsOverlay("anything", ""), false);
});

test("tryOverlay: none without an instrument or with nothing to apply; one for a tick alone; none (with a notice) when it fails", async () => {
  const notices: string[] = [];
  assert.equal(await tryOverlay(undefined, PREFIX, IMAGE_LAYOUT, notices), undefined);
  assert.equal(await tryOverlay(NOTHING_TO_APPLY, PREFIX, IMAGE_LAYOUT, notices), undefined);
  assert.deepEqual(notices, []);
  const tick = await tryOverlay({ ...NOTHING_TO_APPLY, mintick: 0.5 }, PREFIX, IMAGE_LAYOUT, notices);
  assert.ok(tick);
  await tick!.cleanup();
  const failed = await withFailingSymlink(() => tryOverlay(BTC, PREFIX, IMAGE_LAYOUT, notices));
  assert.equal(failed, undefined);
  assert.deepEqual(notices, [BUILD_NOTICE]);
  const brokenLayout = await tryOverlay(BTC, PREFIX, async () => { throw new Error("cannot list the prefix"); }, notices);
  assert.equal(brokenLayout, undefined);
  assert.deepEqual(notices, [BUILD_NOTICE, BUILD_NOTICE]);
  assert.deepEqual(overlays(), []);
});

test("nothing to apply: the docker run has no overlay mount and no PINEFORGE_PREFIX; local runs the prefix itself", async () => {
  fakeDocker(DOCKER_REPORTS);
  const notices: string[] = [];
  const out = await new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: NOTHING_TO_APPLY, notices }) as { argv: string[]; overlay_host: string | null };
  assert.equal(out.overlay_host, null);
  assert.ok(!out.argv.some((a) => a.startsWith("PINEFORGE_PREFIX") || a.startsWith("PINEFORGE_SYMINFO") || a.includes(OVERLAY_MOUNT)));
  assert.deepEqual(notices, []);
  assert.deepEqual(overlays(), []);
});

test("a host that cannot link the prefix (win32): both runners go ahead without the instrument and say so", async () => {
  fakeDocker(DOCKER_REPORTS);
  await onPlatform("win32", async () => {
    const dockerNotices: string[] = [];
    const out = await new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: BTC, notices: dockerNotices }) as { overlay_host: string | null };
    assert.equal(out.overlay_host, null);
    assert.deepEqual(dockerNotices, [PLATFORM_NOTICE]);
    const localNotices: string[] = [];
    const seen = await localRun({ instrument: BTC, notices: localNotices });
    assert.equal(seen.prefix, PREFIX);
    assert.equal(seen.instrument, null);
    assert.deepEqual(localNotices, [PLATFORM_NOTICE]);
  });
  assert.deepEqual(overlays(), []);
});

test("an overlay that cannot be built (a failing symlink): both runners go ahead without the instrument and say so", async () => {
  fakeDocker(DOCKER_REPORTS);
  await withFailingSymlink(async () => {
    const dockerNotices: string[] = [];
    const out = await new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: BTC, notices: dockerNotices }) as { overlay_host: string | null; argv: string[] };
    assert.equal(out.overlay_host, null);
    assert.ok(!out.argv.some((a) => a.includes(OVERLAY_MOUNT)));
    assert.deepEqual(dockerNotices, [BUILD_NOTICE]);
    const localNotices: string[] = [];
    const seen = await localRun({ instrument: BTC, notices: localNotices });
    assert.equal(seen.prefix, PREFIX);
    assert.equal(seen.instrument, null);
    assert.deepEqual(localNotices, [BUILD_NOTICE]);
  });
  assert.deepEqual(overlays(), [], "the half-built overlays are gone");
});

// A docker that fails when the overlay is mounted (with FAKE_DOCKER_STDERR, or Docker Desktop's mount refusal naming the folder).
const DOCKER_FAILS_WITH_OVERLAY = `
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *:/opt/pineforge-overlay:ro*)
    if [ "\${FAKE_DOCKER_HOST_PATH:-}" = 1 ]; then
      for a in "$@"; do case "$a" in *:/opt/pineforge-overlay:ro) dir="\${a%%:/opt/pineforge-overlay:ro}";; esac; done
      echo "docker: Error response from daemon: Mounts denied: The path $dir is not shared from the host" >&2
    else
      echo "$FAKE_DOCKER_STDERR" >&2
    fi
    exit "\${FAKE_DOCKER_EXIT:-125}";;
esac
if [ "\${FAKE_DOCKER_SECOND_FAILS:-}" = 1 ]; then echo "$FAKE_DOCKER_SECOND_STDERR" >&2; exit 4; fi
echo '{"ok":true,"without_overlay":true}'
`;

function dockerLog(): string[] {
  return readFileSync(process.env.FAKE_DOCKER_LOG!, "utf8").split("\n").filter(Boolean);
}

function dockerEnv(env: Record<string, string>) {
  const log = join(workRoot, `docker-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  for (const k of ["FAKE_DOCKER_HOST_PATH", "FAKE_DOCKER_STDERR", "FAKE_DOCKER_EXIT", "FAKE_DOCKER_SECOND_FAILS", "FAKE_DOCKER_SECOND_STDERR"]) delete process.env[k];
  Object.assign(process.env, { FAKE_DOCKER_LOG: log, ...env });
}

test("a run that fails naming the overlay is run once more without it, and says so", async () => {
  fakeDocker(DOCKER_FAILS_WITH_OVERLAY);
  dockerEnv({ FAKE_DOCKER_STDERR: "[pineforge] /opt/pineforge-overlay/bin/new_tool: No such file or directory" });
  const notices: string[] = [];
  const out = await new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: BTC, notices });
  assert.deepEqual(out, { ok: true, without_overlay: true });
  const log = dockerLog();
  assert.equal(log.length, 2, "exactly one retry");
  assert.ok(log[0]!.includes(":/opt/pineforge-overlay:ro") && log[0]!.includes("PINEFORGE_PREFIX=/opt/pineforge-overlay"));
  assert.ok(!log[1]!.includes("pineforge-overlay") && !log[1]!.includes("PINEFORGE_PREFIX"), log[1]);
  assert.deepEqual(notices, [RUN_NOTICE]);
  assert.deepEqual(overlays(), []);
});

test("a mount the container cannot see (the folder is named, not the mount path) is retried too", async () => {
  fakeDocker(DOCKER_FAILS_WITH_OVERLAY);
  dockerEnv({ FAKE_DOCKER_HOST_PATH: "1" });
  const notices: string[] = [];
  const out = await new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: BTC, notices });
  assert.deepEqual(out, { ok: true, without_overlay: true });
  assert.equal(dockerLog().length, 2);
  assert.deepEqual(notices, [RUN_NOTICE]);
  assert.deepEqual(overlays(), []);
});

test("a failure that does not name the overlay is the run's own: no retry, the error is its stderr, no notice", async () => {
  fakeDocker(DOCKER_FAILS_WITH_OVERLAY);
  dockerEnv({ FAKE_DOCKER_STDERR: "/tmp/tmp.abc/strategy.cpp:3:1: error: expected ';' before '}' token", FAKE_DOCKER_EXIT: "3" });
  const notices: string[] = [];
  await assert.rejects(
    new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: BTC, notices }),
    /docker exited 3[\s\S]*strategy\.cpp:3:1: error/,
  );
  assert.equal(dockerLog().length, 1, "not retried");
  assert.deepEqual(notices, []);
  assert.deepEqual(overlays(), []);
});

test("when the retry fails too, its error is the one raised, and there is no third run", async () => {
  fakeDocker(DOCKER_FAILS_WITH_OVERLAY);
  dockerEnv({
    FAKE_DOCKER_STDERR: "/opt/pineforge-overlay/bin/new_tool: not found",
    FAKE_DOCKER_SECOND_FAILS: "1",
    FAKE_DOCKER_SECOND_STDERR: "second run: /opt/pineforge-overlay is mentioned but the overlay is gone",
  });
  await assert.rejects(
    new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: BTC, notices: [] }),
    /docker exited 4[\s\S]*second run/,
  );
  assert.equal(dockerLog().length, 2);
  assert.deepEqual(overlays(), []);
});

test("without an overlay a failure naming it is not retried (there is nothing to drop)", async () => {
  fakeDocker(`echo "$*" >> "$FAKE_DOCKER_LOG"\necho "/opt/pineforge-overlay/x" >&2\nexit 9`);
  dockerEnv({});
  await assert.rejects(new DockerRunner("img:9").backtest({ ...dockerInputs(), instrument: NOTHING_TO_APPLY }), /docker exited 9/);
  assert.equal(dockerLog().length, 1);
});
