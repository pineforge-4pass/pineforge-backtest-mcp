import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// @ts-ignore workflow module.
import { validateChannelState } from "../scripts/distribution.mjs";
// @ts-ignore CI fixture module.
import { distributionState } from "./fixtures/release/chain-inputs.mjs";
const original = {
  role: "offline", event_id: `sha256:${"a".repeat(64)}`, source_sha: "b".repeat(40), run_id: 77,
  version: "0.9.41", channel: "latest", previous: {
    npm_version: "0.9.40", image_digest: `sha256:${"d".repeat(64)}`,
    identity: JSON.parse(readFileSync(new URL("./fixtures/release/receipt-v1.json", import.meta.url), "utf8")).previous,
  },
};
const legacy = JSON.parse(readFileSync(new URL("./fixtures/release/legacy-identity.json", import.meta.url), "utf8"));
const legacyPrevious = {
  npm_version: "0.9.40",
  image_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  image_revision: "f05d2565985710f72f56008dd12eaa013ca8a0eb",
  identity: legacy,
};
const npmRegistry = "https://registry.npmjs.org/@pineforge%2fbacktest-mcp";
const imageRepository = "ghcr.io/pineforge-4pass/pineforge-backtest-mcp";
function mockEnv(bin: string, file: string) {
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PF_MOCK_STATE: file,
    NODE_OPTIONS: `--import=${new URL("./fixtures/release/mock-registry.mjs", import.meta.url).href}`,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: String(process.pid),
    RESTORE_SOURCE_RUN: "77", GITHUB_REPOSITORY: "pineforge-4pass/pineforge-backtest-mcp" };
  delete (env as Record<string, string | undefined>).NODE_AUTH_TOKEN;
  delete (env as Record<string, string | undefined>).NPM_TOKEN;
  return env;
}
function distributionArgs(action: "prepare" | "promote" | "restore") {
  // The fixture injects a virtual clock into the exported helpers. It falls back
  // to the real CLI on main/r1 so RED runs exercise their actual read-back.
  const entry = action === "prepare" ? "../scripts/distribution.mjs" : "./fixtures/release/mock-registry.mjs";
  return [fileURLToPath(new URL(entry, import.meta.url)), action];
}
function distribute(action: "prepare" | "promote", options: Record<string, unknown>,
  overrides: Record<string, unknown> = {}, expectedStatus: 0 | 1 = 0) {
  const root = mkdtempSync(join(tmpdir(), "pf-distribute-test-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const fixture = distributionState(root, action, options);
  const state = { ...fixture, ...overrides,
    responses: { ...fixture.responses, ...(overrides.responses as Record<string, unknown> | undefined) } };
  const file = join(root, "mock.json");
  writeFileSync(file, JSON.stringify(state));
  const fake = readFileSync(new URL("./fixtures/release/mock-cli.mjs", import.meta.url));
  for (const tool of ["gh", "npm", "docker"]) writeFileSync(join(bin, tool), fake, { mode: 0o755 });
  const env = { ...mockEnv(bin, file), GITHUB_REF: "refs/tags/v0.9.41",
    GITHUB_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1" };
  const result = spawnSync(process.execPath, distributionArgs(action), {
    cwd: root, env, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  if (expectedStatus === 1) assert.equal(result.status, 1, result.stderr);
  else assert.equal(result.status, 0, result.stderr);
  const evidence = join(root, ".release-ci", action === "prepare" ? "channel-state.json" : "distribution-evidence.json");
  const output = expectedStatus === 0 ? JSON.parse(readFileSync(evidence, "utf8")) : null;
  return { output, state, result, mock: JSON.parse(readFileSync(file, "utf8")), evidence };
}
function restore(overrides: Record<string, unknown> = {}, channelState = original) {
  const root = mkdtempSync(join(tmpdir(), "pf-restore-test-"));
  const bin = join(root, "bin"); const ci = join(root, ".release-ci"); mkdirSync(bin); mkdirSync(ci);
  const file = join(root, "mock.json");
  writeFileSync(file, JSON.stringify({ calls: [], npm_version: "0.9.41", image_digest: `sha256:${"c".repeat(64)}`, ...overrides }));
  mkdirSync(join(ci, "offline-channels"));
  mkdirSync(join(ci, "offline-image-publication"));
  writeFileSync(join(ci, "offline-channels", "channel-state.json"), JSON.stringify(channelState));
  writeFileSync(join(ci, "offline-image-publication", "image-publication.json"), JSON.stringify({ digest: `sha256:${"c".repeat(64)}` }));
  const fake = readFileSync(new URL("./fixtures/release/mock-cli.mjs", import.meta.url));
  for (const tool of ["gh", "npm", "docker"]) writeFileSync(join(bin, tool), fake, { mode: 0o755 });
  const env = mockEnv(bin, file);
  const result = spawnSync(process.execPath, distributionArgs("restore"), { cwd: root, env, encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  return { result, state: JSON.parse(readFileSync(file, "utf8")), receipt: join(ci, "restoration-receipt.json") };
}
test("restoration executes the OIDC dist-tag operation and restores both recorded pointers", () => {
  const { result, state, receipt } = restore();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.npm_version, "0.9.40");
  assert.equal(state.image_digest, original.previous.image_digest);
  assert.ok(state.calls.some((c: any) => c.tool === "npm" && c.args.join(" ") === "dist-tag add @pineforge/backtest-mcp@0.9.40 latest"));
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).recovery, "channels_restored");
});
for (const [name, overrides] of [
  ["newer npm publication", { npm_version: "0.9.42" }],
  ["unsupported npm CLI", { cli: "11.5.0" }],
  ["untrusted source workflow", { workflow: ".github/workflows/test.yml" }],
  ["newer image publication", { image_digest: `sha256:${"f".repeat(64)}` }],
] as Array<[string, Record<string, unknown>]>) {
  test(`RED: ${name} prevents any restoration mutation`, () => {
    const { result, state, receipt } = restore(overrides);
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(receipt));
    assert.ok(!state.calls.some((c: any) => c.tool === "npm" && c.args[0] === "dist-tag"));
    assert.ok(!state.calls.some((c: any) => c.tool === "docker" && c.args[2] === "create"));
  });
}
test("a missing npm trusted-publisher dist-tag permission fails and never reports recovery", () => {
  const { result, state, receipt } = restore({ deny_dist_tag: true });
  assert.notEqual(result.status, 0);
  assert.equal(state.npm_version, "0.9.41");
  assert.ok(!existsSync(receipt));
});
test("channel split: an npm dist-tag that does not take effect never retags GHCR", () => {
  const { result, mock, evidence } = distribute("promote", { previous: original.previous }, {
    npm_tags: { latest: original.previous.npm_version },
    responses: { [npmRegistry]: { npm_tags: true } },
    dist_tag_add_noop: "latest",
  }, 1);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(mock.npm_tags.latest, original.previous.npm_version);
  assert.deepEqual(mock.calls.filter((c: any) => c.tool === "npm" && c.args[0] === "dist-tag"), [
    { tool: "npm", args: ["dist-tag", "add", "@pineforge/backtest-mcp@0.9.41", "latest"] },
  ]);
  assert.ok(!mock.calls.some((c: any) => c.tool === "docker"
    && c.args.slice(0, 5).join(" ") === `buildx imagetools create --tag ${imageRepository}:latest`));
  assert.match(result.stderr, /npm channel not activated/);
  assert.equal(mock.elapsed, 600_000);
  assert.deepEqual(mock.sleeps, Array(60).fill(10_000));
  assert.ok(!existsSync(evidence));
});

test("channel split: a failed npm restore still retags GHCR to the previous digest and exits non-zero", () => {
  for (const failure of [
    { deny_dist_tag: true },
    { dist_tag_add_noop: "latest" },
    { deny_dist_tag: true, image_inspect_stdout: `Digest: sha256:${"c".repeat(64)}` },
  ]) {
    const { result, state, receipt } = restore({
      ...failure, events: [], npm_tags: { latest: original.version },
      responses: { [npmRegistry]: { npm_tags: true } },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(state.calls.filter((c: any) => c.tool === "docker" && c.args[2] === "create"), [
      { tool: "docker", args: ["buildx", "imagetools", "create", "--tag", `${imageRepository}:latest`,
        `${imageRepository}@${original.previous.image_digest}`] },
    ]);
    assert.equal(state.image_digest, original.previous.image_digest);
    assert.equal(state.npm_tags.latest, original.version);
    // One preflight plus 61 poll reads, including the read at the deadline.
    assert.equal(state.events.filter((e: any) => e.kind === "fetch" && e.url === npmRegistry).length, 62);
    assert.equal(state.elapsed, 600_000);
    assert.deepEqual(state.sleeps, Array(60).fill(10_000));
    assert.equal(state.calls.at(-1).args.join(" "), `buildx imagetools inspect ${imageRepository}:latest`);
    assert.match(result.stderr, /npm latest restoration failed:/);
    if ("image_inspect_stdout" in failure) {
      assert.match(result.stderr, /GHCR latest restoration failed:/);
      assert.match(result.stderr, /Error: channel restoration failed:[\s\S]*GHCR latest restoration failed:/);
    } else assert.match(result.stderr, /GHCR latest restoration succeeded/);
    assert.match(result.stderr, /Error: channel restoration failed: npm latest restoration failed:/);
    assert.ok(!existsSync(receipt));
  }
});

test("channel split: promote and restore happy paths are unchanged", () => {
  const promoted = distribute("promote", { previous: original.previous }, {
    events: [], npm_tags: { latest: original.previous.npm_version },
    responses: { [npmRegistry]: { npm_tags: true } },
  });
  const events = promoted.mock.events;
  const npmWrite = events.findIndex((e: any) => e.kind === "npm" && e.args[0] === "dist-tag");
  const npmRead = events.findIndex((e: any, i: number) => i > npmWrite
    && e.kind === "fetch" && e.url === npmRegistry && e.json["dist-tags"].latest === original.version);
  const imageWrite = events.findIndex((e: any) => e.kind === "docker" && e.args[2] === "create");
  assert.ok(npmWrite >= 0);
  assert.ok(npmRead > npmWrite);
  assert.ok(npmRead < imageWrite, "npm channel read-back must precede the GHCR retag");
  assert.equal(promoted.mock.npm_tags.latest, original.version);
  const mutations = (state: any) => state.calls.filter((c: any) =>
    (c.tool === "npm" && c.args[0] === "dist-tag") || (c.tool === "docker" && c.args[2] === "create")
    || (c.tool === "gh" && c.args.slice(0, 2).join(" ") === "release edit"));
  const publishedDigest = `sha256:${"c".repeat(64)}`;
  assert.deepEqual(mutations(promoted.mock), [
    { tool: "npm", args: ["dist-tag", "add", "@pineforge/backtest-mcp@0.9.41", "latest"] },
    { tool: "docker", args: ["buildx", "imagetools", "create", "--tag", `${imageRepository}:latest`,
      `${imageRepository}@${publishedDigest}`] },
    { tool: "gh", args: ["release", "edit", "v0.9.41", "--repo", "pineforge-4pass/pineforge-backtest-mcp", "--latest"] },
  ]);
  assert.equal(promoted.mock.image_digest, publishedDigest);
  const packageIntegrity = `sha512-${createHash("sha512").update("candidate packed package fixture\n").digest("base64")}`;
  const deployment = JSON.stringify({ channel: "latest", image: publishedDigest, integrity: packageIntegrity, version: "0.9.41" }) + "\n";
  assert.deepEqual(promoted.output, {
    event_id: "sha256:04fe43bf37933ae1061fe8a5235bb147a7b5b7eca15c0dde1ea55d62bd009a38",
    run_id: 77, run_attempt: 1, source: original.source_sha,
    deployed: { ...original.previous.identity, source: original.source_sha,
      deployment_id_sha256: createHash("sha256").update(deployment).digest("hex") },
    previous: original.previous.identity,
  });

  const restored = restore();
  assert.equal(restored.result.status, 0, restored.result.stderr);
  assert.equal(restored.state.npm_version, original.previous.npm_version);
  assert.equal(restored.state.image_digest, original.previous.image_digest);
  assert.deepEqual(mutations(restored.state), [
    { tool: "npm", args: ["dist-tag", "add", "@pineforge/backtest-mcp@0.9.40", "latest"] },
    { tool: "docker", args: ["buildx", "imagetools", "create", "--tag", `${imageRepository}:latest`,
      `${imageRepository}@${original.previous.image_digest}`] },
    { tool: "gh", args: ["release", "edit", "v0.9.40", "--repo", "pineforge-4pass/pineforge-backtest-mcp", "--latest"] },
  ]);
  const { completed_at, ...receipt } = JSON.parse(readFileSync(restored.receipt, "utf8"));
  assert.match(completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(receipt, {
    ...original, state: "failed", recovery: "channels_restored", restored: original.previous,
    cli: "11.21.0", authentication: "github-oidc",
    ...(process.env.GITHUB_RUN_ATTEMPT === undefined ? {} : { attempt: process.env.GITHUB_RUN_ATTEMPT }),
  });
});

test("channel split: a delayed npm channel becomes visible within the poll, then GHCR moves", () => {
  const { result, mock, output, evidence } = distribute("promote", { previous: original.previous }, {
    events: [], npm_tags: { latest: original.previous.npm_version }, dist_tag_lag_reads: 2,
    responses: { [npmRegistry]: { npm_tags: true } },
  });
  assert.equal(result.status, 0, result.stderr);
  const events = mock.events;
  const npmWrite = events.findIndex((e: any) => e.kind === "npm" && e.args[0] === "dist-tag");
  const reads = events.flatMap((e: any, i: number) => i > npmWrite && e.kind === "fetch" && e.url === npmRegistry
    ? [{ index: i, version: e.json["dist-tags"].latest }] : []);
  const imageWrites = events.flatMap((e: any, i: number) => e.kind === "docker" && e.args[2] === "create" ? [i] : []);
  assert.ok(npmWrite >= 0);
  assert.deepEqual(reads.map((r: any) => r.version), [
    original.previous.npm_version, original.previous.npm_version, original.version,
  ]);
  assert.equal(imageWrites.length, 1);
  assert.ok(reads.every((r: any) => r.index > npmWrite && r.index < imageWrites[0]),
    "every npm read-back must precede the single GHCR retag");
  assert.deepEqual(mock.npm_tag_visibility.latest, {
    previous: original.previous.npm_version, remaining: 0, reads: 3,
  });
  assert.deepEqual(mock.sleeps, [10_000, 10_000]);
  assert.equal(mock.elapsed, 20_000);
  assert.equal(mock.npm_tags.latest, original.version);
  const publishedDigest = `sha256:${"c".repeat(64)}`;
  assert.equal(mock.image_digest, publishedDigest);
  assert.deepEqual(mock.calls.filter((c: any) =>
    (c.tool === "npm" && c.args[0] === "dist-tag") || (c.tool === "docker" && c.args[2] === "create")
    || (c.tool === "gh" && c.args.slice(0, 2).join(" ") === "release edit")), [
    { tool: "npm", args: ["dist-tag", "add", "@pineforge/backtest-mcp@0.9.41", "latest"] },
    { tool: "docker", args: ["buildx", "imagetools", "create", "--tag", `${imageRepository}:latest`,
      `${imageRepository}@${publishedDigest}`] },
    { tool: "gh", args: ["release", "edit", "v0.9.41", "--repo", "pineforge-4pass/pineforge-backtest-mcp", "--latest"] },
  ]);
  assert.ok(existsSync(evidence));
  const packageIntegrity = `sha512-${createHash("sha512").update("candidate packed package fixture\n").digest("base64")}`;
  const deployment = JSON.stringify({ channel: "latest", image: publishedDigest, integrity: packageIntegrity, version: "0.9.41" }) + "\n";
  assert.deepEqual(output, {
    event_id: "sha256:04fe43bf37933ae1061fe8a5235bb147a7b5b7eca15c0dde1ea55d62bd009a38",
    run_id: 77, run_attempt: 1, source: original.source_sha,
    deployed: { ...original.previous.identity, source: original.source_sha,
      deployment_id_sha256: createHash("sha256").update(deployment).digest("hex") },
    previous: original.previous.identity,
  });
});

test("channel split: a delayed npm restore read-back is not reported as a failure", () => {
  const { result, state, receipt } = restore({
    events: [], npm_tags: { latest: original.version }, dist_tag_lag_reads: 2,
    responses: { [npmRegistry]: { npm_tags: true } },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "npm latest restoration succeeded\nGHCR latest restoration succeeded\n");
  assert.equal(state.npm_tags.latest, original.previous.npm_version);
  assert.equal(state.image_digest, original.previous.image_digest);
  const npmWrite = state.events.findIndex((e: any) => e.kind === "npm" && e.args[0] === "dist-tag");
  assert.ok(npmWrite >= 0);
  const reads = state.events.filter((e: any, i: number) => i > npmWrite && e.kind === "fetch" && e.url === npmRegistry);
  assert.deepEqual(reads.map((e: any) => e.json["dist-tags"].latest), [
    original.version, original.version, original.previous.npm_version,
  ]);
  assert.deepEqual(state.npm_tag_visibility.latest, { previous: original.version, remaining: 0, reads: 3 });
  assert.deepEqual(state.sleeps, [10_000, 10_000]);
  assert.equal(state.elapsed, 20_000);
  assert.deepEqual(state.calls.filter((c: any) =>
    (c.tool === "npm" && c.args[0] === "dist-tag") || (c.tool === "docker" && c.args[2] === "create")
    || (c.tool === "gh" && c.args.slice(0, 2).join(" ") === "release edit")), [
    { tool: "npm", args: ["dist-tag", "add", "@pineforge/backtest-mcp@0.9.40", "latest"] },
    { tool: "docker", args: ["buildx", "imagetools", "create", "--tag", `${imageRepository}:latest`,
      `${imageRepository}@${original.previous.image_digest}`] },
    { tool: "gh", args: ["release", "edit", "v0.9.40", "--repo", "pineforge-4pass/pineforge-backtest-mcp", "--latest"] },
  ]);
  assert.ok(existsSync(receipt));
  const { completed_at, ...recovery } = JSON.parse(readFileSync(receipt, "utf8"));
  assert.match(completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(recovery, {
    ...original, state: "failed", recovery: "channels_restored", restored: original.previous,
    cli: "11.21.0", authentication: "github-oidc",
    ...(process.env.GITHUB_RUN_ATTEMPT === undefined ? {} : { attempt: process.env.GITHUB_RUN_ATTEMPT }),
  });
});

test("a prior channel state cannot downgrade latest to a prerelease", () => {
  assert.doesNotThrow(() => validateChannelState(original));
  assert.throws(() => validateChannelState({ ...original, previous: { ...original.previous, npm_version: "0.9.40-rc.1" } }));
  assert.throws(() => validateChannelState({ ...original, previous: { ...original.previous, npm_version: "0.9.42" } }));
});

test("D2: channel state accepts only the exact five-key legacy identity and recorded pointers", () => {
  const state = { ...original, previous: legacyPrevious };
  assert.deepEqual(validateChannelState(state).previous.identity, legacy);
  for (const identity of [
    { ...legacy, event_id: original.event_id },
    { ...legacy, image_digest: undefined },
    { ...legacy, legacy: false },
    { ...legacy, npm_version: "0.9.39" },
    { ...legacy, image_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    { ...legacy, git_head: "" },
    { ...legacy, npm_integrity: "" },
    { ...original.previous.identity, invented: true },
    undefined,
  ]) assert.throws(() => validateChannelState({ ...state, previous: { ...state.previous, identity } }));
});

test("D2: channel state accepts a legacy previous with a null observed revision", () => {
  const state = { ...original, previous: { ...legacyPrevious, image_revision: null } };
  assert.equal(validateChannelState(state), state);
});

test("D2: channel state accepts a legacy previous with a 40-hex observed revision", () => {
  const state = { ...original, previous: legacyPrevious };
  assert.equal(validateChannelState(state), state);
  assert.notEqual(state.previous.image_revision, state.previous.identity.git_head);
});

test("D2: channel state refuses a legacy previous missing image_revision", () => {
  assert.throws(() => validateChannelState({
    ...original, previous: {
      npm_version: "0.9.40",
      image_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      identity: legacy,
    },
  }), { code: "ERR_ASSERTION", operator: "deepStrictEqual" });
});

for (const [label, revision] of [
  ["39-character", "f05d2565985710f72f56008dd12eaa013ca8a0e"],
  ["uppercase", "F05D2565985710F72F56008DD12EAA013CA8A0EB"],
  ["non-hex", "g05d2565985710f72f56008dd12eaa013ca8a0eb"],
  ["whitespace", " f05d2565985710f72f56008dd12eaa013ca8a0eb "],
  ["numeric", 123], ["empty-string", ""], ["undefined", undefined],
] as Array<[string, unknown]>) {
  test(`D2: channel state refuses a ${label} observed revision`, () => {
    assert.throws(() => validateChannelState({
      ...original, previous: { ...legacyPrevious, image_revision: revision },
    }), { code: "ERR_ASSERTION", operator: "match" });
  });
}

test("D2: channel state refuses an unknown extra key in a legacy previous", () => {
  assert.throws(() => validateChannelState({
    ...original, previous: { ...legacyPrevious, invented: true },
  }), { code: "ERR_ASSERTION", operator: "deepStrictEqual" });
});

test("D2: channel state refuses a six-key legacy identity even with a recorded revision", () => {
  assert.throws(() => validateChannelState({
    ...original, previous: { ...legacyPrevious, identity: { ...legacy, image_revision: legacyPrevious.image_revision } },
  }), { code: "ERR_ASSERTION", operator: "deepStrictEqual" });
});

test("D2: channel state accepts a post-lock previous without image_revision", () => {
  assert.equal(validateChannelState(original), original);
});

for (const [label, revision] of [
  ["null", null], ["40-hex", "f05d2565985710f72f56008dd12eaa013ca8a0eb"], ["undefined", undefined],
] as Array<[string, unknown]>) {
  test(`D2: channel state refuses a post-lock previous with ${label} image_revision`, () => {
    assert.throws(() => validateChannelState({
      ...original, previous: { ...original.previous, image_revision: revision },
    }), { code: "ERR_ASSERTION", operator: "deepStrictEqual" });
  });
}

test("D2: channel state refuses an unknown extra key in a post-lock previous", () => {
  assert.throws(() => validateChannelState({
    ...original, previous: { ...original.previous, invented: true },
  }), { code: "ERR_ASSERTION", operator: "deepStrictEqual" });
});

test("D2: restore uses legacy pointers from a snapshot with a recorded revision and five-key identity", () => {
  const channelState = { ...original, previous: legacyPrevious };
  const { result, state, receipt } = restore({}, channelState);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.calls.filter((c: any) => c.tool === "npm" && c.args[0] === "dist-tag").map((c: any) => c.args), [
    ["dist-tag", "add", "@pineforge/backtest-mcp@0.9.40", "latest"],
  ]);
  assert.deepEqual(state.calls.filter((c: any) => c.tool === "docker" && c.args[2] === "create").map((c: any) => c.args), [
    ["buildx", "imagetools", "create", "--tag", "ghcr.io/pineforge-4pass/pineforge-backtest-mcp:latest",
      "ghcr.io/pineforge-4pass/pineforge-backtest-mcp@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
  ]);
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")).restored.identity, legacy);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).restored.image_revision, "f05d2565985710f72f56008dd12eaa013ca8a0eb");
  const refused = restore({}, { ...channelState, previous: { ...channelState.previous, identity: { ...legacy, event_id: original.event_id } } });
  assert.notEqual(refused.result.status, 0);
  assert.ok(!existsSync(refused.receipt));
  assert.ok(!refused.state.calls.some((c: any) => c.tool === "npm" && c.args[0] === "dist-tag"));
  assert.ok(!refused.state.calls.some((c: any) => c.tool === "docker" && c.args[2] === "create"));
});

test("D2: prepare records TODAY's image revision beside the five-key legacy identity", () => {
  const { output, state } = distribute("prepare", {
    gitHead: "b988217f2aa21b6b772fb723adbc89bd4130c3f5",
    revisions: {
      amd64: "f05d2565985710f72f56008dd12eaa013ca8a0eb",
      arm64: "f05d2565985710f72f56008dd12eaa013ca8a0eb",
    },
  });
  assert.deepEqual(output.previous, {
    npm_version: "0.9.40", image_digest: state.image_digest,
    image_revision: "f05d2565985710f72f56008dd12eaa013ca8a0eb", identity: state.legacy,
  });
  assert.deepEqual(Object.keys(output.previous.identity).sort(), ["git_head", "image_digest", "legacy", "npm_integrity", "npm_version"]);
});

test("D2: prepare records null beside the five-key legacy identity when both image labels are absent", () => {
  const { output, state } = distribute("prepare", { omitLabels: true });
  assert.deepEqual(output.previous, {
    npm_version: "0.9.40", image_digest: state.image_digest, image_revision: null, identity: state.legacy,
  });
});

test("D2: prepare leaves image_revision absent for a post-lock previous", () => {
  const { output, state } = distribute("prepare", { modern: true });
  assert.deepEqual(output.previous, {
    npm_version: "0.9.40", image_digest: state.image_digest, identity: state.full,
  });
});

for (const [label, revision] of [
  ["40-hex", "f05d2565985710f72f56008dd12eaa013ca8a0eb"], ["null", null],
] as Array<[string, string | null]>) {
  test(`D2: promotion evidence carries a ${label} legacy revision beside the five-key identity`, () => {
    const { output } = distribute("promote", { previous: { ...legacyPrevious, image_revision: revision } });
    assert.deepEqual(output.previous, legacy);
    assert.equal(output.image_revision, revision);
    assert.deepEqual(Object.keys(output).sort(), ["deployed", "event_id", "image_revision", "previous", "run_attempt", "run_id", "source"]);
  });
}

test("D2: promotion evidence leaves image_revision absent for a post-lock previous", () => {
  const { output } = distribute("promote", { previous: original.previous });
  assert.deepEqual(output.previous, original.previous.identity);
  assert.deepEqual(Object.keys(output).sort(), ["deployed", "event_id", "previous", "run_attempt", "run_id", "source"]);
});
