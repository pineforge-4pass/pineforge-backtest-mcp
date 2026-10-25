import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore Literal wire fixtures; no production selection logic.
import { gate, head, jobs, pr, repo, run } from "./fixtures/release/chain-inputs.mjs";

const runsRoute = `repos/${repo}/actions/workflows/test.yml/runs?event=pull_request&head_sha=${head}&per_page=100`;
const versionScript = fileURLToPath(new URL("../scripts/release-version.mjs", import.meta.url));

function temporary(t: TestContext, base = tmpdir()) {
  const root = mkdtempSync(join(base, "pf-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function invokeGate(t: TestContext, runPages: any[][], totalCount = runPages.flat().length) {
  const root = temporary(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), readFileSync(new URL("./fixtures/release/probe-gh.mjs", import.meta.url)), { mode: 0o755 });
  const pages: Record<string, any[]> = {
    [runsRoute]: runPages.map((workflow_runs) => ({ total_count: totalCount, workflow_runs })),
  };
  const downloads: Record<string, any> = {};
  for (const r of runPages.flat()) {
    pages[`repos/${repo}/actions/runs/${r.id}/artifacts?per_page=100`] = [{
      artifacts: [{ name: `offline-gate-${r.id}-${r.run_attempt}`, expired: false }],
    }];
    pages[`repos/${repo}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`] = [{ jobs }];
    downloads[r.id] = {
      name: `offline-gate-${r.id}-${r.run_attempt}`,
      receipt: { ...gate, run_id: r.id, attempt: r.run_attempt },
    };
  }
  const file = join(root, "state.json");
  writeFileSync(file, JSON.stringify({ pr, pages, downloads, calls: [], downloadDirs: [] }));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./fixtures/release/probe-invoke.mjs", import.meta.url)),
  ], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PF_PROBE_STATE: file, GITHUB_REPOSITORY: repo },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const state = JSON.parse(readFileSync(file, "utf8"));
  t.after(() => {
    for (const dir of state.downloadDirs) rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(result.stdout.trim(), result.stderr);
  return { result, output: JSON.parse(result.stdout), calls: state.calls as string[][] };
}

function assertFound(actual: ReturnType<typeof invokeGate>, id = run.id) {
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  assert.deepEqual(actual.output.value, {
    ...gate, run_id: id, jobs,
    checks: {
      run_id: id, run_attempt: 1, sha: head,
      expected: ["test", "runtime (amd64)", "runtime (arm64)", "release/ready"],
      approved_skips: [],
      results: { test: "success", "runtime (amd64)": "success", "runtime (arm64)": "success", "release/ready": "success" },
    },
  });
}

function failedRuns(count: number) {
  return Array.from({ length: count }, (_, i) => ({ ...run, id: 200 + i, conclusion: "failure" }));
}

function chunks(runs: any[]) {
  const pages = [];
  for (let i = 0; i < runs.length; i += 100) pages.push(runs.slice(i, i + 100));
  return pages;
}

test("MCP-147 control: one-page gate selection preserves receipt, filtering and newest-first order", (t) => {
  const newest = { ...run, id: 102, created_at: "2026-10-21T01:00:00Z" };
  assertFound(invokeGate(t, [[
    run, newest,
    { ...newest, id: 103, conclusion: "failure" },
    { ...newest, id: 104, status: "in_progress" },
    { ...newest, id: 105, head_sha: "2".repeat(40) },
  ]]), 102);
});

test("RED MCP-147: matching successful gate only on page 2 is found", (t) => {
  assertFound(invokeGate(t, [[run]]));
  const actual = invokeGate(t, [failedRuns(100), [run]]);
  assertFound(actual);
  assert.deepEqual(actual.calls[0], ["api", "--paginate", "--slurp", runsRoute]);
  assert.equal(actual.calls.filter((args) => args[0] === "run").length, 1);
});

test("RED MCP-147: page-overflow count 1001 exceeds the 1000-run ceiling", (t) => {
  const control = invokeGate(t, chunks(failedRuns(1000)));
  assert.equal(control.result.status, 0, control.output.error);
  assert.equal(control.output.value, null);
  const actual = invokeGate(t, chunks(failedRuns(1001)));
  assert.equal(actual.result.status, 1);
  assert.match(actual.output.error, /count 1001 exceeds ceiling 1000/);
  assert.equal(actual.calls.length, 1, "overflow must refuse before any artifact/job probe");
});

test("RED MCP-147: API search cap cannot hide declared total count 1001", (t) => {
  const pages = chunks(failedRuns(1000));
  const control = invokeGate(t, pages);
  assert.equal(control.result.status, 0, control.output.error);
  assert.equal(control.output.value, null);
  const actual = invokeGate(t, pages, 1001);
  assert.equal(actual.result.status, 1);
  assert.match(actual.output.error, /count 1001 exceeds ceiling 1000/);
});

test("RED MCP-147: incomplete pagination below the ceiling refuses the declared count", (t) => {
  const control = invokeGate(t, [failedRuns(100)]);
  assert.equal(control.result.status, 0, control.output.error);
  assert.equal(control.output.value, null);
  const actual = invokeGate(t, [failedRuns(100)], 101);
  assert.equal(actual.result.status, 1);
  assert.match(actual.output.error, /incomplete gate run inventory: count 101, received 100/);
});

const tsBody = '// AUTO-GENERATED by scripts/sync-version.mjs from /VERSION — do not edit.\nexport const VERSION = "0.9.45";\n';
const serverBefore = '{"name":"probe","version":"0.9.44","packages":[{"identifier":"ghcr.io/example/probe:v0.9.44"},{"identifier":"ghcr.io/example/preview:0.9.44-rc.1"},{"identifier":"untagged"},null]}\n';
const serverAfter = `{
  "name": "probe",
  "version": "0.9.45",
  "packages": [
    {
      "identifier": "ghcr.io/example/probe:v0.9.45"
    },
    {
      "identifier": "ghcr.io/example/preview:v0.9.45"
    },
    {
      "identifier": "untagged"
    },
    null
  ]
}
`;

function syncFixture(t: TestContext) {
  // Root's private TMPDIR may be unsearchable after dropping privileges.
  const root = temporary(t, process.getuid?.() === 0 ? "/tmp" : tmpdir());
  // Permission rows use real filesystem failures. Root CI drops the child to
  // uid/gid 65534; ordinary runners retain their uid. Other files stay writable.
  chmodSync(root, 0o755);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  chmodSync(join(root, "src"), 0o777);
  for (const name of ["sync-version.mjs", "release-contract.mjs", "release-version.mjs"]) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(root, "scripts", name));
  }
  copyFileSync(new URL("../release-lock.json", import.meta.url), join(root, "release-lock.json"));
  const files = {
    VERSION: "0.9.45\n",
    "package.json": '{"name":"probe","version":"0.9.44"}\n',
    "package-lock.json": '{"name":"probe","version":"0.9.44","lockfileVersion":3,"packages":{"":{"name":"probe","version":"0.9.44"}}}\n',
    "src/version.ts": "// stale version\n",
    "server.json": serverBefore,
  };
  for (const [path, body] of Object.entries(files)) {
    writeFileSync(join(root, path), body);
    chmodSync(join(root, path), 0o666);
  }
  const invoke = () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/release/probe-sync.mjs", import.meta.url)),
      join(root, "scripts/sync-version.mjs"),
    ], {
      cwd: root, encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  return { root, invoke, read: (path: string) => readFileSync(join(root, path), "utf8") };
}

