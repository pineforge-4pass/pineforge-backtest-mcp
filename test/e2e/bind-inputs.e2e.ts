/** Linux runner only. Setup and evidence contract: bind-inputs.md. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callParity, connect } from "./client.js";
import { env, listProbes, probeCall } from "./corpus.js";

const required = (name: string) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required; see bind-inputs.md`);
  return value;
};
const docker = realpathSync(required("PF_BIND_REAL_DOCKER"));
function serverArgv(name: string): [string, string, ...string[]] {
  const argv: unknown = JSON.parse(required(name));
  assert.ok(Array.isArray(argv) && argv.length >= 2 && argv.every((arg) => typeof arg === "string"));
  assert.ok(isAbsolute(argv[0]) && isAbsolute(argv[1]), `${name} must name absolute Node and installed entrypoint paths`);
  return argv as [string, string, ...string[]];
}
const server = serverArgv("PF_E2E_SERVER");
const withUmask = fileURLToPath(new URL("./with-umask.mjs", import.meta.url));
const lock = JSON.parse(readFileSync(new URL("../../release-lock.json", import.meta.url), "utf8"));
const image = `${lock.image.repository}@${lock.image.digest}`;
const evidence = resolve(required("PF_BIND_EVIDENCE"));
mkdirSync(evidence, { mode: 0o700 }); // A new evidence directory for each run, never reuse traces.
const host = { uid: process.getuid!(), gid: process.getgid!() };
assert.notEqual(host.uid, 0, "the server must run as an ordinary host user");
const dockerRun = (args: string[]) => execFileSync(docker, args, { encoding: "utf8" }).trim();
const imageId = JSON.parse(dockerRun(["image", "inspect", image]))[0];
assert.ok(imageId.RepoDigests.includes(image));
const engineUid = Number(dockerRun(["run", "--rm", "--pull=never", "--network=none", "--entrypoint", "id", image, "-u"]));
assert.ok(Number.isInteger(engineUid) && engineUid > 0);
assert.notEqual(engineUid, host.uid, "this runner must reproduce the engine/host UID boundary");
const otherUser = required("PF_BIND_OTHER_USER");
const otherUid = Number(execFileSync("id", ["-u", otherUser], { encoding: "utf8" }).trim());
assert.ok(Number.isInteger(otherUid) && otherUid > 0);
assert.notEqual(otherUid, host.uid);
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
// The sealed kit verifies the installed tarballs. This revision is only a report label.
save(join(evidence, "identity.json"), { server, host, otherUid, engineUid, image, imageId: imageId.Id,
  imageUser: imageId.Config.User, revision: required("PF_BIND_REVISION") });

const root = mkdtempSync(join(realpathSync(tmpdir()), "pf-bind-e2e-"));
chmodSync(root, 0o755); // Only the observer and a nonsecret control are public here.
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
mkdirSync(bin, { mode: 0o755 });
chmodSync(bin, 0o755);
const observer = join(bin, "docker");
writeFileSync(observer, readFileSync(new URL("./bind-input-observer.py", import.meta.url)));
chmodSync(observer, 0o755);
const controlBytes = "public disposable access control\n";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/syminfo/${name}`, import.meta.url), "utf8");
const source = fixture("btc-ema-crossover.pine");
const csv = fixture("btcusdt-4h-2188.csv");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sourceOf = { kind: "tradingview", market: "spot", symbol: "BTCUSDT" };
const step = 0.00001;
const instrument = { schema: "pineforge-instrument/v1", resolved: true, qty_step: step, mincontract: step,
  mintick: 0.01, pointvalue: 1, type: "crypto", currency: "USDT", basecurrency: "BTC", source: sourceOf };

function snapshot(path: string) {
  const s = lstatSync(path);
  assert.ok(s.isFile());
  return { path, ino: s.ino, dev: s.dev, uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, sha256: digest(readFileSync(path)) };
}

function setup(name: string, withPrivacyControl = false, serverCwd?: string) {
  const dir = join(root, name);
  const work = join(dir, "caller");
  const staging = join(dir, "tmp");
  const traces = join(evidence, name);
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  mkdirSync(work, { mode: 0o700 });
  mkdirSync(staging, { mode: 0o711 });
  chmodSync(staging, 0o711); // The per-run parent must be the component that denies traversal.
  const control = join(staging, "nonsecret-control");
  if (withPrivacyControl) {
    mkdirSync(control, { mode: 0o755 });
    chmodSync(control, 0o755);
    writeFileSync(join(control, "sample.txt"), controlBytes);
    chmodSync(join(control, "sample.txt"), 0o644);
  }
  mkdirSync(traces, { mode: 0o700 });
  const originals: ReturnType<typeof snapshot>[] = [];
  const input = (name: string, text: string, mode = 0o600) => {
    const path = join(work, name);
    writeFileSync(path, text, { flag: "wx" });
    chmodSync(path, mode);
    originals.push(snapshot(path));
    return path;
  };
  const feed = (mode: number, withSidecar = false) => {
    const path = input("caller-btc.csv", csv, mode);
    if (withSidecar) {
      const rows = csv.trimEnd().split(/\r?\n/).slice(1);
      input(basename(path) + ".instrument.json", JSON.stringify({ ...instrument,
        csv: { interval: "4h", bars: rows.length, sha256: digest(csv),
          first_open_time: Number(rows[0]!.split(",")[0]), last_open_time: Number(rows.at(-1)!.split(",")[0]) },
      }));
    }
    return path;
  };
  // Pass the chosen mask into the server process; leave this test process alone.
  const launch = (mask: string, env: Record<string, string> = {}, [node, entrypoint, ...args] = server) => connect({
    cwd: serverCwd ?? work,
    argv: [node, withUmask, mask, entrypoint, ...args],
    env: {
      PATH: `${bin}:${process.env.PATH}`, TMPDIR: staging, PINEFORGE_IMAGE: image,
      PINEFORGE_ALLOW_ANYWHERE: "0", PINEFORGE_MAX_INLINE_BYTES: "2000000",
      PF_BIND_CONTROL: "", PF_BIND_TEST_TAMPER: "0", PF_BIND_FORBID_DOCKER: "0",
      PF_BIND_TRACE: traces, PF_BIND_REAL_DOCKER: docker, ...env,
    },
  });
  const observe = () => readdirSync(traces).filter((p) => /^docker-.*\.json$/.test(p))
    .map((p) => JSON.parse(readFileSync(join(traces, p), "utf8")));
  return { staging, traces, launch, observe, input, feed, originals,
    controlPath: withPrivacyControl ? join(control, "sample.txt") : undefined };
}

type Case = ReturnType<typeof setup>;
async function use(c: Case, client: Client, calls: () => Promise<void>) {
  try {
    await calls();
  } finally {
    try {
      // The parent schedules some removes without awaiting them. Record what is observed,
      // allowing a short drain while the server is still alive.
      const listRemaining = () => readdirSync(c.staging)
        .filter((p) => !c.controlPath || p !== "nonsecret-control");
      let remaining = listRemaining();
      for (let i = 0; remaining.length && i < 40; i++) {
        await new Promise((wake) => setTimeout(wake, 50));
        remaining = listRemaining();
      }
      const after = c.originals.map(({ path }) => snapshot(path));
      save(join(c.traces, "custody.json"), { before: c.originals, after, remaining });
      assert.deepEqual(after, c.originals, "caller files changed");
      assert.deepEqual(remaining, [], "per-run directories survived");
      for (const event of c.observe()) {
        for (const mount of Object.values(event.mounts) as Array<{ source: { path: string } }>) {
          if (mount.source.path.startsWith(`${c.staging}/`)) assert.equal(existsSync(mount.source.path), false);
        }
      }
    } finally {
      await client.close();
    }
  }
}

async function backtest(c: Case, client: Client, label: string, path: string, extra: Record<string, unknown> = {},
  name = "backtest_pine") {
  const raw = await client.callTool({ name, arguments: { source, ohlcv_csv_path: path, ...extra } });
  save(join(c.traces, `${label}.json`), raw);
  const text = (raw.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
  return { raw, text, report: raw.isError ? undefined : JSON.parse(text) };
}

/** Assert mount source exists during real invocation and is behind the expected per-run ancestor. */
function staged(c: Case, event: any, target: string, prefix: string, original?: string) {
  const m = event.mounts[target];
  assert.ok(m, `missing ${target}`);
  assert.deepEqual(m.flags, ["ro"]);
  assert.notEqual(m.source.path, original, "caller path was bound directly");
  assert.equal(m.source.mode, 0o644);
  assert.equal(m.source.uid, host.uid);
  assert.equal(m.source.regular, true);
  privateParent(c, m.parent, prefix);
  assert.ok(Object.values(event.mounts).every((other: any) => other.source.path !== m.parent.path),
    "private input ancestor was mounted");
  return m;
}

