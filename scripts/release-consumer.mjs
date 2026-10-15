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

export const ALLOWED = ["VERSION", "package.json", "package-lock.json", "server.json", "release-lock.json", "release-manifest.json"];
const PREFIX = "bot/pineforge-release/main/";
let activeLock;
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
function receipt(state, lock, extra = {}) {
  mkdirSync(".release-ci", { recursive: true });
  write(".release-ci/consumer-receipt.json", { role: "offline", state, event_id: lock?.event_id ?? null,
    manifest_sha256: lock?.manifest?.sha256 ?? null, facts: lock?.facts ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT, run_id: process.env.GITHUB_RUN_ID, completed_at: new Date().toISOString(), ...extra });
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
  git("fetch", "origin", p.head.ref);
  const lock = lockAt("FETCH_HEAD"); validateReady(lock);
  assert.equal(lock.event_id, m.event_id, "PR marker and committed lock disagree");
  assert.equal(lock.release_version, m.release_version);
  verifyManifest(lock, Buffer.from(execFileSync("git", ["show", "FETCH_HEAD:release-manifest.json"])));
  return lock;
}
async function receive() {
  assert.ok(process.env.RELEASE_CHAIN_OWNER, "RELEASE_CHAIN_OWNER is required for release notifications");
  const event = json(process.env.GITHUB_EVENT_PATH);
  assert.equal(event.action, "pineforge-release", "unexpected dispatch type");
  const incoming = validateReady(event.client_payload);
  activeLock = incoming;
  const manifest = downloadManifest(incoming);
  await verifyArtifacts(incoming, manifest);
  git("fetch", "origin", "main", "--tags");
  const current = lockAt("origin/main");
  const prs = prList();
  const desired = prs.map((p) => ({ ...marker(p.body) }));
  // An equal bootstrap version has no ready manifest and is not a new release.
  if (!current.event_id && compareVersions(current.release_version, incoming.release_version) >= 0) {
    receipt("superseded", incoming, { reason: "bootstrap already consumes this or a newer release" }); return;
  }
  const d = decision(current, incoming, desired);
  if (d !== "new") { receipt(d === "duplicate" ? (current.event_id === incoming.event_id ? "merged" : "pr_open") : d, incoming, { distribution_verified: false, reason: d }); return; }
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
  receipt("pr_open", incoming, { pr: p.number, base_sha: p.base.sha, head_sha: p.head.sha });
  for (const old of prs) if (compareVersions(marker(old.body).release_version, incoming.release_version) < 0) {
    // Closing the obsolete PR invalidates its promotion eligibility; its branch stays.
    mutate("PATCH", `repos/${REPO}/pulls/${old.number}`, { state: "closed" });
  }
}
function latestGate(p) {
  const runs = api(`repos/${REPO}/actions/workflows/test.yml/runs?event=pull_request&head_sha=${p.head.sha}&per_page=100`).workflow_runs;
  const run = runs.find((r) => r.head_sha === p.head.sha && r.pull_requests.some((q) => q.number === p.number));
  if (!run || run.conclusion !== "success") return null;
  const dir = mkdtempSync(join(tmpdir(), "pf-gate-"));
  const artifacts = pages(`repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`).flatMap((p) => p.artifacts);
  const name = chooseArtifact(artifacts, "offline-gate", run.id);
  gh("run", "download", String(run.id), "--repo", REPO, "--name", name, "--dir", dir);
  const gate = json(join(dir, "gate-receipt.json"));
  assert.equal(gate.state, "ready"); assert.equal(gate.head_sha, p.head.sha); assert.equal(String(gate.pr), String(p.number));
  assert.deepEqual(gate.expected_jobs, ["test", "runtime (amd64)", "runtime (arm64)"]);
  assert.deepEqual(gate.approved_skips, []);
  return gate;
}
async function advance() {
  assert.ok(process.env.RELEASE_CHAIN_OWNER, "RELEASE_CHAIN_OWNER is required for release notifications");
  identity();
  git("fetch", "origin", "main", "--tags");
  const prs = prList().sort((a, b) => compareVersions(marker(b.body).release_version, marker(a.body).release_version));
  if (!prs.length) { await tagLanded(); return; }
  const p = api(`repos/${REPO}/pulls/${prs[0].number}`);
  const lock = safePR(p);
  activeLock = lock;
  if (process.env.GITHUB_EVENT_NAME === "workflow_run") {
    const event = json(process.env.GITHUB_EVENT_PATH).workflow_run;
    if (event.head_sha === p.head.sha && event.conclusion !== "success") {
      await alert("CI/E2E", `Candidate PR #${p.number} failed or was cancelled. [Failed run](${event.html_url}).`);
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
    receipt("testing", lock, { pr: p.number, head_sha: p.head.sha, reason: "waiting for current-base runtime evidence" }); return;
  }
  assert.equal(gate.event_id, lock.event_id);
  // Fresh artifact verification and an immediately repeated desired/head/base check.
  await verifyArtifacts(lock, downloadManifest(lock));
  const fresh = api(`repos/${REPO}/pulls/${p.number}`);
  assert.equal(fresh.state, "open"); assert.equal(fresh.head.sha, p.head.sha);
  assert.equal(api(`repos/${REPO}/git/ref/heads/main`).object.sha, gate.base_sha, "base moved during verification");
  assert.ok(!prList().some((q) => compareVersions(marker(q.body).release_version, lock.release_version) > 0), "superseded PR");
  assert.equal(fresh.mergeable_state, "clean", "required checks/protection not satisfied");
  const merged = mutate("PUT", `repos/${REPO}/pulls/${p.number}/merge`, { sha: p.head.sha, merge_method: "squash" });
  assert.equal(merged.merged, true, "protected merge refused");
  receipt("merged", lock, { pr: p.number, base_sha: gate.base_sha, head_sha: p.head.sha, merge_sha: merged.sha, ci_run_id: gate.run_id });
}
async function tagLanded() {
  const commit = git("rev-parse", "origin/main");
  const lock = lockAt("origin/main");
  if (!lock.event_id) return;
  validateReady(lock);
  const version = git("show", "origin/main:VERSION");
  const tag = `v${version}`;
  const existing = git("tag", "-l", tag);
  if (existing) {
    const tagged = git("rev-list", "-n", "1", tag);
    assert.equal(lockAt(tagged).event_id, lock.event_id, "version tag already records another manifest; never rewrite it");
    git("merge-base", "--is-ancestor", tagged, "origin/main");
    return;
  }
  const associated = pages(`repos/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`).flat();
  const pr = associated.find((p) => p.merged_at && p.head.ref.startsWith(PREFIX) && marker(p.body).event_id === lock.event_id);
  assert.ok(pr, "only a merged update PR may start publication");
  assert.equal(marker(pr.body).event_id, lock.event_id);
  const source = pr.merge_commit_sha;
  git("merge-base", "--is-ancestor", source, "origin/main");
  assert.equal(lockAt(source).event_id, lock.event_id);
  assert.equal(git("show", `${source}:VERSION`), version);
  git("tag", "-a", tag, source, "-m", `Release ${tag}\n\nrelease=${lock.release_version}\nevent_id=${lock.event_id}`);
  git("push", "origin", `refs/tags/${tag}`);
  receipt("deploying", lock, { pr: pr.number, head_sha: pr.head.sha, merge_sha: source, tag });
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
    receipt(stage === "verified" ? "verified" : "failed", lock, { stage, run, jobs: results });
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
    try { await alert(process.argv[2], e.message); } catch (notificationError) { console.error(`Incident reporting failed: ${notificationError.message}`); }
    process.exitCode = 1;
  }
}