function syncControl(t: TestContext) {
  const fixture = syncFixture(t);
  const result = fixture.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.read("src/version.ts"), tsBody);
  assert.equal(fixture.read("server.json"), serverAfter);
  return fixture;
}

test("MCP-148 control: normal sync preserves exact generated file bytes", (t) => {
  const fixture = syncControl(t);
  assert.equal(fixture.read("package.json"), '{\n  "name": "probe",\n  "version": "0.9.45"\n}\n');
  assert.equal(fixture.read("package-lock.json"), `{
  "name": "probe",
  "version": "0.9.45",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "probe",
      "version": "0.9.45"
    }
  }
}
`);
  const again = fixture.invoke();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "[sync-version] in sync → 0.9.45\n");
  assert.equal(fixture.read("src/version.ts"), tsBody);
  assert.equal(fixture.read("server.json"), serverAfter);
});

test("RED MCP-148: src/version.ts EISDIR propagates the read error before a write attempt", (t) => {
  syncControl(t);
  const fixture = syncFixture(t);
  const path = join(fixture.root, "src/version.ts");
  unlinkSync(path);
  mkdirSync(path);
  const result = fixture.invoke();
  assert.equal(result.status, 1);
  // Before the fix this also exits 1, but only after swallowing read EISDIR
  // and attempting a write (syscall 'open'). Check the original read failure.
  assert.match(result.stderr, /EISDIR/);
  assert.match(result.stderr, /syscall: 'read'/);
  assert.equal(fixture.read("server.json"), serverBefore);
});