function privateParent(c: Case, parent: any, prefix: string) {
  assert.ok(parent.path.startsWith(`${c.staging}/${prefix}-`), `unexpected staging parent: ${parent.path}`);
  assert.equal(parent.path.slice(c.staging.length + 1).includes("/"), false, "expected the fresh per-run directory");
  assert.equal(parent.directory, true);
  assert.equal(parent.uid, host.uid);
  assert.equal(parent.mode, 0o700);
}

function assertBacktestBinds(c: Case, e: any, prefix: string, path: string, hasOverlay: boolean) {
  assert.equal(e.uid, host.uid);
  assert.equal(e.argv.includes("--user"), false);
  assert.equal(e.argv.at(-1), image);
  assert.deepEqual(Object.keys(e.mounts).sort(), ["/in/ohlcv.csv", "/in/strategy.cpp",
    ...(hasOverlay ? ["/opt/pineforge-overlay"] : [])]);
  const cpp = staged(c, e, "/in/strategy.cpp", prefix);
  assert.ok(e.argv.includes(`PINEFORGE_STRATEGY_CPP_SHA256=${cpp.sha256}`));
  const chart = staged(c, e, "/in/ohlcv.csv", prefix, path);
  assert.equal(chart.sha256, digest(csv));
  assert.ok(chart.source.ino !== lstatSync(path).ino || chart.source.dev !== lstatSync(path).dev);
  assert.equal(cpp.parent.path, chart.parent.path);
  if (hasOverlay) {
    const overlay = e.mounts["/opt/pineforge-overlay"];
    privateParent(c, overlay.parent, "pineforge-overlay");
    assert.deepEqual(overlay.flags, ["ro"]);
    assert.equal(overlay.source.directory, true);
    assert.equal(overlay.source.mode, 0o755);
    assert.deepEqual(overlay.children.map((f: any) => f.mode), [0o755, 0o644, 0o644]);
  }
  return chart;
}

