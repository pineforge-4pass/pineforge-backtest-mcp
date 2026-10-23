import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-ignore workflow module.
import { buildReceipt, canonical, checkEvidence, consumerSignal, RECEIPT_POLICY, servedIdentity, validateServedIdentity } from "../scripts/release-receipt.mjs";
// @ts-ignore workflow module.
import { publicationAction, terminalRestart } from "../scripts/release-consumer.mjs";

const lock = JSON.parse(readFileSync(new URL("./fixtures/release/release-ready-v1.json", import.meta.url), "utf8"));
const legacy = JSON.parse(readFileSync(new URL("./fixtures/release/legacy-identity.json", import.meta.url), "utf8"));
const repo = "pineforge-4pass/pineforge-backtest-mcp";
const head = "1".repeat(40), merge = "2".repeat(40), base = "3".repeat(40);
function sample() {
  const ciRun = { id: 11, run_attempt: 1, path: ".github/workflows/test.yml", head_sha: head, status: "completed", conclusion: "success" };
  const deployRun = { ...ciRun, id: 12, path: ".github/workflows/publish.yml", head_sha: merge };
  const ciJobs = RECEIPT_POLICY.ci.expected.map((name: string) => ({ name, status: "completed", conclusion: "success", completed_at: "2020-01-01T00:04:00Z" }));
  const deployJobs = RECEIPT_POLICY.deploy.expected.map((name: string) => ({ name, status: "completed",
    conclusion: ["restore", "report-failure"].includes(name) ? "skipped" : "success", completed_at: "2020-01-01T00:06:00Z" }));
  const ci = checkEvidence(ciRun, ciJobs, RECEIPT_POLICY.ci, head);
  const deploy = checkEvidence(deployRun, deployJobs, RECEIPT_POLICY.deploy, merge);
  const receipt = buildReceipt(lock, { state: "verified", attempt: 90, sequence: 1, timestamp: "2020-01-01T00:07:00Z",
    pr: { number: 9, base: "main", base_sha: base, head, merge }, ci, e2e: ci, deploy,
    preview: servedIdentity(lock, head, { synthetic: "preview" }),
    deployed: servedIdentity(lock, merge, { synthetic: "distribution" }),
    previous: servedIdentity(lock, "4".repeat(40), { synthetic: "previous" }) });
  return { receipt, event: lock, policy: RECEIPT_POLICY, repo,
    reporting_run: { id: 90, path: ".github/workflows/release-pr.yml", event: "workflow_dispatch", head_sha: merge },
    api: {
      [`repos/${repo}/pulls/9`]: { base: { ref: "main", sha: base }, head: { sha: head, repo: { full_name: repo } },
        merged: true, merge_commit_sha: merge, merged_at: "2020-01-01T00:05:00Z" },
      [`repos/${repo}/commits/${merge}`]: { parents: [{ sha: base }] },
      [`repos/${repo}/actions/runs/11/attempts/1`]: ciRun,
      [`repos/${repo}/actions/runs/11/attempts/1/jobs?per_page=100&page=1`]: { jobs: ciJobs },
      [`repos/${repo}/actions/runs/12/attempts/1`]: deployRun,
      [`repos/${repo}/actions/runs/12/attempts/1/jobs?per_page=100&page=1`]: { jobs: deployJobs },
    } as Record<string, any> };
}
function hubValidate(data: any) {
  return spawnSync("python3", [fileURLToPath(new URL("./fixtures/release/hub-receipt-validator.py", import.meta.url))], {
    input: canonical(data), encoding: "utf8",
  });
}

test("the consumer's complete sample passes the hub's actual field, archive and GitHub evidence checks", () => {
  const data = sample();
  const result = hubValidate(data);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "verified");
  assert.equal(JSON.parse(result.stdout).reporting_run_id, 90);
  assert.deepEqual(data.receipt, JSON.parse(readFileSync(new URL("./fixtures/release/receipt-v1.json", import.meta.url), "utf8")));
  assert.equal(canonical(JSON.parse(canonical(data.receipt))), canonical(data.receipt));
  assert.doesNotMatch(canonical(data.receipt), /https?:|repository|token|raw_deployment/);
});

for (const [name, mutate] of [
  ["custom receipt fields", (d: any) => { d.receipt.manifest_sha256 = "a".repeat(64); }],
  ["numeric strings", (d: any) => { d.receipt.attempt = "90"; }],
  ["boolean integers", (d: any) => { d.receipt.ci.run_id = true; }],
  ["unknown state", (d: any) => { d.receipt.state = "complete"; }],
  ["PR-head reporter", (d: any) => { d.reporting_run.event = "pull_request"; }],
  ["wrong reporting source", (d: any) => { d.reporting_run.head_sha = head; }],
  ["wrong reporting workflow", (d: any) => { d.reporting_run.path = ".github/workflows/publish.yml"; }],
  ["unapproved runtime skip", (d: any) => { d.api[`repos/${repo}/actions/runs/11/attempts/1/jobs?per_page=100&page=1`].jobs[1].conclusion = "skipped"; }],
  ["missing deploy verification", (d: any) => { d.api[`repos/${repo}/actions/runs/12/attempts/1/jobs?per_page=100&page=1`].jobs.pop(); }],
  ["E2E after merge", (d: any) => { d.api[`repos/${repo}/actions/runs/11/attempts/1/jobs?per_page=100&page=1`].jobs[0].completed_at = "2020-01-01T00:06:00Z"; }],
  ["different tested base", (d: any) => { d.api[`repos/${repo}/commits/${merge}`].parents[0].sha = "5".repeat(40); }],
  ["wrong served image", (d: any) => { d.receipt.deployed.image_digest = `sha256:${"5".repeat(64)}`; }],
  ["missing rollback identity", (d: any) => { d.receipt.previous = null; }],
  ["receipt before deploy verification", (d: any) => { d.receipt.timestamp = "2020-01-01T00:05:00Z"; }],
  ["extra archive file", (d: any) => { d.archive_names = ["release-receipt.json", "private.json"]; }],
] as Array<[string, (data: any) => void]>) {
  test(`hub rejects ${name}`, () => {
    const data = sample(); mutate(data);
    assert.notEqual(hubValidate(data).status, 0);
  });
}

