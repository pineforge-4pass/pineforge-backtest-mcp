// The sole hub-facing format: Consumer receipt contract v1. Only the trusted
// release-pr coordinator writes/uploads it; PR CI supplies internal evidence.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { HUB, sha256, validateReady } from "./release-contract.mjs";
import { parseVersion } from "./release-version.mjs";

export const RECEIPT_FILE = ".release-ci/release-receipt.json";
const checks = ["test", "runtime (amd64)", "runtime (arm64)", "release/ready"];
export const RECEIPT_POLICY = {
  workflow: "release-pr.yml", artifact: "release-receipt-offline", base: "main",
  ci: { workflow: "test.yml", expected: checks, approved_skips: [] },
  e2e: { workflow: "test.yml", expected: checks, approved_skips: [] },
  deploy: { workflow: "publish.yml", expected: [
    ...checks.map((name) => `gates / ${name}`), "prepare", "image", "publish",
    "mcp-registry", "release", "promote", "restore", "report-failure",
  ], approved_skips: ["mcp-registry", "restore", "report-failure"] },
};
export const positive = (value) => {
  assert.ok(Number.isSafeInteger(value) && value > 0, "expected a positive JSON safe integer");
  return value;
};
export function canonical(value) {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x !== null && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    assert.ok(x !== undefined && (typeof x !== "number" || Number.isFinite(x)), "invalid JSON value");
    return x;
  };
  return JSON.stringify(sort(value)) + "\n";
}
export function servedIdentity(lock, source, distribution) {
  validateReady(lock);
  assert.match(source, /^[0-9a-f]{40}$/);
  return { source, image_digest: lock.image.digest, facts_commit: lock.facts.commit,
    facts_sha256: lock.facts.sha256, deployment_id_sha256: sha256(canonical(distribution)) };
}
export function validateServedIdentity(row, { previous = false } = {}) {
  assert.ok(row && typeof row === "object" && !Array.isArray(row), "expected served identity");
  if (previous && row.legacy === true) {
    assert.deepEqual(Object.keys(row).sort(), ["legacy", "npm_version", "npm_integrity", "git_head", "image_digest"].sort());
    parseVersion(row.npm_version);
    assert.ok(!row.npm_version.startsWith("v"));
    assert.match(row.npm_integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.match(row.git_head, /^[0-9a-f]{40}$/);
    assert.match(row.image_digest, /^sha256:[0-9a-f]{64}$/);
  } else {
    assert.deepEqual(Object.keys(row).sort(), ["source", "image_digest", "facts_commit", "facts_sha256", "deployment_id_sha256"].sort());
    assert.match(row.source, /^[0-9a-f]{40}$/);
    assert.match(row.image_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(row.facts_commit, /^[0-9a-f]{40}$/);
    for (const key of ["facts_sha256", "deployment_id_sha256"]) assert.match(row[key], /^[0-9a-f]{64}$/);
  }
  return row;
}
export function checkEvidence(run, jobs, policy, source) {
  assert.equal(run.path, `.github/workflows/${policy.workflow}`);
  assert.equal(run.head_sha, source, "checks ran on another source");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success", "required workflow did not succeed");
  const results = {};
  for (const name of policy.expected) {
    const found = jobs.filter((job) => job.name === name);
    assert.equal(found.length, 1, `missing/duplicate required job: ${name}`);
    assert.equal(found[0].status, "completed");
    const result = found[0].conclusion;
    assert.ok(result === "success" || (result === "skipped" && policy.approved_skips.includes(name)), `unsuccessful required job: ${name}`);
    if (result === "success") assert.match(found[0].completed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    results[name] = result;
  }
  return { run_id: positive(run.id), run_attempt: positive(run.run_attempt), sha: source,
    expected: [...policy.expected], approved_skips: [...policy.approved_skips], results };
}
export function buildReceipt(lock, { state, attempt, sequence, timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  pr = null, ci = null, e2e = null, deploy = null, preview = null, deployed = null, previous = null }) {
  validateReady(lock);
  assert.ok(["pending", "pr_open", "testing", "ready", "merged", "deploying", "verified", "failed", "superseded", "skipped_by_policy"].includes(state));
  assert.match(timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const receipt = { schema: "pineforge/consumer-receipt/v1", consumer: "offline", event_id: lock.event_id,
    release_version: lock.release_version, attempt: positive(attempt), sequence: positive(sequence), state, timestamp,
    pr, ci, e2e, deploy, preview, deployed, previous };
  // Explicit projection prevents internal diagnostics, URLs and deployment IDs
  // from being serialized into the hub-facing artifact.
  if (pr) receipt.pr = { number: positive(pr.number), base: pr.base, base_sha: pr.base_sha, head: pr.head, merge: pr.merge };
  if (pr) {
    assert.equal(pr.base, RECEIPT_POLICY.base);
    for (const key of ["base_sha", "head"]) assert.match(pr[key], /^[0-9a-f]{40}$/);
    if (pr.merge !== null) assert.match(pr.merge, /^[0-9a-f]{40}$/);
  }
  for (const name of ["ci", "e2e", "deploy"]) if (receipt[name]) {
    const row = receipt[name], policy = RECEIPT_POLICY[name];
    assert.deepEqual(row.expected, policy.expected);
    assert.deepEqual(row.approved_skips, policy.approved_skips);
    assert.deepEqual(Object.keys(row.results).sort(), [...policy.expected].sort());
    for (const [job, result] of Object.entries(row.results)) assert.ok(result === "success" || (result === "skipped" && policy.approved_skips.includes(job)));
    receipt[name] = { run_id: positive(row.run_id), run_attempt: positive(row.run_attempt), sha: row.sha,
      expected: [...row.expected], approved_skips: [...row.approved_skips], results: { ...row.results } };
    assert.equal(row.sha, name === "deploy" ? pr?.merge : pr?.head);
  }
  for (const name of ["preview", "deployed", "previous"]) if (receipt[name]) {
    const row = receipt[name];
    if (name === "previous") validateServedIdentity(row, { previous: true });
    if (name === "previous" && row.legacy === true) {
      receipt[name] = { ...row };
      continue;
    }
    receipt[name] = { source: row.source, image_digest: row.image_digest, facts_commit: row.facts_commit,
      facts_sha256: row.facts_sha256, deployment_id_sha256: row.deployment_id_sha256 };
    assert.match(row.source, /^[0-9a-f]{40}$/);
    assert.match(row.image_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(row.facts_commit, /^[0-9a-f]{40}$/);
    for (const key of ["facts_sha256", "deployment_id_sha256"]) assert.match(row[key], /^[0-9a-f]{64}$/);
  }
  if (!["pending", "failed", "superseded", "skipped_by_policy"].includes(state)) assert.ok(receipt.pr);
  if (["ready", "merged", "deploying", "verified"].includes(state)) {
    assert.ok(receipt.ci && receipt.e2e && receipt.preview);
    assert.equal(receipt.preview.source, pr.head);
    assert.equal(receipt.preview.image_digest, lock.image.digest);
  }
  if (["merged", "deploying", "verified"].includes(state)) assert.match(pr.merge, /^[0-9a-f]{40}$/);
  if (state === "verified") {
    assert.ok(receipt.deploy && receipt.deployed && receipt.previous);
    assert.equal(receipt.deploy.results["mcp-registry"], lock.prerelease ? "skipped" : "success");
    assert.equal(receipt.deployed.source, pr.merge);
    assert.equal(receipt.deployed.image_digest, lock.image.digest);
  }
  if (state === "skipped_by_policy") assert.equal(lock.prerelease, true);
  return receipt;
}
export function writeReceipt(lock, evidence) {
  const receipt = buildReceipt(lock, { ...evidence, attempt: Number(process.env.GITHUB_RUN_ID), sequence: Number(process.env.GITHUB_RUN_ATTEMPT) });
  mkdirSync(".release-ci", { recursive: true });
  const bytes = canonical(receipt);
  assert.ok(Buffer.byteLength(bytes) <= 2 * 1024 * 1024);
  writeFileSync(RECEIPT_FILE, bytes);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "receipt=true\n");
  return receipt;
}
export function consumerSignal(receipt, run) {
  assert.equal(receipt.schema, "pineforge/consumer-receipt/v1");
  assert.equal(receipt.consumer, "offline");
  assert.equal(receipt.attempt, positive(run), "callback must identify the reporting run");
  return { schema: "pineforge/consumer-signal/v1", consumer: "offline", release_version: receipt.release_version, run_id: run };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    assert.equal(process.argv[2], "signal");
    const receipt = JSON.parse(readFileSync(RECEIPT_FILE, "utf8"));
    execFileSync("gh", ["api", "--method", "POST", `repos/${HUB}/dispatches`, "--input", "-"], {
      input: canonical({ event_type: "pineforge-release-status", client_payload: consumerSignal(receipt, Number(process.env.GITHUB_RUN_ID)) }), stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