function applied(report: any) {
  assert.equal(report.applied_runtime.syminfo.qty_step, step);
  assert.deepEqual(report.applied_runtime.syminfo.source, { ...sourceOf, via: "sidecar" });
  assert.deepEqual(report.fingerprint.provenance.runtime.syminfo, report.applied_runtime.syminfo);
  assert.equal(report.summary.total_trades, 22);
  assert.equal(report.trades.length, 22);
  assert.ok(report.trades.every((t: any) => t.qty >= step && Math.abs(t.qty / step - Math.round(t.qty / step)) < 1e-7));
  assert.equal(report.warnings, undefined);
}

function permissionFailure(event: any, result: Awaited<ReturnType<typeof backtest>>, target: string) {
  assert.equal(result.raw.isError, true, result.text);
  assert.ok(event.exit > 0, `expected a real failing Docker exit for ${target}`);
  const errno = new RegExp(`\\[Errno 13\\][^\\n]*${target.replaceAll(".", "\\.")}`);
  assert.match(event.stderr, errno);
  assert.match(result.text, errno);
}

for (const [label, mask, mode] of [
  ["umask-077", "077", 0o644], ["umask-027", "027", 0o644],
  ["private-feed", "022", 0o600], ["readable-control", "022", 0o644],
] as const) {
  test(label, async () => {
    const privacy = label === "private-feed";
    const c = setup(label, privacy);
    const path = c.feed(mode, true);
    const client = await c.launch(mask, privacy ? { PF_BIND_CONTROL: c.controlPath! } : {});
    await use(c, client, async () => {
      const result = await backtest(c, client, "mcp", path);
      const events = c.observe();
      const tr = events.find((e) => e.mounts["/in/strategy.pine"]);
      const run = events.find((e) => e.mounts["/in/strategy.cpp"]);
      assert.ok(tr, "MCP never invoked the real transpiler");
      assert.ok(events.every((e) => e.umask === `0${mask}` && e.uid === host.uid));
      assert.equal(tr.argv.includes("--user"), false);
      assert.equal(tr.argv.at(-1), image);
      if (result.raw.isError && mask !== "022") {
        assert.equal(run, undefined);
        assert.equal(tr.mounts["/in/strategy.pine"].source.mode, 0o666 & ~Number.parseInt(mask, 8));
        permissionFailure(tr, result, "/in/strategy.pine");
      } else if (result.raw.isError && privacy) {
        assert.equal(tr.exit, 0);
        assert.ok(run);
        assert.equal(run.mounts["/in/ohlcv.csv"].source.path, path, "parent did not bind the caller directly");
        assert.equal(run.mounts["/in/ohlcv.csv"].source.mode, mode);
        permissionFailure(run, result, "/in/ohlcv.csv");
      }
      assert.notEqual(result.raw.isError, true, result.text); // Red on the exact parent for the three cases above.
      assert.ok(run);
      assert.equal(events.length, 2);
      assert.equal(tr.exit, 0);
      assert.equal(run.exit, 0);
      applied(result.report);
      if (label === "readable-control") return; // Both heads must pass the real control.
      assert.deepEqual(Object.keys(tr.mounts), ["/in/strategy.pine"]);
      assert.equal(staged(c, tr, "/in/strategy.pine", "pineforge-tr").sha256, digest(source));
      const chart = assertBacktestBinds(c, run, "pineforge-bt", path, true);
      if (privacy) {
        const p = run.privacy;
        for (const probe of [p.control, p.input]) {
          assert.deepEqual(probe.uids, Array(4).fill(otherUid));
          assert.ok(Object.values(probe.caps).every((v) => v === 0), "probe has capabilities");
        }
        assert.equal(p.control.path, c.controlPath);
        assert.equal(p.control.errno, null);
        assert.equal(p.control.digest, digest(controlBytes));
        assert.equal(p.controlStat.mode, 0o644);
        assert.equal(p.controlParent.mode, 0o755);
        assert.equal(p.input.path, chart.source.path);
        assert.equal(p.input.errno, "EACCES");
        assert.deepEqual(p.inputAfter, chart.source);
      }
    });
  });
}