test("pending and failed snapshots retain exactly the contract's null evidence fields", () => {
  for (const state of ["pending", "failed", "superseded"]) {
    const data = sample();
    data.receipt = buildReceipt(lock, { state, attempt: 90, sequence: 1, timestamp: "2020-01-01T00:07:00Z" });
    for (const key of ["pr", "ci", "e2e", "deploy", "preview", "deployed", "previous"]) assert.equal(data.receipt[key], null);
    const result = hubValidate(data);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("the callback has exactly four keys and identifies the reporting artifact run", () => {
  const signal = consumerSignal(sample().receipt, 90);
  assert.deepEqual(signal, { schema: "pineforge/consumer-signal/v1", consumer: "offline", release_version: lock.release_version, run_id: 90 });
  assert.throws(() => consumerSignal(sample().receipt, "90"));
  assert.throws(() => consumerSignal(sample().receipt, 11));
});

test("the shared deploy skip inventory cannot exempt stable releases from the Registry gate", () => {
  const receipt = sample().receipt;
  receipt.deploy.results["mcp-registry"] = "skipped";
  assert.throws(() => buildReceipt(lock, receipt));
});

test("cancelled and missing tag publications are retriggered; active/successful/failed runs are not rebuilt", () => {
  assert.equal(publicationAction([]), "dispatch");
  assert.equal(publicationAction([{ id: 1, status: "completed", conclusion: "cancelled" }]), "dispatch");
  assert.equal(publicationAction([{ id: 1, status: "queued", conclusion: null }]), "wait");
  assert.equal(publicationAction([{ id: 1, status: "completed", conclusion: "success" }]), "report");
  assert.equal(publicationAction([{ id: 1, status: "completed", conclusion: "failure" }]), "failed");
});

test("a terminal-state retry requires a fresh reporting attempt, while verified reruns remain verified", () => {
  const data: any = sample();
  data.receipt.sequence = 2;
  data.previous_receipt = { attempt: 90, sequence: 1, state: "failed" };
  assert.equal(terminalRestart(data.previous_receipt.state), true);
  assert.notEqual(hubValidate(data).status, 0, "a sequence bump cannot restart a failed attempt");
  data.previous_receipt.attempt = 89;
  const restarted = hubValidate(data);
  assert.equal(restarted.status, 0, restarted.stderr);
  data.previous_receipt.state = "verified";
  assert.equal(terminalRestart(data.previous_receipt.state), false);
  data.receipt = buildReceipt(lock, { state: "pending", attempt: 90, sequence: 2, timestamp: "2020-01-01T00:07:00Z" });
  assert.notEqual(hubValidate(data).status, 0, "verified cannot regress even with a larger attempt");
});

function legacySample() {
  const data = sample();
  data.receipt = buildReceipt(lock, { ...data.receipt, previous: legacy });
  assert.deepEqual(data.receipt.previous, legacy);
  assert.deepEqual(JSON.parse(canonical(data.receipt)).previous, legacy);
  return data;
}
test("D2: validateServedIdentity accepts legacy only with previous true", () => {
  assert.equal(validateServedIdentity(legacy, { previous: true }), legacy);
  const identityShapeRejection = (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.equal(error.code, "ERR_ASSERTION");
    assert.equal(error.operator, "deepStrictEqual");
    assert.deepEqual(error.actual, ["git_head", "image_digest", "legacy", "npm_integrity", "npm_version"]);
    assert.deepEqual(error.expected, ["deployment_id_sha256", "facts_commit", "facts_sha256", "image_digest", "source"]);
    return true;
  };
  assert.throws(() => validateServedIdentity(legacy), identityShapeRejection);
  assert.throws(() => validateServedIdentity(legacy, { previous: false }), identityShapeRejection);
});
test("D2: receipt writer and extended verifier preserve exactly the legacy predecessor", () => {
  const result = hubValidate(legacySample());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).previous, legacy);
});
for (const [label, identity] of [
  ["invented field", { ...legacy, event_id: lock.event_id }],
  // The key is absent, not undefined: canonical() refuses an undefined value before the hub check runs.
  ["missing digest", Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "image_digest"))],
  ["false legacy marker", { ...legacy, legacy: false }],
  ["legacy preview", legacy],
  ["legacy deployed", legacy],
] as Array<[string, any]>) {
  test(`D2: receipt writer and extended verifier refuse ${label}`, () => {
    const data = legacySample();
    const field = label === "legacy preview" ? "preview" : label === "legacy deployed" ? "deployed" : "previous";
    assert.throws(() => buildReceipt(lock, { ...data.receipt, [field]: identity }));
    data.receipt[field] = identity;
    assert.notEqual(hubValidate(data).status, 0);
  });
}
