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
  version: "0.9.41", channel: "latest", previous: { npm_version: "0.9.40", image_digest: `sha256:${"d".repeat(64)}` },
};
function restore(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pf-restore-test-"));
  const bin = join(root, "bin"); const ci = join(root, ".release-ci"); mkdirSync(bin); mkdirSync(ci);
  const file = join(root, "mock.json");
  writeFileSync(file, JSON.stringify({ calls: [], npm_version: "0.9.41", image_digest: `sha256:${"c".repeat(64)}`, ...overrides }));
  mkdirSync(join(ci, "offline-channels"));
  mkdirSync(join(ci, "offline-image-publication"));
  writeFileSync(join(ci, "offline-channels", "channel-state.json"), JSON.stringify(original));
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
