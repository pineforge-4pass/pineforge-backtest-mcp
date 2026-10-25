import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org/@pineforge%2fbacktest-mcp";
const npm = "@pineforge/backtest-mcp";
const repo = "pineforge-4pass/pineforge-backtest-mcp";
// Independent oracles: changing the production constants must not silently
// shorten the release's visibility window or change the expected request count.
const interval = 10_000;
const deadline = 600_000;
const runId = "40208628855";
const attempt = "1";
const scratch = "oidc-proof-40208628855-1";
const absent = { status: 404, json: { error: "Not found" } };
const tags = { npm_tags: true };
// Verbatim stderr from production run 40208628855 attempt 2 (including the
// endpoint in that captured diagnostic). The mock emits this on a scratch PUT.
const forbidden = "npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/-/package/@pineforge%2fbacktest-mcp/dist-tags/latest - This trusted publisher cannot manage dist-tags. Ask a package maintainer to enable Allow npm dist-tag.";

type Options = {
  channel?: "latest" | "next";
  runId?: string;
  attempt?: string;
  action?: "publishNpm" | "npmScratchTag";
  change?: (state: any, context: any) => void;
  noopControl?: boolean;
};
function invoke(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pf-npm-hardening-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, ".release-ci/offline-channels"), { recursive: true });
    mkdirSync(join(root, ".release-ci/offline-package"));
    const lock = JSON.parse(readFileSync(new URL("./fixtures/release/release-ready-v1.json", import.meta.url), "utf8"));
    const identity = JSON.parse(readFileSync(new URL("./fixtures/release/legacy-identity.json", import.meta.url), "utf8"));
    const channel = options.channel ?? "latest";
    const version = channel === "latest" ? "0.9.44" : "0.9.44-rc.1";
    const previous = channel === "latest" ? "0.9.40" : "0.9.40-rc.1";
    identity.npm_version = previous;
    const bytes = Buffer.from(`packed fixture for ${version}\n`);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const save = (path: string, data: unknown) => writeFileSync(join(root, path), JSON.stringify(data));
    save("release-lock.json", lock);
    save(".release-ci/offline-channels/channel-state.json", {
      role: "offline", event_id: lock.event_id, source_sha: "b".repeat(40), run_id: Number(options.runId ?? runId),
      version, channel, package_integrity: integrity, previous: {
        npm_version: previous, image_digest: channel === "latest" ? identity.image_digest : null,
        image_revision: null, identity,
      },
    });
    save(".release-ci/offline-package/package.json", { tar: "candidate.tgz" });
    writeFileSync(join(root, ".release-ci/offline-package/candidate.tgz"), bytes);
    const correct = { json: { name: npm, version, dist: { integrity } } };
    const candidate = `candidate-${lock.manifest.sha256.slice(0, 12)}`;
    const context = { root, version, previous, integrity, correct, candidate, channel,
      scratch: `oidc-proof-${options.runId ?? runId}-${options.attempt ?? attempt}` };
    const state: any = {
      calls: [], events: [], network: [], npm_writes: [], sleeps: [], elapsed: 0,
      npm_tags: { latest: "0.9.40", next: "0.9.40-rc.1" }, publish_version: version,
      api: {
        [`repos/${repo}/contents/release-lock.json?ref=main`]: { content: Buffer.from(JSON.stringify(lock)).toString("base64") },
        [`repos/${repo}/pulls?state=open&base=main&per_page=100`]: [[]],
      },
      responses: { [registry]: tags, [`${registry}/${version}`]: { sequence: [absent, correct] } },
    };
    options.change?.(state, context);
    const file = join(root, "mock.json");
    save("mock.json", state);
    const cli = readFileSync(new URL("./fixtures/release/mock-cli.mjs", import.meta.url));
    for (const tool of ["gh", "npm"]) writeFileSync(join(bin, tool), cli, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PF_MOCK_STATE: file,
      GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: options.runId ?? runId, GITHUB_RUN_ATTEMPT: options.attempt ?? attempt,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
      NODE_OPTIONS: `--import=${new URL("./fixtures/release/mock-registry.mjs", import.meta.url).href}`,
    };
    delete env.NPM_TOKEN;
    delete env.NODE_AUTH_TOKEN;
    let noop;
    if (options.noopControl) {
      // Independently check that the external mock reproduces npm's no-op,
      // then clear observations before exercising the real publishNpm path.
      noop = spawnSync(join(bin, "npm"), ["dist-tag", "add", `${npm}@${previous}`, channel], { cwd: root, env, encoding: "utf8" });
      const observed = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(noop.status, 0, noop.stderr);
      assert.equal(noop.stderr.trim(), `npm warn dist-tag add ${channel} is already set to version ${previous}`);
      assert.deepEqual(observed.npm_writes, []);
      assert.equal(observed.npm_tags[channel], previous);
      save("mock.json", state);
    }
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/release/invoke-chain.mjs", import.meta.url)), options.action ?? "publishNpm",
    ], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
    // A deadline mutant must fail the row even when it spins forever.
    assert.ifError(result.error);
    assert.ok(result.stdout.trim(), result.stderr);
    const proofPath = join(root, ".release-ci/oidc-proof.json");
    return {
      result, output: JSON.parse(result.stdout), state: JSON.parse(readFileSync(file, "utf8")), context, noop,
      proof: existsSync(proofPath) ? JSON.parse(readFileSync(proofPath, "utf8")) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
type Actual = ReturnType<typeof invoke>;
const npmCalls = (a: Actual) => a.state.calls.filter((c: any) => c.tool === "npm").map((c: any) => c.args);
const publishes = (a: Actual) => npmCalls(a).filter((args: string[]) => args[0] === "publish");
const removals = (a: Actual) => npmCalls(a).filter((args: string[]) => args[0] === "dist-tag" && args[1] === "rm");
const artifactReads = (a: Actual) => a.state.events.filter((e: any) => e.kind === "fetch" && e.url === `${registry}/${a.context.version}`);
const polls = (a: Actual) => artifactReads(a).slice(1); // Exclude the unchanged pre-publish existence check.
function success(a: Actual) {
  assert.equal(a.result.status, 0, a.output.error ?? a.result.stderr);
  assert.equal(a.output.value, "published");
}
function failedBeforePublish(a: Actual) {
  assert.equal(a.result.status, 1, a.result.stderr);
  assert.equal(publishes(a).length, 0);
  assert.equal(a.proof, null);
}
function scratchProof(a: Actual) {
  const tag = a.context.scratch;
  assert.deepEqual(npmCalls(a).filter((args: string[]) => args[0] === "dist-tag"), [
    ["dist-tag", "add", `${npm}@${a.context.previous}`, tag],
    ["dist-tag", "rm", npm, tag],
  ]);
  assert.deepEqual(a.state.npm_writes, [
    { operation: "add", tag, version: a.context.previous }, { operation: "rm", tag },
  ]);
  assert.equal(a.state.npm_tags.latest, "0.9.40");
  assert.equal(a.state.npm_tags.next, "0.9.40-rc.1");
}

test("RED R1: 404 twice then matching integrity succeeds after advancing the clock", () => {
  const a = invoke({ change(s, c) { s.responses[`${registry}/${c.version}`] = { sequence: [absent, absent, absent, c.correct] }; } });
  success(a);
  scratchProof(a);
  assert.equal(publishes(a).length, 1);
  assert.deepEqual(polls(a).map((e: any) => e.status), [404, 404, 200]);
  assert.deepEqual(a.state.sleeps, [interval, interval]);
  assert.equal(a.state.elapsed, 2 * interval);
});

test("RED R2: 404 forever fails at the named deadline with exactly 61 polls", () => {
  const a = invoke({ change(s, c) { s.responses[`${registry}/${c.version}`] = absent; } });
  assert.equal(a.result.status, 1);
  assert.ok(a.output.error.includes(`npm artifact ${a.context.version}`));
  assert.ok(a.output.error.includes(`deadline ${deadline} ms`));
  assert.equal(publishes(a).length, 1);
  assert.equal(polls(a).length, deadline / interval + 1);
  assert.equal(a.state.elapsed, deadline);
  assert.deepEqual(a.state.sleeps, Array(deadline / interval).fill(interval));
  scratchProof(a);
});

test("RED R3: different integrity fails immediately at the first poll", () => {
  const a = invoke({ change(s, c) {
    s.responses[`${registry}/${c.version}`] = { sequence: [absent, { json: { dist: { integrity: "sha512-different" } } }, c.correct] };
  } });
  assert.equal(a.result.status, 1);
  assert.match(a.output.error, /npm artifact verification failed/);
  assert.equal(polls(a).length, 1);
  assert.equal(a.state.elapsed, 0);
  assert.deepEqual(a.state.sleeps, []);
  assert.equal(publishes(a).length, 1);
  scratchProof(a);
});

test("RED R4: real trusted publisher 403 fails the scratch add before publish", () => {
  const a = invoke({ change(s) { s.dist_tag_add_stderr = forbidden; } });
  failedBeforePublish(a);
  assert.ok(a.output.error.includes(forbidden));
  assert.match(a.output.error, /This trusted publisher cannot manage dist-tags/);
  assert.deepEqual(npmCalls(a), [
    ["--version"], ["dist-tag", "add", `${npm}@0.9.40`, scratch],
  ]);
  assert.deepEqual(a.state.npm_writes, []);
  assert.equal(a.state.elapsed, 0);
});

test("RED R5: real no-op warning is not a write; scratch add then rm never touch channels", () => {
  const a = invoke({ noopControl: true });
  success(a);
  assert.ok(a.noop);
  scratchProof(a);
  assert.equal(publishes(a).length, 1);
  assert.equal(a.state.npm_tags[a.context.candidate], a.context.version);
  assert.ok(!Object.hasOwn(a.state.npm_tags, scratch));
});

test("RED R6: scratch is read present then absent before publish", () => {
  const a = invoke();
  success(a);
  const events = a.state.events;
  const add = events.findIndex((e: any) => e.kind === "npm" && e.args[1] === "add");
  const rm = events.findIndex((e: any) => e.kind === "npm" && e.args[1] === "rm");
  const publish = events.findIndex((e: any) => e.kind === "npm" && e.args[0] === "publish");
  const reads = events.filter((e: any) => e.kind === "fetch" && e.url === registry);
  assert.deepEqual(reads.map((e: any) => e.json["dist-tags"][scratch] ?? null), [null, "0.9.40", null]);
  assert.equal(events.indexOf(reads[0]) < add, true);
  assert.equal(add < events.indexOf(reads[1]) && events.indexOf(reads[1]) < rm, true);
  assert.equal(rm < events.indexOf(reads[2]) && events.indexOf(reads[2]) < publish, true);
  scratchProof(a);
});

test("RED R6b: scratch still visible after rm fails naming the leftover and cleanup result", () => {
  const a = invoke({ change(s) {
    s.responses[registry] = { sequence: [tags, tags, { json: { "dist-tags": { latest: "0.9.40", [scratch]: "0.9.40" } } }] };
  } });
  failedBeforePublish(a);
  assert.ok(a.output.error.includes(`scratch tag ${scratch} may be left behind`));
  assert.match(a.output.error, /absent after rm.*deadline 600000 ms/);
  assert.match(a.output.error, /best-effort rm failed/); // The first rm really deleted it.
  assert.equal(removals(a).length, 2); // One normal removal, one cleanup.
  assert.equal(a.state.elapsed, deadline);
  assert.equal(a.state.network.filter((url: string) => url === registry).length, 2 + deadline / interval + 1);
});

test("RED R7: successful add never read back fails and attempts one best-effort rm", () => {
  const a = invoke({ change(s) {
    s.responses[registry] = { sequence: [tags, { json: { "dist-tags": { latest: "0.9.40" } } }] };
  } });
  failedBeforePublish(a);
  assert.ok(a.output.error.includes(`scratch tag ${scratch} may be left behind`));
  assert.match(a.output.error, /present at 0.9.40.*deadline 600000 ms/);
  assert.match(a.output.error, /best-effort rm succeeded/);
  assert.equal(removals(a).length, 1);
  assert.equal(a.state.elapsed, deadline);
  assert.equal(a.state.network.filter((url: string) => url === registry).length, 1 + deadline / interval + 1);
  assert.ok(!Object.hasOwn(a.state.npm_tags, scratch));
});

test("RED R7b: rm error is never swallowed even when best-effort cleanup succeeds", () => {
  const text = "npm error 403 Forbidden - DELETE scratch tag";
  const a = invoke({ change(s) { s.dist_tag_rm_errors = [text]; } });
  failedBeforePublish(a);
  assert.ok(a.output.error.includes(text));
  assert.ok(a.output.error.includes(scratch));
  assert.match(a.output.error, /best-effort rm succeeded/);
  assert.equal(removals(a).length, 2);
  assert.equal(a.state.elapsed, 0);
  assert.ok(!Object.hasOwn(a.state.npm_tags, scratch));
});

test("RED R7c: failed cleanup names the remaining scratch tag and both npm errors", () => {
  const a = invoke({ change(s) { s.dist_tag_rm_errors = ["npm error first rm refused", "npm error cleanup refused"]; } });
  failedBeforePublish(a);
  assert.ok(a.output.error.includes(scratch));
  assert.match(a.output.error, /first rm refused/);
  assert.match(a.output.error, /best-effort rm failed:.*cleanup refused/s);
  assert.equal(removals(a).length, 2);
  assert.equal(a.state.npm_tags[scratch], "0.9.40");
});

test("RED R8: HTTP 500 throws immediately without widening absence", () => {
  const a = invoke({ change(s, c) { s.responses[`${registry}/${c.version}`] = { sequence: [absent, { status: 500, json: { error: "server failure" } }, c.correct] }; } });
  assert.equal(a.result.status, 1);
  assert.match(a.output.error, /npm registry HTTP 500/);
  assert.equal(polls(a).length, 1);
  assert.equal(a.state.elapsed, 0);
  assert.deepEqual(a.state.sleeps, []);
  scratchProof(a);
});

for (const [title, response, message] of [
  ["transport error", { error: "socket reset" }, /socket reset/],
  ["non-JSON", { status: 200, body: "not JSON" }, /JSON|Unexpected token/i],
  ["HTTP 200 JSON null", { status: 200, json: null }, /HTTP 200 returned null metadata/],
] as const) {
  test(`npm read-back ${title} throws immediately`, () => {
    const a = invoke({ change(s, c) { s.responses[`${registry}/${c.version}`] = { sequence: [absent, response, c.correct] }; } });
    assert.equal(a.result.status, 1);
    assert.match(a.output.error, message);
    assert.equal(polls(a).length, 1);
    assert.equal(a.state.elapsed, 0);
    scratchProof(a);
  });
}

test("RED R9: happy path writes complete proof before npm publish", () => {
  const a = invoke();
  success(a);
  assert.deepEqual(a.proof, {
    cli: "11.21.0", operation: "npm dist-tag add + rm (scratch)", authentication: "github-oidc",
    scratch_tag: scratch, channel: "latest", previous: "0.9.40", restored_version: "0.9.40",
    run_id: runId, run_attempt: attempt,
  });
  assert.deepEqual(a.state.proof_at_publish, a.proof);
  assert.equal(publishes(a).length, 1);
  assert.deepEqual(npmCalls(a), [
    ["--version"], ["dist-tag", "add", `${npm}@0.9.40`, scratch], ["dist-tag", "rm", npm, scratch],
    ["publish", ".release-ci/offline-package/candidate.tgz", "--ignore-scripts", "--access=public", "--tag", a.context.candidate],
  ]);
  assert.equal(polls(a).length, 1);
  assert.equal(a.state.elapsed, 0);
  scratchProof(a);
});

test("scratch proof polls add and removal visibility with the same advancing clock", () => {
  const a = invoke({ change(s) {
    s.responses[registry] = { sequence: [
      tags, { json: { "dist-tags": { latest: "0.9.40" } } }, tags,
      { json: { "dist-tags": { latest: "0.9.40", [scratch]: "0.9.40" } } }, tags,
    ] };
  } });
  success(a);
  assert.deepEqual(a.state.sleeps, [interval, interval]);
  assert.equal(a.state.elapsed, interval * 2);
  scratchProof(a);
});

test("existing identical npm version is checked once and never republished", () => {
  const a = invoke({ change(s, c) { s.responses[`${registry}/${c.version}`] = c.correct; } });
  success(a);
  assert.equal(publishes(a).length, 0);
  assert.equal(artifactReads(a).length, 2);
  scratchProof(a);
});

test("existing different npm version bytes fail before publish without polling", () => {
  const a = invoke({ change(s, c) { s.responses[`${registry}/${c.version}`] = { json: { dist: { integrity: "sha512-other" } } }; } });
  assert.equal(a.result.status, 1);
  assert.match(a.output.error, /published npm version has different bytes/);
  assert.equal(publishes(a).length, 0);
  assert.equal(artifactReads(a).length, 1);
  assert.equal(a.state.elapsed, 0);
  scratchProof(a);
});

test("scratch proof is valid, separate from latest/next/channel/candidate, and unique per run and attempt", () => {
  const observed: string[] = [];
  for (const config of [{}, { attempt: "2" }, { runId: "40208628856" }, { channel: "next" as const, attempt: "3" }]) {
    const a = invoke(config);
    success(a);
    scratchProof(a);
    const tag = a.proof.scratch_tag;
    assert.match(tag, /^oidc-proof-[1-9][0-9]*-[1-9][0-9]*$/);
    assert.equal(encodeURIComponent(tag), tag);
    assert.ok(!/^[v=~^*0-9<>]/.test(tag)); // An alphabetic tag is not a semver range.
    assert.ok(!["latest", "next", a.context.channel, a.context.candidate].includes(tag));
    observed.push(tag);
  }
  assert.equal(new Set(observed).size, observed.length);
  assert.deepEqual(observed, [
    "oidc-proof-40208628855-1", "oidc-proof-40208628855-2", "oidc-proof-40208628856-1", "oidc-proof-40208628855-3",
  ]);
});

test("pre-existing scratch tag is refused so an already-set warning cannot prove authorisation", () => {
  const a = invoke({ change(s) { s.npm_tags[scratch] = "0.9.40"; } });
  failedBeforePublish(a);
  assert.match(a.output.error, /already exists; refusing a no-op OIDC proof/);
  assert.deepEqual(npmCalls(a), [["--version"]]);
  assert.deepEqual(a.state.npm_writes, []);
});

for (const phase of ["add", "rm"]) {
  test(`scratch ${phase} read-back HTTP error fails immediately and attempts one cleanup`, () => {
    const a = invoke({ change(s) {
      s.responses[registry] = { sequence: phase === "add"
        ? [tags, { status: 503, body: "registry unavailable" }]
        : [tags, tags, { status: 503, body: "registry unavailable" }] };
    } });
    failedBeforePublish(a);
    assert.match(a.output.error, /npm registry HTTP 503/);
    assert.ok(a.output.error.includes(scratch));
    assert.match(a.output.error, phase === "add" ? /best-effort rm succeeded/ : /best-effort rm failed/);
    assert.equal(removals(a).length, phase === "add" ? 1 : 2);
    assert.equal(a.state.elapsed, 0);
    assert.deepEqual(a.state.sleeps, []);
  });
}

test("moved channel is refused before any OIDC scratch write", () => {
  const a = invoke({ change(s) { s.npm_tags.latest = "0.9.43"; } });
  failedBeforePublish(a);
  assert.match(a.output.error, /channel moved before OIDC proof/);
  assert.deepEqual(npmCalls(a), [["--version"]]);
  assert.deepEqual(a.state.npm_writes, []);
});

test("OIDC proof still requires the pinned npm CLI", () => {
  const a = invoke({ change(s) { s.cli = "11.20.0"; } });
  failedBeforePublish(a);
  assert.match(a.output.error, /dist-tag OIDC requires the pinned supporting CLI/);
  assert.deepEqual(npmCalls(a), [["--version"]]);
  assert.deepEqual(a.state.npm_writes, []);
});

for (const [label, id, runAttempt] of [
  ["missing run ID", "", "1"], ["semver run ID", "1.2.3", "1"], ["channel injection", "latest", "1"],
  ["candidate injection", "candidate-123", "1"], ["missing attempt", runId, ""],
  ["nonpositive attempt", runId, "0"], ["next injection", runId, "next"], ["separator injection", runId, "1/2"],
]) {
  test(`scratch tag rejects ${label} before any npm mutation`, () => {
    const a = invoke({ action: "npmScratchTag", change(s, c) { s.scratch_inputs = [{ channel: c.channel }, c.candidate, id, runAttempt]; } });
    assert.equal(a.result.status, 1);
    assert.match(a.output.error, /scratch proof requires a valid run/);
    assert.deepEqual(npmCalls(a), []);
    assert.equal(a.proof, null);
  });
}

for (const collision of ["channel", "candidate"]) {
  test(`scratch tag rejects an explicit ${collision} collision`, () => {
    const a = invoke({ action: "npmScratchTag", change(s, c) {
      s.scratch_inputs = [{ channel: collision === "channel" ? scratch : c.channel }, collision === "candidate" ? scratch : c.candidate, runId, attempt];
    } });
    assert.equal(a.result.status, 1);
    assert.match(a.output.error, /must not touch a distribution tag/);
    assert.deepEqual(npmCalls(a), []);
  });
}
