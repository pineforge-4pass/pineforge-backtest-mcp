import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// @ts-ignore CI fixture module.
import { gateState, packageState, run, gate, jobs, otherHead, head, oci } from "./fixtures/release/chain-inputs.mjs";

function invoke(name: string, make: (root: string) => any) {
  const root = mkdtempSync(join(tmpdir(), "pf-chain-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const state = make(root);
  const file = join(root, "mock.json");
  writeFileSync(file, JSON.stringify(state));
  const cli = readFileSync(new URL("./fixtures/release/mock-cli.mjs", import.meta.url));
  for (const tool of ["gh", "docker"]) writeFileSync(join(bin, tool), cli, { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/release/invoke-chain.mjs", import.meta.url)), name], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PF_MOCK_STATE: file,
      GITHUB_REPOSITORY: "pineforge-4pass/pineforge-backtest-mcp",
      NODE_OPTIONS: `--import=${new URL("./fixtures/release/mock-registry.mjs", import.meta.url).href}`,
    },
  });
  assert.ok(result.stdout.trim(), result.stderr);
  return { result, output: JSON.parse(result.stdout), state: JSON.parse(readFileSync(file, "utf8")) };
}
function found(s = gateState()) {
  const actual = invoke("latestGate", () => s);
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  assert.equal(actual.output.value.run_id, 101);
  return actual;
}
function previous(options = {}) {
  const actual = invoke("previousIdentity", (root) => packageState(root, options));
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  return actual;
}

test("D1: merged PR with empty pull_requests selects its gate receipt", () => {
  const { output, state } = found();
  assert.equal(output.value.pr, 38);
  assert.equal(output.value.head_sha, head);
  assert.equal(state.calls.filter((c: any) => c.tool === "gh" && c.args[0] === "run").length, 1);
});
for (const [title, receipt] of [
  ["D1: another PR in the gate is refused", { ...gate, pr: 39 }],
  ["D1: another head in the gate is refused", { ...gate, head_sha: otherHead }],
] as Array<[string, any]>) {
  test(title, () => {
    found();
    const actual = invoke("latestGate", () => gateState([run], { 101: receipt }));
    assert.equal(actual.result.status, 0, actual.output.error);
    assert.equal(actual.output.value, null);
  });
}
test("D1: no run returns null", () => {
  found();
  const actual = invoke("latestGate", () => gateState([]));
  assert.equal(actual.result.status, 0, actual.output.error);
  assert.equal(actual.output.value, null);
  assert.equal(actual.state.calls.filter((c: any) => c.args[0] === "run").length, 0);
});
for (const [title, invalid] of [
  ["D1: failed run is never selected", { ...run, conclusion: "failure" }],
  ["D1: incomplete run is never selected", { ...run, status: "in_progress" }],
  ["D1: another run head is never selected", { ...run, head_sha: otherHead }],
] as Array<[string, any]>) {
  test(title, () => {
    found();
    const actual = invoke("latestGate", () => gateState([invalid]));
    assert.equal(actual.result.status, 0, actual.output.error);
    assert.equal(actual.output.value, null);
    assert.equal(actual.state.calls.filter((c: any) => c.args[0] === "run").length, 0);
  });
}
test("D1: newest wrong PR is skipped for the older matching gate", () => {
  const newest = { ...run, id: 102, created_at: "2026-10-21T01:00:00Z" };
  // Deliberately oldest first: the helper must order candidates itself.
  const { state } = found(gateState([run, newest], { 101: gate, 102: { ...gate, run_id: 102, pr: 39 } }));
  assert.deepEqual(state.calls.filter((c: any) => c.args[0] === "run").map((c: any) => c.args[2]), ["102", "101"]);
});
for (const [label, patch] of [
  ["state", { state: "failed" }], ["expected jobs", { expected_jobs: ["test"] }],
  ["approved skips", { approved_skips: ["test"] }], ["run ID", { run_id: 102 }],
  ["attempt", { attempt: 2 }],
] as Array<[string, any]>) {
  test(`D1: matching receipt still enforces ${label}`, () => {
    found();
    const actual = invoke("latestGate", () => gateState([run], { 101: { ...gate, ...patch } }));
    assert.equal(actual.result.status, 1);
    assert.ok(actual.output.error);
  });
}
test("D1: matching receipt still enforces required job success", () => {
  found();
  const actual = invoke("latestGate", () => gateState([run], { 101: gate }, jobs.map((j: any) => j.name === "test" ? { ...j, conclusion: "skipped" } : j)));
  assert.equal(actual.result.status, 1);
  assert.match(actual.output.error, /unsuccessful required job/);
});
test("D1: matching receipt still binds both merge-candidate parents", () => {
  found();
  const actual = invoke("latestGate", () => {
    const s = gateState([run], { 101: { ...gate, source_sha: otherHead } });
    s.api[`repos/pineforge-4pass/pineforge-backtest-mcp/commits/${otherHead}`] = { parents: [{ sha: gate.base_sha }, { sha: otherHead }] };
    return s;
  });
  assert.equal(actual.result.status, 1);
  assert.ok(actual.output.error);
});

test("D2: lockless predecessor has exactly the observed legacy identity", () => {
  const { output, state } = previous();
  assert.deepEqual(output.value, {
    legacy: true, npm_version: "0.9.40", npm_integrity: state.legacy.npm_integrity,
    git_head: "1111111111111111111111111111111111111111", image_digest: state.image_digest,
  });
  assert.ok(state.calls.some((c: any) => c.tool === "docker" && c.args.at(-1) === `${oci}:v0.9.40`));
  assert.ok(!state.calls.some((c: any) => c.tool === "gh"));
});
test("D2: predecessor with a lock retains the exact full identity", () => {
  previous();
  const { output, state } = previous({ modern: true });
  assert.deepEqual(output.value, state.full);
  assert.ok(state.calls.some((c: any) => c.tool === "gh" && c.args[0] === "release"));
});
for (const [label, mutate, error] of [
  ["missing image tag", (s: any) => { s.missing_image = true; }, /Command failed|manifest unknown/],
  ["consumer image digest mismatch", (s: any) => { s.consumer_image = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; }, /Expected values/],
  ["different revision label", (_s: any) => {}, /Expected values/],
  ["absent gitHead", (s: any) => { delete s.responses["https://registry.npmjs.org/@pineforge%2fbacktest-mcp/0.9.40"].json.gitHead; }, /lacks source provenance/],
  ["tarball integrity mismatch", (s: any) => { s.responses["https://registry.npmjs.org/@pineforge%2fbacktest-mcp/0.9.40"].json.dist.integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="; }, /Expected values/],
  ["image content hash mismatch", (s: any) => { s.responses[`https://ghcr.io/v2/pineforge-4pass/pineforge-backtest-mcp/manifests/${s.image_digest}`].body += "\n"; }, /content hash differs/],
  ["missing arm64 child", (_s: any) => {}, /Expected values/],
  ["wrong config architecture", (_s: any) => {}, /Expected values/],
] as Array<[string, (s: any) => void, RegExp]>) {
  test(`D2: legacy predecessor refuses ${label}`, () => {
    previous();
    const actual = invoke("previousIdentity", (root) => {
      const s = packageState(root, {
        revision: label === "different revision label" ? otherHead : undefined,
        missingArm: label === "missing arm64 child", badArch: label === "wrong config architecture",
      });
      mutate(s);
      return s;
    });
    assert.equal(actual.result.status, 1);
    assert.match(actual.output.error, error);
  });
}
test("D2: legacy revision label may be present only when it matches gitHead", () => {
  previous();
  const { output, state } = previous({ revision: head });
  assert.deepEqual(output.value, state.legacy);
});
test("D2: packaged lock with a different source lock cannot fall back to legacy", () => {
  previous();
  const actual = invoke("previousIdentity", (root) => {
    const s = packageState(root, { modern: true });
    // Damage the source lock, leaving a real packaged lock and valid integrity.
    s.api[`repos/pineforge-4pass/pineforge-backtest-mcp/contents/release-lock.json?ref=${head}`].content = Buffer.from("{}").toString("base64");
    return s;
  });
  assert.equal(actual.result.status, 1);
  assert.match(actual.output.error, /package\/source lock differs/);
});
test("D2: a malformed packaged lock cannot fall back to legacy", () => {
  previous();
  const actual = invoke("previousIdentity", (root) => packageState(root, { modern: true, invalidLock: true }));
  assert.equal(actual.result.status, 1);
  assert.match(actual.output.error, /unexpected\/missing fields/);
});
test("D2: absent legacy image labels are accepted without inventing provenance", () => {
  previous();
  const { output, state } = previous({ omitLabels: true });
  assert.deepEqual(output.value, state.legacy);
});
for (const [label, options] of [
  ["revision", { revision: otherHead }],
  ["release image", { releaseImage: "ghcr.io/pineforge-4pass/pineforge-release@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
] as Array<[string, any]>) {
  test(`D2: locked predecessor retains mandatory ${label} check`, () => {
    previous();
    const actual = invoke("previousIdentity", (root) => packageState(root, { modern: true, ...options }));
    assert.equal(actual.result.status, 1);
    assert.match(actual.output.error, /Expected values/);
  });
}
