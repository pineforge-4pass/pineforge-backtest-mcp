import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readLock, sha256 } from "./release-contract.mjs";

export function verifyEvidence(lock, inventory, evidence, source, run) {
  assert.equal(evidence.length, 4, "expected npm and image evidence for both architectures");
  for (const arch of ["amd64", "arm64"]) for (const mode of ["npm", "image"]) {
    const found = evidence.filter((e) => e.arch === arch && e.mode === mode);
    assert.equal(found.length, 1, `missing/duplicate ${arch}/${mode}`);
    const e = found[0];
    assert.equal(e.source_sha, source, "stale source evidence");
    assert.equal(String(e.run_id), String(run), "stale run evidence");
    assert.match(String(e.artifact_attempt), /^[1-9][0-9]*$/, "missing runtime attempt");
    assert.match(e.package_integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "missing tested package integrity");
    assert.equal(e.event_id, lock.event_id ?? null, "stale manifest evidence");
    assert.equal(e.hub_image, `${lock.image.repository}@${lock.image.digest}`, "wrong tested hub image");
    assert.equal(e.suites.length, Object.keys(inventory.suites).length, "incomplete suite inventory");
    for (const [suite, expected] of Object.entries(inventory.suites)) {
      assert.ok(Number.isInteger(expected) && expected > 0, "empty test inventory");
      const matches = e.suites.filter((s) => s.suite === suite);
      assert.equal(matches.length, 1, `missing/duplicate ${suite}`);
      assert.deepEqual(matches[0], { suite, expected, passed: expected, skipped: 0, result: "success" }, "required suite not successful");
    }
    if (mode === "image") assert.match(e.image_id, /^sha256:[0-9a-f]{64}$/);
  }
  return true;
}
export const integrity = (path) => `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const lock = readLock();
    const dir = ".release-ci";
    if (process.argv[2] === "package") {
      const pkg = JSON.parse(readFileSync("package.json"));
      const tar = `${dir}/pineforge-backtest-mcp-${pkg.version}.tgz`;
      writeFileSync(`${dir}/package.json`, JSON.stringify({ version: pkg.version, source_sha: process.env.GITHUB_SHA,
        run_id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
        event_id: lock.event_id ?? null, tar: tar.split("/").at(-1), integrity: integrity(tar), sha256: sha256(readFileSync(tar)) }, null, 2) + "\n");
    } else if (process.argv[2] === "gate") {
      const needs = JSON.parse(process.env.NEEDS_JSON);
      assert.deepEqual(Object.keys(needs).sort(), ["runtime", "test"]);
      for (const value of Object.values(needs)) assert.equal(value.result, "success", "missing, failed, cancelled or skipped required job");
      const inventoryBytes = readFileSync("test/fixtures/release/runtime-inventory.json");
      const inventory = JSON.parse(inventoryBytes);
      const evidence = readdirSync(dir).filter((f) => /^runtime-(amd64|arm64)-(npm|image)\.json$/.test(f)).map((f) => JSON.parse(readFileSync(`${dir}/${f}`)));
      verifyEvidence(lock, inventory, evidence, process.env.GITHUB_SHA, process.env.GITHUB_RUN_ID);
      for (const e of evidence) assert.equal(e.fixture_inventory_sha256, sha256(inventoryBytes));
      const pkg = JSON.parse(readFileSync(`${dir}/package.json`));
      assert.equal(pkg.integrity, integrity(`${dir}/${pkg.tar}`), "packed bytes changed");
      assert.equal(pkg.source_sha, process.env.GITHUB_SHA);
      assert.equal(pkg.event_id, lock.event_id ?? null);
      assert.equal(String(pkg.run_id), process.env.GITHUB_RUN_ID);
      for (const e of evidence) assert.equal(e.package_integrity, pkg.integrity, "runtime tested another npm tarball");
      const receipt = { role: "offline", state: "ready", event_id: lock.event_id ?? null,
        manifest_sha256: lock.manifest?.sha256 ?? null, source_sha: process.env.GITHUB_SHA,
        head_sha: process.env.PR_HEAD_SHA || process.env.GITHUB_SHA, base_sha: process.env.PR_BASE_SHA || null,
        pr: process.env.PR_NUMBER || null, run_id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
        expected_jobs: ["test", "runtime (amd64)", "runtime (arm64)"], approved_skips: [],
        package: pkg, runtime: evidence, facts: lock.facts ?? null, completed_at: new Date().toISOString() };
      writeFileSync(`${dir}/gate-receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
    } else throw Error("expected package or gate");
  } catch (e) { console.error(e); process.exitCode = 1; }
}
