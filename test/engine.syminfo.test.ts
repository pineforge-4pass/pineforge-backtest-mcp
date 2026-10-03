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
import { IMAGE_LAYOUT, IMAGE_PREFIX, OVERLAY_MOUNT, createOverlay, layoutOf, overlayEnv, shimPath } from "../src/overlay.js";
import { INSTRUMENT_SCHEMA, type Instrument } from "../src/instrument.js";

const PREFIX = resolve("test/fixtures/fake-prefix-overlay");
const BTC: Instrument = {
  schema: INSTRUMENT_SCHEMA, resolved: true, qty_step: 0.00001, mincontract: 0.00001, mintick: 0.01, pointvalue: 1,
  type: "crypto", ticker: "BTCUSDT", tickerid: "BINANCE:BTCUSDT", currency: "USDT", basecurrency: "BTC",
  source: { kind: "binance_exchange_info", market: "spot", symbol: "BTCUSDT" },
};

// A private TMPDIR, so the overlays a test sees are its own.
let scratch: string;
let savedTmp: string | undefined;
let savedPath: string | undefined;
const overlays = () => readdirSync(scratch).filter((n) => n.startsWith("pineforge-overlay-"));

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "pf-overlay-test-"));
  savedTmp = process.env.TMPDIR;
  savedPath = process.env.PATH;
  process.env.TMPDIR = scratch;
});
after(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  process.env.PATH = savedPath;
  rmSync(scratch, { recursive: true, force: true });
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
  const bin = mkdtempSync(join(scratch, "bin-"));
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
  const dir = mkdtempSync(join(scratch, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "timestamp,open,high,low,close,volume\n");
  const out = await new DockerRunner("img:9").backtest({
    cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv"), instrument: BTC,
  }) as { argv: string[]; overlay_host: string; entries: string[]; lib_link: string; shim_is_file: boolean; instrument: Instrument; mode: string };
  assert.ok(out.overlay_host.startsWith(scratch), "the overlay is under the OS temp dir");
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
  const dir = mkdtempSync(join(scratch, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "x\n");
  const out = await new DockerRunner("img:9").backtest({ cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv") }) as
    { argv: string[]; overlay_host: string | null };
  assert.equal(out.overlay_host, null);
  assert.ok(!out.argv.some((a) => a.startsWith("PINEFORGE_PREFIX") || a.startsWith("PINEFORGE_SYMINFO")));
});

test("a docker failure surfaces its stderr and still removes the overlay", async () => {
  fakeDocker('echo "[pineforge] cannot apply the instrument grid: run_json.py lacks main" >&2; exit 4');
  const dir = mkdtempSync(join(scratch, "in-"));
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

async function localRun(call: { instrument?: Instrument; inputs?: Record<string, string> }, prefix = PREFIX): Promise<Seen> {
  const dir = mkdtempSync(join(scratch, "in-"));
  writeFileSync(join(dir, "strategy.cpp"), "int main(){}");
  writeFileSync(join(dir, "bars.csv"), "timestamp,open,high,low,close,volume\n");
  return await new LocalRunner(prefix).backtest({ cppPath: join(dir, "strategy.cpp"), csvPath: join(dir, "bars.csv"), ...call }) as Seen;
}

test("LocalRunner.backtest with an instrument runs the entrypoint on an overlay of its prefix", async () => {
  const seen = await localRun({ instrument: BTC, inputs: { "Fast Length": "8" } });
  assert.ok(seen.prefix.startsWith(scratch) && seen.prefix.includes("pineforge-overlay-"), seen.prefix);
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

test("an unresolved instrument goes through the same overlay, so the report can say so", async () => {
  const unresolved: Instrument = { schema: INSTRUMENT_SCHEMA, resolved: false, reason: "no symbol, syminfo or sidecar was given" };
  const seen = await localRun({ instrument: unresolved });
  assert.deepEqual(seen.instrument, unresolved);
  assert.ok(seen.prefix.includes("pineforge-overlay-"));
});

test("a relative prefix is linked by its absolute path", async () => {
  const seen = await localRun({ instrument: BTC }, "test/fixtures/fake-prefix-overlay");
  assert.equal(seen.real_prefix, PREFIX);
  assert.equal(seen.lib_resolves, true);
});

test("concurrent local runs each get their own overlay", async () => {
  const other: Instrument = { ...BTC, qty_step: 0.1, mincontract: 0.1, ticker: "XRPUSDT" };
  const [a, b] = await Promise.all([localRun({ instrument: BTC }), localRun({ instrument: other })]);
  assert.notEqual(a.prefix, b.prefix);
  assert.equal(a.instrument!.ticker, "BTCUSDT");
  assert.equal(b.instrument!.ticker, "XRPUSDT");
  assert.deepEqual(overlays(), []);
});

test("a local backtest failure removes its overlay", async () => {
  const broken = mkdtempSync(join(scratch, "broken-prefix-"));
  mkdirSync(join(broken, "bin"));
  mkdirSync(join(broken, "lib"));
  writeFileSync(join(broken, "bin", "entrypoint.sh"), '#!/usr/bin/env bash\necho "boom" >&2\nexit 4\n');
  await assert.rejects(localRun({ instrument: BTC }, broken), /engine backtest failure \(exit 4\)[\s\S]*boom/);
  assert.deepEqual(overlays(), []);
});