test("parallel grids have complete, distinct request inputs", async () => {
  const c = setup("grid");
  const path = c.feed(0o600, true);
  const client = await c.launch("077");
  await use(c, client, async () => {
    const requests = await Promise.allSettled([19, 20].map((length) => backtest(c, client, `mcp-${length}`, path,
      { inputs: { "Fast Length": [length, length + 3] }, concurrency: 2, include_trades: true }, "backtest_pine_grid")));
    for (const r of requests) {
      assert.equal(r.status, "fulfilled");
      assert.notEqual(r.value.raw.isError, true, r.value.text);
      const report = r.value.report;
      assert.deepEqual([report.total_combinations, report.succeeded, report.failed], [2, 2, 0]);
      assert.deepEqual(report.instrument.source, { ...sourceOf, via: "sidecar" });
      assert.ok(report.results.every((row: any) => row.ok && row.trades.length > 0 &&
        row.trades.every((t: any) => t.qty >= step && Math.abs(t.qty / step - Math.round(t.qty / step)) < 1e-7)));
    }
    const events = c.observe();
    assert.equal(events.length, 6);
    assert.ok(events.every((e) => e.exit === 0));
    const runs = events.filter((e) => e.mounts["/in/strategy.cpp"]);
    const groups = new Map<string, number[]>();
    for (const e of runs) {
      const chart = assertBacktestBinds(c, e, "pineforge-grid", path, true);
      const input = e.argv.find((a: string) => a.startsWith("PINEFORGE_INPUTS="));
      const length = Number(JSON.parse(input.slice("PINEFORGE_INPUTS=".length))["Fast Length"]);
      const lengths = groups.get(chart.parent.path) ?? [];
      groups.set(chart.parent.path, [...lengths, length]);
    }
    assert.deepEqual([...groups.values()].map((a) => a.sort((x, y) => x - y)).sort(), [[19, 22], [20, 23]]);
    assert.equal(new Set(runs.map((e) => e.mounts["/opt/pineforge-overlay"].parent.path)).size, 4);
  });
});