test("RED MCP-148: src/version.ts EACCES is not absence even when writing would succeed", (t) => {
  syncControl(t);
  const fixture = syncFixture(t);
  const path = join(fixture.root, "src/version.ts");
  chmodSync(path, 0o222);
  const result = fixture.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EACCES/);
  assert.match(result.stderr, /version\.ts/);
  chmodSync(path, 0o666);
  assert.equal(fixture.read("src/version.ts"), "// stale version\n");
});

test("MCP-148 control: ENOENT src/version.ts is created with the same bytes", (t) => {
  const fixture = syncFixture(t);
  unlinkSync(join(fixture.root, "src/version.ts"));
  const result = fixture.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.read("src/version.ts"), tsBody);
  assert.equal(fixture.read("server.json"), serverAfter);
});

test("RED MCP-148: invalid existing server.json fails and leaves its bytes unchanged", (t) => {
  syncControl(t);
  const fixture = syncFixture(t);
  const invalid = '{"version": "0.9.44", invalid JSON}\n';
  writeFileSync(join(fixture.root, "server.json"), invalid);
  const result = fixture.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SyntaxError/);
  assert.equal(fixture.read("server.json"), invalid);
});

test("RED MCP-148: existing server.json EISDIR read error is not absence", (t) => {
  syncControl(t);
  const fixture = syncFixture(t);
  const path = join(fixture.root, "server.json");
  unlinkSync(path);
  mkdirSync(path);
  const result = fixture.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EISDIR/);
  assert.match(result.stderr, /syscall: 'read'/);
});

test("RED MCP-148: existing server.json EACCES read error is not absence", (t) => {
  syncControl(t);
  const fixture = syncFixture(t);
  const path = join(fixture.root, "server.json");
  chmodSync(path, 0o000);
  const result = fixture.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EACCES/);
  assert.match(result.stderr, /server\.json/);
  chmodSync(path, 0o666);
  assert.equal(fixture.read("server.json"), serverBefore);
});

test("MCP-148 control: truly absent server.json remains absent and succeeds", (t) => {
  const fixture = syncFixture(t);
  const path = join(fixture.root, "server.json");
  unlinkSync(path);
  const result = fixture.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path), false);
  assert.equal(fixture.read("src/version.ts"), tsBody);
});

test("RED MCP-148: existing server.json write failure propagates and preserves bytes", (t) => {
  syncControl(t);
  const fixture = syncFixture(t);
  chmodSync(join(fixture.root, "server.json"), 0o444);
  const result = fixture.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EACCES/);
  assert.match(result.stderr, /server\.json/);
  assert.equal(fixture.read("server.json"), serverBefore);
});

function versionCli(args: string[], input: string | number) {
  const result = spawnSync(process.execPath, [versionScript, ...args], {
    encoding: "utf8",
    ...(typeof input === "number" ? { stdio: [input, "pipe", "pipe"] as [number, "pipe", "pipe"] } : { input }),
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

for (const [command, args, empty, normal] of [
  ["latest-tag", ["latest-tag"], "", "v0.9.33\n"],
  ["next", ["next", "--current=0.9.31", "--release=1.0.0"],
    "next=0.9.32\ntag=v0.9.32\nprerelease=false\n",
    "next=0.9.34\ntag=v0.9.34\nprerelease=false\n"],
] as Array<[string, string[], string, string]>) {
  test(`MCP-149 control: ${command} successfully read empty stdin keeps the no-tags answer`, () => {
    const result = versionCli(args, "");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, empty);
  });

  test(`MCP-149 control: ${command} normal tag lists keep their output`, () => {
    const result = versionCli(args, "junk\nv0.9.32-rc.1\nv0.9.33\nv0.9.32\n");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, normal);
  });

  test(`RED MCP-149: ${command} stdin directory descriptor fails with EISDIR and no output`, (t) => {
    const control = versionCli(args, "");
    assert.equal(control.status, 0, control.stderr);
    assert.equal(control.stdout, empty);
    // A directory opened read-only is a valid inheritable fd on Linux/macOS.
    // Reading it returns EISDIR on both, without TTY/nonblocking-pipe races.
    const fd = openSync(temporary(t), "r");
    try {
      const result = versionCli(args, fd);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^::error::cannot read stdin \(EISDIR\):/);
    } finally {
      closeSync(fd);
    }
  });
}
