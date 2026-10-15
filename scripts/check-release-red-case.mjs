// CI-only mutation witness: restoring the former floating npm default must
// turn the real lock regression red. Always restore the source afterwards.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const path = "src/engine.ts";
const original = readFileSync(path, "utf8");
const line = 'export const DEFAULT_IMAGE = process.env.PINEFORGE_IMAGE ?? HUB_IMAGE;';
assert.ok(original.includes(line), "cannot locate the runtime default for the red witness");
const env = { ...process.env }; delete env.PINEFORGE_IMAGE;
mkdirSync(".release-ci", { recursive: true });
try {
  writeFileSync(path, original.replace(line, 'export const DEFAULT_IMAGE = process.env.PINEFORGE_IMAGE ?? "ghcr.io/pineforge-4pass/pineforge-release:latest";'));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap",
    "--test-name-pattern=^RED: an npm package", "test/release-contract.test.ts"], { env, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  writeFileSync(".release-ci/default-pin-red.tap", output);
  assert.equal(result.status, 1, `removing the pin did not fail the actual regression:\n${output}`);
  assert.match(output, /pineforge-release:latest/);
  assert.match(output, /AssertionError|ERR_ASSERTION/);
  writeFileSync(".release-ci/default-pin-red-proof.json", JSON.stringify({
    role: "offline", source_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID,
    mutation: "restore-former-floating-default", expected_exit: 1, actual_exit: result.status,
  }, null, 2) + "\n");
} finally { writeFileSync(path, original); }