test("real image rejects changed vouched C++ and MCP cleans up after failure", async () => {
  const c = setup("digest-refusal");
  const path = c.feed(0o600); // No overlay retry can hide the guard's result.
  const client = await c.launch("077", { PF_BIND_TEST_TAMPER: "1" });
  await use(c, client, async () => {
    const result = await backtest(c, client, "mcp", path);
    assert.equal(result.raw.isError, true, result.text);
    const events = c.observe();
    const run = events.find((e) => e.mounts["/in/strategy.cpp"]);
    assert.equal(events.length, 2);
    assert.ok(run);
    assertBacktestBinds(c, run, "pineforge-bt", path, false);
    assert.notEqual(run.tamperedSha256, run.mounts["/in/strategy.cpp"].sha256);
    const refused = "[pineforge] refused: mounted strategy.cpp is not vouched for by PINEFORGE_STRATEGY_CPP_SHA256";
    assert.equal(run.exit, 2);
    assert.ok(run.stderr.split(/\r?\n/).includes(refused), run.stderr);
    assert.ok(result.text.split(/\r?\n/).includes(refused), result.text);
  });
});

test("a staging create error refuses the call without starting Docker", async () => {
  const c = setup("staging-create-error");
  const path = c.feed(0o600);
  const notDirectory = c.input("not-a-temp-root", "plain file\n");
  const client = await c.launch("077", { TMPDIR: notDirectory });
  await use(c, client, async () => {
    const result = await backtest(c, client, "mcp", path);
    assert.equal(result.raw.isError, true, result.text);
    assert.match(result.text, /ENOTDIR: not a directory, mkdtemp/);
    assert.deepEqual(c.observe(), []);
  });
});

const start = Date.UTC(2026, 8, 1);
const header = "timestamp,open,high,low,close,volume\n";
const chart = header + Array.from({ length: 3 }, (_, i) =>
  `${start + i * 900_000},100,${i === 2 ? 120 : 101},99,100,15\n`).join("");
const fine = header + Array.from({ length: 45 }, (_, i) =>
  `${start + i * 60_000},100,${i === 36 ? 120 : 101},99,100,1\n`).join("");
const tvFine = "time,open,high,low,close,Volume\n" + fine.trimEnd().split("\n").slice(1).map((row) => {
  const [ms, ...rest] = row.split(",");
  return [Number(ms) / 1000, ...rest].join(",") + "\n";
}).join("");
// Same final chart-bar witness as parity-magnifier.e2e.ts.
const parity = {
  pine: `//@version=6
strategy("tail", use_bar_magnifier=((true)), initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("X", "L", limit=110)
`,
  tradingview_trades: "Trade #,Type,Date and time,Signal,Price USDT,Size (qty),Net P&L USDT\n" +
    "1,Exit long,2026-09-01 00:30,X,110,1,10\n1,Entry long,2026-09-01 00:15,L,100,1,10\n",
  timeframe: "15", chart_timezone: "UTC", range_start: new Date(start).toISOString(),
  range_end: new Date(start + 1_800_000).toISOString(),
};

function assertParityBinds(c: Case, e: any, chartOrigin?: string, fineOrigin?: string) {
  assert.equal(e.exit, 0, e.stderr);
  assert.equal(e.uid, host.uid);
  assert.equal(e.umask, "0077");
  assert.equal(e.argv[e.argv.indexOf("--user") + 1], `${host.uid}:${host.gid}`);
  assert.deepEqual(e.argv.slice(-2), [image, "/opt/pf-parity/pf_parity.py"]);
  assert.deepEqual(Object.keys(e.mounts).sort(), ["/in/magnifier.csv", "/in/ohlcv.csv", "/jail", "/opt/pf-parity"]);
  assert.deepEqual(e.mounts["/opt/pf-parity"].flags, ["ro"]);
  const jail = e.mounts["/jail"];
  assert.deepEqual(jail.flags, []);
  privateParent(c, jail.source, "pineforge-parity");
  assert.equal(jail.work.uid, host.uid);
  assert.equal(jail.work.mode, 0o700);
  const mountedChart = staged(c, e, "/in/ohlcv.csv", "pineforge-pt", chartOrigin);
  const mountedFine = staged(c, e, "/in/magnifier.csv", "pineforge-pt", fineOrigin);
  assert.equal(mountedChart.parent.path, mountedFine.parent.path);
  assert.notEqual(mountedChart.source.path, mountedFine.source.path);
  return [mountedChart.sha256, mountedFine.sha256];
}

