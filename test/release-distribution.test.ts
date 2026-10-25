import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// @ts-ignore workflow module.
import { validateChannelState } from "../scripts/distribution.mjs";
const original = {
  role: "offline", event_id: `sha256:${"a".repeat(64)}`, source_sha: "b".repeat(40), run_id: 77,
  version: "0.9.41", channel: "latest", previous: {
    npm_version: "0.9.40", image_digest: `sha256:${"d".repeat(64)}`,
    identity: JSON.parse(readFileSync(new URL("./fixtures/release/receipt-v1.json", import.meta.url), "utf8")).previous,
  },
};
const legacy = JSON.parse(readFileSync(new URL("./fixtures/release/legacy-identity.json", import.meta.url), "utf8"));
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
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PF_MOCK_STATE: file,
    NODE_OPTIONS: `--import=${new URL("./fixtures/release/mock-registry.mjs", import.meta.url).href}`,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: String(process.pid),
    RESTORE_SOURCE_RUN: "77", GITHUB_REPOSITORY: "pineforge-4pass/pineforge-backtest-mcp" };
  delete (env as Record<string, string | undefined>).NODE_AUTH_TOKEN;
  delete (env as Record<string, string | undefined>).NPM_TOKEN;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/distribution.mjs", import.meta.url)), "restore"], { cwd: root, env, encoding: "utf8" });
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
test("a prior channel state cannot downgrade latest to a prerelease", () => {
  assert.doesNotThrow(() => validateChannelState(original));
  assert.throws(() => validateChannelState({ ...original, previous: { ...original.previous, npm_version: "0.9.40-rc.1" } }));
  assert.throws(() => validateChannelState({ ...original, previous: { ...original.previous, npm_version: "0.9.42" } }));
});

test("D2: channel state accepts only the exact six-key legacy identity and recorded pointers", () => {
  const state = { ...original, previous: { ...original.previous, identity: legacy } };
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

test("D2: channel state refuses a stale five-key legacy identity", () => {
  const { image_revision, ...stale } = legacy;
  assert.throws(() => validateChannelState({
    ...original, previous: { ...original.previous, identity: stale },
  }), { code: "ERR_ASSERTION", operator: "deepStrictEqual" });
});

test("D2: restore uses six-key legacy npm version and image digest and refuses invented identity fields", () => {
  const channelState = { ...original, previous: { ...original.previous, identity: legacy } };
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
  const refused = restore({}, { ...channelState, previous: { ...channelState.previous, identity: { ...legacy, event_id: original.event_id } } });
  assert.notEqual(refused.result.status, 0);
  assert.ok(!existsSync(refused.receipt));
  assert.ok(!refused.state.calls.some((c: any) => c.tool === "npm" && c.args[0] === "dist-tag"));
  assert.ok(!refused.state.calls.some((c: any) => c.tool === "docker" && c.args[2] === "create"));
});
