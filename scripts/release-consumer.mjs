// Runs from trusted main for receiver/merge transitions, never PR-supplied code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { api, gh, readLock, validateReady, verifyArtifacts, downloadManifest, verifyManifest } from "./release-contract.mjs";
import { compareVersions, nextVersion } from "./release-version.mjs";
import { chooseArtifact } from "./release-artifacts.mjs";
import { verifyEvidence } from "./release-evidence.mjs";
import { RECEIPT_POLICY, checkEvidence, servedIdentity, writeReceipt } from "./release-receipt.mjs";

export const ALLOWED = ["VERSION", "package.json", "package-lock.json", "server.json", "release-lock.json", "release-manifest.json"];
const PREFIX = "bot/pineforge-release/main/";
let activeLock, priorSnapshot;
const REPO = process.env.GITHUB_REPOSITORY ?? "pineforge-4pass/pineforge-backtest-mcp";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, x) => writeFileSync(path, JSON.stringify(x, null, 2) + "\n");
const mutate = (method, path, body = {}) => JSON.parse(execFileSync("gh", ["api", "--method", method, path, "--input", "-"], { encoding: "utf8", input: JSON.stringify(body) }));
const pages = (path) => JSON.parse(gh("api", "--paginate", "--slurp", path));
const prList = () => pages(`repos/${REPO}/pulls?state=open&base=main&per_page=100`).flat().filter((p) => p.head.repo?.full_name === REPO && p.head.ref.startsWith(PREFIX));
export function marker(body) {
  const m = body?.match(/<!-- pineforge-release (\{[^\n]*\}) -->/);
  assert.ok(m, "missing machine-readable event marker");
  const x = JSON.parse(m[1]);
  assert.match(x.event_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(x.base, "main");
  assert.ok(Number.isSafeInteger(x.delivery_run) && x.delivery_run > 0);
  return x;
}
export function decision(current, incoming, desired = []) {
  validateReady(incoming);
  const pins = [current, ...desired].filter(Boolean);
  if (pins.some((p) => compareVersions(p.release_version, incoming.release_version) > 0)) return "superseded";
  for (const pin of pins) {
    const order = compareVersions(pin.release_version, incoming.release_version);
    if (order > 0) return "superseded";
    if (order === 0) {
      assert.equal(pin.event_id, incoming.event_id, "same release has a different immutable manifest");
      return "duplicate";
    }
  }
  return "new";
}
function lockAt(ref) { return JSON.parse(git("show", `${ref}:release-lock.json`)); }
const jobsFor = (run) => pages(`repos/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).flatMap((p) => p.jobs);
const artifactsFor = (run) => pages(`repos/${REPO}/actions/runs/${run}/artifacts?per_page=100`).flatMap((p) => p.artifacts);
function existingSnapshot(run) {
  if (!artifactsFor(run).some((a) => a.name === RECEIPT_POLICY.artifact && !a.expired)) return null;
  const dir = mkdtempSync(join(tmpdir(), "pf-snapshot-"));
  gh("run", "download", String(run), "--repo", REPO, "--name", RECEIPT_POLICY.artifact, "--dir", dir);
  return json(join(dir, "release-receipt.json"));
}
function finalReportsFor(source) {
  return pages(`repos/${REPO}/actions/workflows/release-pr.yml/runs?event=workflow_dispatch&head_sha=${source}&per_page=100`)
    .flatMap((p) => p.workflow_runs).filter((run) => run.head_sha === source && run.display_title.startsWith("Offline receipt for publisher "));
}
function preserveVerifiedReport(source) {
  for (const run of finalReportsFor(source)) {
    const artifact = artifactsFor(run.id).find((a) => a.name === RECEIPT_POLICY.artifact);
    // Expired evidence may already have been collected; its absence is never
    // grounds for inventing a later failure or restarting this distribution.
    if (artifact?.expired || (!artifact && run.run_attempt === 1 && run.conclusion === "success")) return true;
    if (artifact && existingSnapshot(run.id)?.state === "verified") return true;
  }
  return false;
}
export const terminalRestart = (state) => ["failed", "superseded", "skipped_by_policy"].includes(state);
function restartTerminalRerun() {
  if (!(Number(process.env.GITHUB_RUN_ATTEMPT) > 1)) return false;
  priorSnapshot = existingSnapshot(process.env.GITHUB_RUN_ID);
  if (!terminalRestart(priorSnapshot?.state)) return false;
  // The hub forbids restarting a terminal state within one consumer attempt.
  // A fresh workflow run supplies a larger run ID; rerunning jobs does not.
  const args = ["workflow", "run", "release-pr.yml", "--repo", REPO, "--ref"];
  if (process.env.PUBLISHER_RUN_ID) {
    assert.match(process.env.PUBLISHER_RUN_ID, /^[1-9][0-9]*$/);
    const publisher = api(`repos/${REPO}/actions/runs/${process.env.PUBLISHER_RUN_ID}`);
    const { tag } = trustedPublisher(publisher);
    args.push(tag, "--field", `publisher_run_id=${publisher.id}`);
  } else args.push("main");
  gh(...args);
  return true;
}
function identity() {
  const login = process.env.RELEASE_BOT_LOGIN;
  assert.match(login ?? "", /^[A-Za-z0-9-]+\[bot\]$/);
  const user = api(`users/${encodeURIComponent(login)}`);
  git("config", "user.name", login);
  git("config", "user.email", `${user.id}+${login}@users.noreply.github.com`);
  return login;
}
function safePR(p) {
  assert.equal(p.base.ref, "main");
  assert.equal(p.head.repo.full_name, REPO);
  assert.ok(p.head.ref.startsWith(PREFIX));
  const m = marker(p.body);
  const commits = api(`repos/${REPO}/pulls/${p.number}/commits?per_page=100`);
  assert.ok(commits.length > 0 && commits.length < 100, "unexpected commit inventory");
  for (const c of commits) assert.equal(c.author?.login, process.env.RELEASE_BOT_LOGIN, "human/unknown commits on bot branch; refusing to modify/merge");
  const files = api(`repos/${REPO}/pulls/${p.number}/files?per_page=100`);
  assert.ok(files.length > 0 && files.length <= ALLOWED.length);
  for (const f of files) { assert.ok(ALLOWED.includes(f.filename), `unexpected PR file ${f.filename}`); assert.notEqual(f.status, "removed"); }
  git("fetch", "origin", p.head.sha);
  assert.equal(git("rev-parse", "FETCH_HEAD"), p.head.sha);
  const lock = lockAt("FETCH_HEAD"); validateReady(lock);
  assert.equal(lock.event_id, m.event_id, "PR marker and committed lock disagree");
  assert.equal(lock.release_version, m.release_version);
  verifyManifest(lock, Buffer.from(execFileSync("git", ["show", "FETCH_HEAD:release-manifest.json"])));
  return lock;
}
function trustedPublisher(publisher) {
  // Validate the workflow definition's ref BEFORE dispatching a privileged
  // reporter on it, rather than trusting a publisher's name/status alone.
  assert.equal(publisher.path, ".github/workflows/publish.yml");
  assert.ok(["push", "workflow_dispatch"].includes(publisher.event));
  assert.match(publisher.head_sha, /^[0-9a-f]{40}$/);
  git("fetch", "origin", "main", "--tags");
  git("fetch", "origin", publisher.head_sha);
  git("merge-base", "--is-ancestor", publisher.head_sha, "origin/main");
  const lock = validateReady(lockAt(publisher.head_sha));
  const version = git("show", `${publisher.head_sha}:VERSION`), tag = `v${version}`;
  assert.equal(publisher.head_branch, tag);
  assert.equal(publisher.display_title, `Offline publish ${tag}`);
  const ref = api(`repos/${REPO}/git/ref/tags/${tag}`).object;
  assert.equal(ref.type, "tag");
  const annotated = api(`repos/${REPO}/git/tags/${ref.sha}`);
  assert.equal(annotated.object.type, "commit");
  assert.equal(annotated.object.sha, publisher.head_sha);
  assert.ok(annotated.message.split("\n").includes(`event_id=${lock.event_id}`));
  const prs = api(`repos/${REPO}/commits/${publisher.head_sha}/pulls`);
  const row = prs.find((p) => p.merged_at && p.merge_commit_sha === publisher.head_sha && p.base.ref === "main" && p.head.repo?.full_name === REPO && p.head.ref.startsWith(PREFIX));
  assert.ok(row, "publisher source is not a merged release PR");
  const pr = api(`repos/${REPO}/pulls/${row.number}`);
  assert.equal(pr.merged, true);
  assert.equal(pr.merge_commit_sha, publisher.head_sha);
  assert.deepEqual(safePR(pr), lock);
  verifyManifest(lock, Buffer.from(execFileSync("git", ["show", `${publisher.head_sha}:release-manifest.json`])));
  return { lock, version, tag, pr };
}
async function receive() {
  assert.ok(process.env.RELEASE_CHAIN_OWNER, "RELEASE_CHAIN_OWNER is required for release notifications");
  const event = json(process.env.GITHUB_EVENT_PATH);
  assert.equal(event.action, "pineforge-release", "unexpected dispatch type");
  const incoming = validateReady(event.client_payload);
  activeLock = incoming;
  // Internal handoff of the unchanged ready event, including a failed or
  // superseded delivery. Only the trusted coordinator turns it into a receipt.
  mkdirSync(".release-ci", { recursive: true });
  write(".release-ci/release-target.json", incoming);
  const manifest = downloadManifest(incoming);
  await verifyArtifacts(incoming, manifest);
  git("fetch", "origin", "main", "--tags");
  const current = lockAt("origin/main");
  const prs = prList();
  const desired = prs.map((p) => ({ ...marker(p.body) }));
  // An equal bootstrap version has no ready manifest and is not a new release.
  if (!current.event_id && compareVersions(current.release_version, incoming.release_version) >= 0) {
    console.log("Superseded: bootstrap already consumes this or a newer release"); return;
  }
  const d = decision(current, incoming, desired);
  if (d !== "new") { console.log(`Release delivery: ${d}; the trusted coordinator reports progress`); return; }
  const bot = identity();
  const branch = `${PREFIX}${incoming.prerelease ? "next" : "stable"}/${incoming.release_version}-${incoming.manifest.sha256.slice(0, 12)}`;
  // Replays never reset an existing branch or overwrite a maintainer's edits.
  assert.equal(git("ls-remote", "--heads", "origin", `refs/heads/${branch}`), "", "existing branch without open PR requires repair; history preserved");
  git("checkout", "-b", branch, "origin/main");
  const next = nextVersion(readFileSync("VERSION", "utf8").trim(), incoming.release_version, git("tag", "-l", "v*").split("\n"));
  writeFileSync("VERSION", `${next}\n`);
  write("release-lock.json", incoming);
  writeFileSync("release-manifest.json", manifest);
  execFileSync("node", ["scripts/sync-version.mjs"], { stdio: "inherit" });
  git("add", ...ALLOWED);
  for (const f of git("diff", "--cached", "--name-only").split("\n")) assert.ok(ALLOWED.includes(f));
  git("commit", "-m", `chore(release): ${next} on PineForge ${incoming.release_version}`);
  git("push", "origin", `HEAD:refs/heads/${branch}`);
  const body = `Consume PineForge ${incoming.release_version} with immutable image, package and facts identities.\n\n` +
    `The required release/ready check tests the packed npm entry point and both image architectures before merge.\n\n` +
    `<!-- pineforge-release ${JSON.stringify({ event_id: incoming.event_id, release_version: incoming.release_version, base: "main", delivery_run: Number(process.env.GITHUB_RUN_ID), bot })} -->\n`;
  const p = mutate("POST", `repos/${REPO}/pulls`, { title: `chore(release): PineForge ${incoming.release_version}`, body, head: branch, base: "main" });
  console.log(`Release PR #${p.number} opened; the trusted coordinator reports progress`);
  for (const old of prs) if (compareVersions(marker(old.body).release_version, incoming.release_version) < 0) {
    // Closing the obsolete PR invalidates its promotion eligibility; its branch stays.
    mutate("PATCH", `repos/${REPO}/pulls/${old.number}`, { state: "closed" });
  }
}
function latestGate(p) {
  const runs = api(`repos/${REPO}/actions/workflows/test.yml/runs?event=pull_request&head_sha=${p.head.sha}&per_page=100`).workflow_runs;
  const run = runs.find((r) => r.head_sha === p.head.sha && r.pull_requests.some((q) => q.number === p.number));
  if (!run || run.status !== "completed" || run.conclusion !== "success") return null;
  const jobs = jobsFor(run);
  const checks = checkEvidence(run, jobs, RECEIPT_POLICY.ci, p.head.sha);
  const dir = mkdtempSync(join(tmpdir(), "pf-gate-"));
  const artifacts = pages(`repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`).flatMap((p) => p.artifacts);
  const name = chooseArtifact(artifacts, "offline-gate", run.id);
  gh("run", "download", String(run.id), "--repo", REPO, "--name", name, "--dir", dir);
  const gate = json(join(dir, "gate-receipt.json"));
  assert.equal(gate.state, "ready"); assert.equal(gate.head_sha, p.head.sha); assert.equal(String(gate.pr), String(p.number));
  assert.deepEqual(gate.expected_jobs, ["test", "runtime (amd64)", "runtime (arm64)"]);
  assert.deepEqual(gate.approved_skips, []);
  assert.equal(String(gate.run_id), String(run.id));
  assert.equal(Number(gate.attempt), run.run_attempt, "gate belongs to another run attempt");
  // PR CI exercises GitHub's merge candidate. Bind both parents before using
  // its runtime evidence as this head/base preview.
  if (gate.source_sha !== p.head.sha) {
    const candidate = api(`repos/${REPO}/commits/${gate.source_sha}`);
    assert.deepEqual(candidate.parents.map((parent) => parent.sha), [gate.base_sha, p.head.sha]);
  }
  return { ...gate, checks, jobs };
}
function candidateEvidence(p, lock, gate, merge = null) {
  assert.equal(gate.event_id, lock.event_id);
  assert.deepEqual(gate.facts, lock.facts);
  verifyEvidence(lock, json("test/fixtures/release/runtime-inventory.json"), gate.runtime, gate.source_sha, gate.run_id);
  if (merge) {
    assert.equal(p.merged, true);
    assert.equal(p.merge_commit_sha, merge);
    assert.equal(api(`repos/${REPO}/commits/${merge}`).parents[0].sha, gate.base_sha, "merge did not land the tested base");
    for (const job of gate.jobs) if (RECEIPT_POLICY.ci.expected.includes(job.name)) assert.ok(job.completed_at <= p.merged_at, "CI/E2E must finish before merge");
  }
  return { pr: { number: p.number, base: p.base.ref, base_sha: gate.base_sha, head: p.head.sha, merge },
    ci: gate.checks, e2e: gate.checks,
    preview: servedIdentity(lock, p.head.sha, { run_id: gate.checks.run_id, run_attempt: gate.checks.run_attempt,
      package_integrity: gate.package.integrity, runtime: gate.runtime }) };
}
async function advance() {
  assert.ok(process.env.RELEASE_CHAIN_OWNER, "RELEASE_CHAIN_OWNER is required for release notifications");
  if (restartTerminalRerun()) return;
  if (process.env.PUBLISHER_RUN_ID) { await reportPublication(process.env.PUBLISHER_RUN_ID); return; }
  identity();
  git("fetch", "origin", "main", "--tags");
  if (process.env.GITHUB_EVENT_NAME === "workflow_run") {
    const event = json(process.env.GITHUB_EVENT_PATH).workflow_run;
    if (event.path === ".github/workflows/pineforge-release.yml") {
      const run = api(`repos/${REPO}/actions/runs/${event.id}`);
      assert.equal(run.path, event.path);
      assert.equal(run.event, "repository_dispatch");
      const artifacts = artifactsFor(run.id);
      if (artifacts.some((a) => a.name.startsWith(`offline-release-target-${run.id}-`))) {
        const dir = mkdtempSync(join(tmpdir(), "pf-target-"));
        gh("run", "download", String(run.id), "--repo", REPO, "--name", chooseArtifact(artifacts, "offline-release-target", run.id), "--dir", dir);
        const incoming = validateReady(json(join(dir, "release-target.json")));
        activeLock = incoming;
        const current = lockAt("origin/main");
        const desired = prList().map((p) => marker(p.body));
        const obsolete = (!current.event_id && compareVersions(current.release_version, incoming.release_version) >= 0) || decision(current, incoming, desired) === "superseded";
        if (obsolete) {
          // A previously verified product can never regress, even after a newer
          // product supersedes it. Preserve or finish its landed report first.
          const landed = pages(`repos/${REPO}/pulls?state=closed&base=main&per_page=100`).flat()
            .find((p) => p.merged_at && p.head.repo?.full_name === REPO && p.head.ref.startsWith(PREFIX) && marker(p.body).event_id === incoming.event_id);
          if (landed) {
            const reports = finalReportsFor(landed.merge_commit_sha);
            if (preserveVerifiedReport(landed.merge_commit_sha)) return;
            const publishers = pages(`repos/${REPO}/actions/workflows/publish.yml/runs?head_sha=${landed.merge_commit_sha}&per_page=100`).flatMap((p) => p.workflow_runs);
            const success = publishers.find((r) => r.status === "completed" && r.conclusion === "success" && r.display_title === `Offline publish ${r.head_branch}`);
            if (success) { ensureFinalReport(success, success.head_branch); return; }
            // A historical reporter with expired evidence may already have
            // been collected as verified. Never invent a downgrade for it.
            if (reports.length) return;
          }
          writeReceipt(incoming, { state: "superseded" }); return;
        }
        if (current.event_id === incoming.event_id) { await tagLanded(); return; }
        if (run.conclusion !== "success") { writeReceipt(incoming, { state: "failed" }); return; }
      }
    }
    if (event.path === ".github/workflows/publish.yml" && event.display_title === `Offline publish ${event.head_branch}`) {
      const run = api(`repos/${REPO}/actions/runs/${event.id}`);
      assert.equal(run.path, event.path);
      const { lock } = trustedPublisher(run);
      activeLock = lock;
      if (preserveVerifiedReport(run.head_sha)) return;
      if (run.status === "completed" && run.conclusion === "success") ensureFinalReport(run, run.head_branch);
      else if (run.status === "completed" && !["cancelled", "skipped"].includes(run.conclusion)) writeReceipt(lock, { state: "failed" });
      // Cancellation is repaired through tagLanded's same-tag reconciliation.
      if (run.conclusion !== "cancelled" && run.conclusion !== "skipped") return;
    }
  }
  const prs = prList().sort((a, b) => compareVersions(marker(b.body).release_version, marker(a.body).release_version));
  if (!prs.length) { await tagLanded(); return; }
  const p = api(`repos/${REPO}/pulls/${prs[0].number}`);
  const lock = safePR(p);
  activeLock = lock;
  if (process.env.GITHUB_EVENT_NAME === "workflow_run") {
    const event = json(process.env.GITHUB_EVENT_PATH).workflow_run;
    if (event.head_sha === p.head.sha && event.conclusion !== "success") {
      await alert("CI/E2E", `Candidate PR #${p.number} failed or was cancelled. [Failed run](${event.html_url}).`);
      writeReceipt(lock, { state: "failed" });
      return;
    }
  }
  const current = lockAt("origin/main");
  assert.ok(compareVersions(lock.release_version, current.release_version) > 0, "desired release is no longer newer");
  const main = api(`repos/${REPO}/git/ref/heads/main`).object.sha;
  const gate = latestGate(p);
  if (!gate || gate.base_sha !== main) {
    // Updating through the App triggers fresh ordinary PR CI. Never force-push.
    const comparison = api(`repos/${REPO}/compare/main...${p.head.sha}`);
    if (comparison.behind_by > 0) mutate("PUT", `repos/${REPO}/pulls/${p.number}/update-branch`, { expected_head_sha: p.head.sha });
    // Do not retain mutable PR-head/base claims while update-branch/CI runs.
    // Null pending evidence remains collectable after those inputs advance.
    writeReceipt(lock, { state: "pending" }); return;
  }
  assert.equal(gate.event_id, lock.event_id);
  // Fresh artifact verification and an immediately repeated desired/head/base check.
  await verifyArtifacts(lock, downloadManifest(lock));
  const fresh = api(`repos/${REPO}/pulls/${p.number}`);
  assert.equal(fresh.state, "open"); assert.equal(fresh.head.sha, p.head.sha);
  assert.equal(api(`repos/${REPO}/git/ref/heads/main`).object.sha, gate.base_sha, "base moved during verification");
  assert.ok(!prList().some((q) => compareVersions(marker(q.body).release_version, lock.release_version) > 0), "superseded PR");
  assert.equal(fresh.mergeable_state, "clean", "required checks/protection not satisfied");
  candidateEvidence(p, lock, gate); // Revalidate the full internal suite evidence before merge.
  const merged = mutate("PUT", `repos/${REPO}/pulls/${p.number}/merge`, { sha: p.head.sha, merge_method: "squash" });
  assert.equal(merged.merged, true, "protected merge refused");
  const landed = api(`repos/${REPO}/pulls/${p.number}`);
  writeReceipt(lock, { state: "merged", ...candidateEvidence(landed, lock, gate, merged.sha) });
}
async function tagLanded() {
  const lock = lockAt("origin/main");
  if (!lock.event_id) return;
  validateReady(lock);
  activeLock = lock;
  const version = git("show", "origin/main:VERSION");
  const tag = `v${version}`;
  const associated = pages(`repos/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`).flat();
  const row = associated.find((p) => p.merged_at && p.head.repo?.full_name === REPO && p.head.ref.startsWith(PREFIX) && marker(p.body).event_id === lock.event_id);
  assert.ok(row, "only a merged update PR may start publication");
  const pr = api(`repos/${REPO}/pulls/${row.number}`);
  assert.equal(marker(pr.body).event_id, lock.event_id);
  const source = pr.merge_commit_sha;
  git("merge-base", "--is-ancestor", source, "origin/main");
  assert.equal(lockAt(source).event_id, lock.event_id);
  assert.equal(git("show", `${source}:VERSION`), version);
  assert.deepEqual(safePR(pr), lock);
  if (preserveVerifiedReport(source)) return;
  const gate = latestGate(pr);
  assert.ok(gate, "merged candidate lacks its original successful PR CI/E2E");
  const evidence = candidateEvidence(pr, lock, gate, source);
  const existing = git("tag", "-l", tag);
  if (existing) {
    assert.equal(git("rev-list", "-n", "1", tag), source, "version tag must name the exact merged PR; never rewrite it");
    const runs = pages(`repos/${REPO}/actions/workflows/publish.yml/runs?head_sha=${source}&per_page=100`).flatMap((p) => p.workflow_runs)
      .filter((run) => run.head_branch === tag && ["push", "workflow_dispatch"].includes(run.event) && run.display_title === `Offline publish ${tag}`);
    const action = publicationAction(runs);
    const latest = runs.sort((a, b) => b.id - a.id)[0];
    if (action === "report") { ensureFinalReport(latest, tag); return; }
    if (action === "failed") { writeReceipt(lock, { state: "failed" }); return; }
    if (action === "dispatch") gh("workflow", "run", "publish.yml", "--repo", REPO, "--ref", tag, "--field", "action=publish");
    writeReceipt(lock, { state: "deploying", ...evidence });
    return;
  }
  git("tag", "-a", tag, source, "-m", `Release ${tag}\n\nrelease=${lock.release_version}\nevent_id=${lock.event_id}`);
  git("push", "origin", `refs/tags/${tag}`);
  writeReceipt(lock, { state: "deploying", ...evidence });
}
export function publicationAction(runs) {
  const latest = [...runs].sort((a, b) => b.id - a.id)[0];
  if (!latest || (latest.status === "completed" && ["cancelled", "skipped"].includes(latest.conclusion))) return "dispatch";
  if (latest.status !== "completed") return "wait";
  return latest.conclusion === "success" ? "report" : "failed";
}
function ensureFinalReport(publisher, tag) {
  assert.equal(trustedPublisher(publisher).tag, tag);
  const title = `Offline receipt for publisher ${publisher.id}`;
  const runs = pages(`repos/${REPO}/actions/workflows/release-pr.yml/runs?event=workflow_dispatch&head_sha=${publisher.head_sha}&per_page=100`)
    .flatMap((p) => p.workflow_runs).filter((run) => run.head_sha === publisher.head_sha && run.display_title === title).sort((a, b) => b.id - a.id);
  // The artifact survives a failed notification; polling is sufficient then.
  if (runs[0] && runs[0].status !== "completed") return;
  if (runs[0] && existingSnapshot(runs[0].id)?.state === "verified") return;
  gh("workflow", "run", "release-pr.yml", "--repo", REPO, "--ref", tag, "--field", `publisher_run_id=${publisher.id}`);
}
async function reportPublication(id) {
  assert.match(id, /^[1-9][0-9]*$/);
  const publisher = api(`repos/${REPO}/actions/runs/${id}`);
  const { lock, version, pr: actual } = trustedPublisher(publisher);
  activeLock = lock;
  const reporting = api(`repos/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  assert.equal(reporting.path, ".github/workflows/release-pr.yml");
  assert.equal(reporting.event, "workflow_dispatch");
  assert.equal(reporting.head_sha, publisher.head_sha, "final reporting run must be at the landed source");
  const gate = latestGate(actual);
  assert.ok(gate, "original PR CI/E2E is required");
  const evidence = candidateEvidence(actual, lock, gate, publisher.head_sha);
  const deployJobs = jobsFor(publisher);
  const deploy = checkEvidence(publisher, deployJobs, RECEIPT_POLICY.deploy, publisher.head_sha);
  assert.equal(deploy.results["mcp-registry"], lock.prerelease ? "skipped" : "success", "Registry skip is only permitted for prereleases");
  const dir = mkdtempSync(join(tmpdir(), "pf-served-"));
  const artifacts = artifactsFor(publisher.id);
  for (const prefix of ["offline-distribution", "offline-channels", "offline-image-publication"]) {
    gh("run", "download", String(publisher.id), "--repo", REPO, "--name", chooseArtifact(artifacts, prefix, publisher.id), "--dir", dir);
  }
  const served = json(join(dir, "distribution-evidence.json"));
  const channels = json(join(dir, "channel-state.json"));
  const image = json(join(dir, "image-publication.json"));
  assert.equal(served.event_id, lock.event_id);
  assert.equal(served.source, publisher.head_sha);
  assert.equal(served.run_id, publisher.id);
  assert.equal(served.run_attempt, publisher.run_attempt);
  assert.equal(channels.event_id, lock.event_id);
  assert.equal(channels.source_sha, publisher.head_sha);
  assert.equal(channels.run_id, publisher.id);
  assert.equal(channels.version, version);
  assert.equal(image.event_id, lock.event_id);
  assert.equal(image.version, version);
  assert.deepEqual(served.deployed, servedIdentity(lock, publisher.head_sha, { version, integrity: channels.package_integrity, image: image.digest, channel: channels.channel }));
  assert.deepEqual(served.previous, channels.previous.identity);
  await verifyArtifacts(lock, downloadManifest(lock));
  const finished = deployJobs.filter((job) => deploy.expected.includes(job.name) && job.conclusion === "success").map((job) => job.completed_at).sort().at(-1);
  assert.ok(new Date().toISOString() >= finished, "distribution verification has not finished");
  writeReceipt(lock, { state: "verified", ...evidence, deploy, deployed: served.deployed, previous: served.previous });
}
export async function alert(stage, detail = "See the workflow run for the failed gate.") {
  // PR tokens need no Issues permission. The workflow's own short-lived token
  // handles incidents independently of the target-scoped App credentials.
  const previousToken = process.env.GH_TOKEN;
  if (process.env.INCIDENT_TOKEN) process.env.GH_TOKEN = process.env.INCIDENT_TOKEN;
  try {
    let lock = activeLock;
    let failureSource = process.env.RELEASE_FAILURE_SOURCE_SHA;
    if (process.env.RELEASE_FAILURE_RUN) {
      assert.match(process.env.RELEASE_FAILURE_RUN, /^[1-9][0-9]*$/);
      const original = api(`repos/${REPO}/actions/runs/${process.env.RELEASE_FAILURE_RUN}`);
      assert.equal(original.path, ".github/workflows/publish.yml");
      failureSource = original.head_sha;
    }
    if (!lock && failureSource) {
      assert.match(failureSource, /^[0-9a-f]{40}$/);
      const blob = api(`repos/${REPO}/contents/release-lock.json?ref=${failureSource}`);
      lock = JSON.parse(Buffer.from(blob.content, "base64"));
    }
    if (!lock) try { lock = readLock(); } catch { /* invalid event still needs an incident */ }
    const results = process.env.RELEASE_JOB_RESULTS ? JSON.parse(process.env.RELEASE_JOB_RESULTS) : null;
    if (results) detail += `\n\nJob results:\n\n${Object.entries(results).map(([name, job]) => `- ${name}: ${job.result}`).join("\n")}`;
    const event = lock?.event_id ?? "unresolved";
    const title = `Release chain: offline ${event}`;
    const owner = process.env.RELEASE_CHAIN_OWNER ?? "";
    assert.ok(!owner || /^[A-Za-z0-9/-]+$/.test(owner), "invalid owner mention");
    const run = `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const body = `${owner ? `@${owner}\n\n` : ""}Offline consumer **${stage}**.\n\n${detail}\n\n[Workflow run](${run})\n\nEvent: ${event}\n`;
    const dir = mkdtempSync(join(tmpdir(), "pf-incident-")); const file = join(dir, "body.md"); writeFileSync(file, body);
    const incidents = pages(`repos/${REPO}/issues?state=all&per_page=100`).flat().filter((i) => !i.pull_request && i.title === title);
    if (incidents[0]) {
      gh("issue", "comment", String(incidents[0].number), "--repo", REPO, "--body-file", file);
      if (stage === "verified") mutate("PATCH", `repos/${REPO}/issues/${incidents[0].number}`, { state: "closed" });
      else if (incidents[0].state === "closed") mutate("PATCH", `repos/${REPO}/issues/${incidents[0].number}`, { state: "open" });
    } else {
      const issueURL = gh("issue", "create", "--repo", REPO, "--title", title, "--body-file", file);
      if (stage === "verified") gh("issue", "close", issueURL, "--repo", REPO);
    }
    // Incidents retain human-facing details; only release-pr writes a receipt.
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv[2] === "receive") await receive();
    else if (process.argv[2] === "advance") await advance();
    else if (process.argv[2] === "alert") await alert(process.argv[3] ?? "failed");
    else throw Error("expected receive, advance or alert");
  } catch (e) {
    console.error(e.message);
    if (process.argv[2] === "advance" && activeLock && !(priorSnapshot?.event_id === activeLock.event_id && priorSnapshot.state === "verified")) {
      try { writeReceipt(activeLock, { state: "failed" }); } catch (receiptError) { console.error(receiptError.message); }
    }
    try { await alert(process.argv[2], e.message); } catch (notificationError) { console.error(`Incident reporting failed: ${notificationError.message}`); }
    process.exitCode = 1;
  }
}