for (const kind of ["caller", "inline", "converted", "bad-pine"] as const) {
  test(`parity ${kind} chart and magnifier`, async () => {
    const c = setup(`parity-${kind}`);
    const chartPath = kind === "inline" ? undefined : c.input("private-chart.csv", kind === "converted" ? "\uFEFF" + chart : chart);
    const finePath = kind === "inline" ? undefined : c.input("private-magnifier.csv", kind === "converted" ? tvFine : fine);
    const client = await c.launch("077");
    await use(c, client, async () => {
      const result = await callParity(client, {
        ...parity,
        ...(chartPath ? { ohlcv_csv_path: chartPath, magnifier_ohlcv_csv_path: finePath } :
          { ohlcv_csv: chart, magnifier_ohlcv_csv: fine }),
        ...(kind === "bad-pine" ? { pine: "//@version=6\nstrategy(\n" } : {}),
      });
      save(join(c.traces, "mcp.json"), result);
      if (kind === "bad-pine") {
        assert.equal(result.data?.ok, false, result.text);
        assert.equal(result.data?.error, "transpile", result.text);
      } else {
        assert.equal(result.isError, false, result.text);
        assert.deepEqual([result.data?.ok, result.data?.tier, result.data?.matched], [true, "excellent", 1]);
        assert.match(JSON.stringify(result.data?.window), /magnifier: declared:/);
        if (chartPath) {
          assert.ok(String(result.data?.bars_source).includes(chartPath));
          assert.ok(String(result.data?.magnifier_bars_source).includes(finePath!));
        }
      }
      const events = c.observe();
      assert.equal(events.length, 1);
      assert.deepEqual(assertParityBinds(c, events[0], chartPath, finePath), [digest(chart), digest(fine)]);
    });
  });
}

for (const [label, fineName, fineMode, blockedSnapshot] of [
  ["parity-foreign-chart", "fine-readable.csv", 0o644, "ohlcv-input.csv"],
  // The server stages magnifier first. With both restricted, this isolates its first read.
  ["parity-foreign-magnifier", "fine.csv", 0o044, "magnifier_ohlcv-input.csv"],
] as const) {
  test(label, async () => {
    const cwd = realpathSync(required("PF_BIND_FOREIGN_FIXTURES"));
    const c = setup(label, false, cwd);
    const chartPath = join(cwd, "chart.csv");
    const finePath = join(cwd, fineName);

    // The direct Node child inherits this account. Prove its UID can open the
    // real originals without capabilities, even though it does not own them.
    const credentials = readFileSync("/proc/self/status", "utf8").split("\n")
      .filter((line) => /^(Uid|Gid|Groups|CapEff|CapPrm|CapAmb):/.test(line));
    const uids = credentials.find((line) => line.startsWith("Uid:"))?.slice(4).trim().split(/\s+/).map(Number);
    assert.deepEqual(uids, Array(4).fill(host.uid));
    for (const cap of ["CapEff", "CapPrm", "CapAmb"]) {
      assert.ok(credentials.some((line) => new RegExp(`^${cap}:\\s+0+$`).test(line)), `${cap} must be zero`);
    }
    for (const [path, mode, bytes] of [[chartPath, 0o044, chart], [finePath, fineMode, tvFine]] as const) {
      const original = snapshot(path); // lstat plus a real read under the MCP UID
      assert.equal(original.uid, otherUid, path);
      assert.equal(original.mode, mode, path);
      assert.equal(original.sha256, digest(bytes), path);
      c.originals.push(original);
    }
    save(join(c.traces, "original-read.json"), { credentials, originals: c.originals });

    const client = await c.launch("077");
    await use(c, client, async () => {
      const result = await callParity(client, { ...parity, ohlcv_csv_path: chartPath, magnifier_ohlcv_csv_path: finePath });
      save(join(c.traces, "mcp.json"), result);
      const events = c.observe();
      if (result.isError) {
        assert.deepEqual([result.data?.ok, result.data?.error], [false, "internal"], result.text);
        const denied = /^EACCES: permission denied, open '([^']+)'$/.exec(String(result.data?.message));
        assert.ok(denied?.[1], result.text);
        const path = denied[1];
        assert.equal(basename(path), blockedSnapshot);
        assert.match(basename(dirname(path)), /^pineforge-pt-/);
        assert.equal(dirname(dirname(path)), c.staging);
        assert.deepEqual(events, [], "a first-read failure must precede Docker");
        save(join(c.traces, "snapshot-first-read.json"), { errno: "EACCES", path, dockerInvocations: events.length });
      }
      assert.equal(result.isError, false, result.text);
      assert.deepEqual([result.data?.ok, result.data?.tier, result.data?.matched], [true, "excellent", 1], result.text);
      assert.equal(result.data?.bars_source, `your file ${chartPath}`);
      assert.equal(result.data?.magnifier_bars_source, `your file ${finePath} (TradingView chart export, converted)`);
      const window = result.data?.window as { range_start?: string; report_window?: string[]; harness_log?: string[] } | undefined;
      const utcMinute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
      assert.equal(window?.range_start, utcMinute(start));
      // The report starts one chart interval before TradingView's first entry.
      assert.deepEqual(window?.report_window, [utcMinute(start), utcMinute(start + 900_000)]);
      assert.match(window?.harness_log?.join("\n") ?? "",
        new RegExp(`magnifier: declared:.*sha256 ${digest(fine)}.*input_tf=1 script_tf=15, magnifier on`));
      assert.equal(events.length, 1);
      assert.deepEqual(assertParityBinds(c, events[0], chartPath, finePath), [digest(chart), digest(fine)]);
    });
  });
}

test("parity fetched chart and magnifier", async () => {
  const c = setup("parity-fetched");
  const p = listProbes(env("PF_E2E_CORPUS")).find((p) => p.slug === "barstate-isconfirmed-magnifier-on-01a");
  assert.ok(p);
  const { args } = probeCall(p, env("PF_E2E_FEED_15M"), env("PF_E2E_FEED_1M"));
  delete args.ohlcv_csv_path;
  args.tradingview_trades = readFileSync(join(p.dir, "tv_trades.csv"), "utf8")
    .split(/\r?\n/).slice(0, 11).join("\n") + "\n";
  args.range_start = "2025-03-31T00:00:00Z";
  const client = await c.launch("077");
  await use(c, client, async () => {
    const result = await callParity(client, args);
    save(join(c.traces, "mcp.json"), result);
    assert.equal(result.data?.ok, true, result.text);
    assert.match(String(result.data?.bars_source), /Binance.*15m/);
    assert.match(String(result.data?.magnifier_bars_source), /Binance.*1m/);
    assert.match(JSON.stringify(result.data?.window), /magnifier: declared:.*input_tf=1.*magnifier on/);
    const events = c.observe();
    assert.equal(events.length, 1);
    const hashes = assertParityBinds(c, events[0]);
    assert.notEqual(hashes[0], hashes[1]);
  });
});

test("local stdio still runs a 0600 feed and both parity inputs under 077 with no Docker", async () => {
  const localServer = serverArgv("PF_BIND_LOCAL_SERVER");
  const c = setup("local");
  const path = c.feed(0o600, true);
  const chartPath = c.input("private-chart.csv", chart);
  const finePath = c.input("private-magnifier.csv", fine);
  const client = await c.launch("077", { PF_BIND_FORBID_DOCKER: "1" }, localServer);
  await use(c, client, async () => {
    const info = await client.callTool({ name: "engine_info", arguments: {} });
    save(join(c.traces, "engine-info.json"), info);
    assert.notEqual(info.isError, true);
    assert.equal(JSON.parse((info.content as Array<{ text: string }>)[0]!.text).mode, "local");
    const result = await backtest(c, client, "mcp-backtest", path);
    assert.notEqual(result.raw.isError, true, result.text);
    assert.equal(result.report?._meta.image, "local");
    applied(result.report);
    const graded = await callParity(client, { ...parity, ohlcv_csv_path: chartPath, magnifier_ohlcv_csv_path: finePath });
    save(join(c.traces, "mcp-parity.json"), graded);
    assert.deepEqual([graded.data?.ok, graded.data?.tier, graded.data?.matched], [true, "excellent", 1], graded.text);
    assert.deepEqual(readdirSync(c.traces).filter((p) => p.startsWith("docker-")), []);
  });
});
