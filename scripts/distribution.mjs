// The existing publish workflow is the only distributor. These transitions
// consume CI's packed tarball and saved, tested images; they never rebuild.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { api, gh, readLock, sha256, verifyManifest } from "./release-contract.mjs";
import { integrity, verifyEvidence } from "./release-evidence.mjs";
import { compareVersions, channel } from "./release-version.mjs";
import { marker, alert } from "./release-consumer.mjs";

const REPO = process.env.GITHUB_REPOSITORY ?? "pineforge-4pass/pineforge-backtest-mcp";
const NPM = "@pineforge/backtest-mcp";
const OCI = "ghcr.io/pineforge-4pass/pineforge-backtest-mcp";
const dir = ".release-ci";
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const save = (p, x) => writeFileSync(p, JSON.stringify(x, null, 2) + "\n");
const cmd = (name, ...args) => execFileSync(name, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const docker = (...args) => cmd("docker", ...args);
async function fileHash(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
function existingImage(ref) {
  try { return JSON.parse(docker("buildx", "imagetools", "inspect", ref, "--raw")); }
  catch (e) {
    // Transport/authentication errors are failures, never evidence of absence.
    const error = String(e.stderr ?? "");
    if (/manifest unknown|manifest.*not found|404 Not Found/i.test(error) && !/unauthorized|denied|authenticate|token/i.test(error)) return null;
    throw e;
  }
}
async function npmMetadata(version = "") {
  const response = await fetch(`https://registry.npmjs.org/@pineforge%2fbacktest-mcp${version ? `/${version}` : ""}`);
  if (response.status === 404) return null;
  assert.equal(response.status, 200, `npm registry HTTP ${response.status}`);
  return response.json();
}
function imageDigest(ref) {
  const text = docker("buildx", "imagetools", "inspect", ref);
  const m = text.match(/^Digest:\s+(sha256:[0-9a-f]{64})\s*$/m);
  assert.ok(m, "registry did not return a digest");
  return m[1];
}
function desired(lock) {
  const main = api(`repos/${REPO}/contents/release-lock.json?ref=main`);
  const current = JSON.parse(Buffer.from(main.content, "base64"));
  assert.equal(current.event_id, lock.event_id, "main no longer desires this manifest");
  const prs = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${REPO}/pulls?state=open&base=main&per_page=100`)).flat();
  for (const p of prs.filter((p) => p.head.repo?.full_name === REPO && p.head.ref.startsWith("bot/pineforge-release/main/"))) {
    assert.ok(compareVersions(marker(p.body).release_version, lock.release_version) <= 0, "newer release superseded this distribution");
  }
}
function oidc() {
  assert.equal(cmd("npm", "--version"), "11.21.0", "dist-tag OIDC requires the pinned supporting CLI");
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "OIDC unavailable");
  assert.ok(!process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN, "long-lived npm token must not replace OIDC");
}
export function validateChannelState(s) {
  assert.equal(s.role, "offline");
  assert.match(s.event_id, /^sha256:[0-9a-f]{64}$/);
  assert.match(s.source_sha, /^[0-9a-f]{40}$/);
  assert.ok(Number.isSafeInteger(s.run_id) && s.run_id > 0);
  assert.ok(["latest", "next"].includes(s.channel));
  assert.equal(channel(s.version).npmDistTag, s.channel);
  assert.ok(compareVersions(s.version, s.previous.npm_version) > 0, "channel may only advance");
  assert.equal(channel(s.previous.npm_version).npmDistTag, s.channel, "previous channel version mismatch");
  if (s.channel === "latest") assert.match(s.previous.image_digest, /^sha256:[0-9a-f]{64}$/);
  else assert.equal(s.previous.image_digest, null);
  return s;
}
async function prepare() {
  const lock = readLock("release-lock.json", { ready: true });
  verifyManifest(lock, readFileSync("release-manifest.json"));
  const version = readFileSync("VERSION", "utf8").trim();
  assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`, "publication requires the immutable version tag, including manual replay");
  const tag = api(`repos/${REPO}/git/ref/tags/v${version}`).object;
  assert.equal(tag.type, "tag", "release must have an annotated tag");
  const annotated = api(`repos/${REPO}/git/tags/${tag.sha}`);
  assert.equal(annotated.object.sha, process.env.GITHUB_SHA);
  assert.ok(annotated.message.split("\n").includes(`event_id=${lock.event_id}`), "tag and manifest disagree");
  const prs = api(`repos/${REPO}/commits/${process.env.GITHUB_SHA}/pulls`);
  const pr = prs.find((p) => p.merged_at && p.merge_commit_sha === process.env.GITHUB_SHA && p.base.ref === "main" && p.head.ref.startsWith("bot/pineforge-release/main/"));
  assert.ok(pr && marker(pr.body).event_id === lock.event_id, "tag was not produced by a merged release PR");
  desired(lock);
  const gate = json(`${dir}/gate-receipt.json`);
  assert.equal(gate.state, "ready"); assert.equal(gate.source_sha, process.env.GITHUB_SHA);
  assert.equal(String(gate.run_id), process.env.GITHUB_RUN_ID);
  assert.equal(gate.event_id, lock.event_id);
  verifyEvidence(lock, json("test/fixtures/release/runtime-inventory.json"), gate.runtime, process.env.GITHUB_SHA, process.env.GITHUB_RUN_ID);
  assert.equal(integrity(`${dir}/${gate.package.tar}`), gate.package.integrity);
  assert.equal(gate.package.version, version);
  const ch = channel(version);
  assert.equal(ch.prerelease, lock.prerelease, "package channel contradicts hub");
  const metadata = await npmMetadata();
  const previousVersion = metadata?.["dist-tags"]?.[ch.npmDistTag];
  assert.ok(previousVersion, "cannot record/restore absent previous npm channel");
  // A replay after successful promotion reuses its original channel snapshot.
  // Prefer replaying the original run, which retains its immutable artifacts.
  assert.ok(compareVersions(version, previousVersion) > 0, "already applied or older channel: no republish; use restoration if needed");
  const previousImage = ch.prerelease ? null : imageDigest(`${OCI}:latest`);
  if (previousImage) assert.equal(imageDigest(`${OCI}:v${previousVersion}`), previousImage, "previous npm/image channels disagree");
  const state = validateChannelState({ role: "offline", event_id: lock.event_id, source_sha: process.env.GITHUB_SHA,
    run_id: Number(process.env.GITHUB_RUN_ID), version, channel: ch.npmDistTag,
    gate_artifact: `offline-gate-${gate.run_id}-${gate.attempt}`,
    package_artifact: `offline-package-${gate.package.run_id}-${gate.package.attempt}`,
    package_integrity: gate.package.integrity, previous: { npm_version: previousVersion, image_digest: previousImage },
    pr: pr.number, base_sha: pr.base.sha, head_sha: pr.head.sha, merge_sha: pr.merge_commit_sha });
  save(`${dir}/channel-state.json`, state);
}
async function archive() {
  const arch = process.env.PF_ARCH;
  assert.ok(["amd64", "arm64"].includes(arch));
  const lock = readLock();
  const image = JSON.parse(docker("image", "inspect", process.env.PF_E2E_CANDIDATE_IMAGE))[0];
  assert.equal(image.Architecture, arch);
  assert.equal(image.Config.Labels["io.pineforge.release.image"], `${lock.image.repository}@${lock.image.digest}`);
  assert.equal(image.Config.Labels["org.opencontainers.image.revision"], process.env.GITHUB_SHA);
  const runtime = json(`${dir}/runtime-${arch}-image.json`);
  assert.equal(image.Id, runtime.image_id);
  save(`${dir}/candidate-${arch}.json`, { arch, image_id: image.Id, source_sha: process.env.GITHUB_SHA,
    event_id: lock.event_id ?? null, archive_sha256: await fileHash(`${dir}/image-${arch}.tar`) });
}
async function publishImage() {
  const lock = readLock("release-lock.json", { ready: true }); desired(lock);
  const gate = json(`${dir}/gate-receipt.json`);
  const version = json(`${dir}/channel-state.json`).version;
  const refs = [];
  for (const arch of ["amd64", "arm64"]) {
    const candidate = json(`${dir}/candidate-${arch}.json`);
    assert.equal(candidate.source_sha, process.env.GITHUB_SHA);
    assert.equal(candidate.event_id, lock.event_id);
    assert.equal(await fileHash(`${dir}/image-${arch}.tar`), candidate.archive_sha256, "saved tested image changed");
    assert.equal(gate.runtime.find((e) => e.mode === "image" && e.arch === arch).image_id, candidate.image_id);
    docker("load", "-i", `${dir}/image-${arch}.tar`);
    const local = `pineforge-offline-candidate:${arch}`;
    assert.equal(JSON.parse(docker("image", "inspect", local))[0].Id, candidate.image_id);
    const ref = `${OCI}:v${version}-${arch}`;
    // Never replace a previously published fixed version with other bytes.
    const existing = existingImage(ref);
    if (existing) assert.equal(existing.config.digest, candidate.image_id, "fixed architecture version already has different bytes");
    else { docker("tag", local, ref); docker("push", ref); }
    const raw = JSON.parse(docker("buildx", "imagetools", "inspect", ref, "--raw"));
    assert.equal(raw.config.digest, candidate.image_id, "registry changed tested config/layers");
    refs.push(`${OCI}@${imageDigest(ref)}`);
  }
  const fixed = `${OCI}:v${version}`;
  const existing = existingImage(fixed);
  if (existing) assert.deepEqual(existing.manifests.map((m) => `${OCI}@${m.digest}`).sort(), refs.slice().sort(), "fixed index already has different children");
  else docker("buildx", "imagetools", "create", "--tag", fixed, ...refs);
  const receipt = { role: "offline", event_id: lock.event_id, version, digest: imageDigest(fixed), children: refs };
  save(`${dir}/image-publication.json`, receipt);
}
async function publishNpm() {
  const lock = readLock("release-lock.json", { ready: true }); desired(lock);
  const state = validateChannelState(json(`${dir}/channel-state.json`));
  const pkg = json(`${dir}/package.json`);
  assert.equal(integrity(`${dir}/${pkg.tar}`), state.package_integrity);
  oidc();
  assert.equal((await npmMetadata())["dist-tags"][state.channel], state.previous.npm_version, "channel moved before OIDC proof; refusing to restore a newer publication");
  // A real no-change restoration proves this workflow's exact OIDC dist-tag
  // operation BEFORE publication. A missing permission fails closed here.
  cmd("npm", "dist-tag", "add", `${NPM}@${state.previous.npm_version}`, state.channel);
  assert.equal((await npmMetadata())["dist-tags"][state.channel], state.previous.npm_version);
  save(`${dir}/oidc-proof.json`, { cli: "11.21.0", operation: "npm dist-tag add", authentication: "github-oidc", channel: state.channel, restored_version: state.previous.npm_version, run_id: process.env.GITHUB_RUN_ID });
  const existing = await npmMetadata(state.version);
  if (existing) assert.equal(existing.dist.integrity, state.package_integrity, "published npm version has different bytes");
  else cmd("npm", "publish", `${dir}/${pkg.tar}`, "--ignore-scripts", "--access=public", "--tag", `candidate-${lock.manifest.sha256.slice(0, 12)}`);
  assert.equal((await npmMetadata(state.version))?.dist.integrity, state.package_integrity, "npm artifact verification failed");
}
async function registry(required) {
  const server = json("server.json");
  const r = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${server.version}`);
  if (r.status === 404 && !required) { console.log("needed=true"); return; }
  assert.equal(r.status, 200, `MCP Registry HTTP ${r.status}`);
  const published = (await r.json()).server;
  assert.equal(published.name, server.name); assert.equal(published.version, server.version);
  assert.deepEqual(published.packages, server.packages, "MCP Registry package identity mismatch");
  console.log("needed=false");
}
async function githubRelease() {
  const lock = readLock("release-lock.json", { ready: true });
  const version = readFileSync("VERSION", "utf8").trim();
  const tag = `v${version}`;
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` } });
  let release;
  if (response.status === 404) {
    const args = ["release", "create", tag, "--repo", REPO, "--title", tag, "--generate-notes", "--latest=false"];
    if (lock.prerelease) args.push("--prerelease");
    gh(...args);
    release = api(`repos/${REPO}/releases/tags/${tag}`);
  } else { assert.equal(response.status, 200); release = await response.json(); }
  assert.equal(release.prerelease, lock.prerelease);
  if (release.assets.some((a) => a.name === "release-manifest.json")) {
    const temp = mkdtempSync(join(tmpdir(), "pf-published-manifest-"));
    gh("release", "download", tag, "--repo", REPO, "--pattern", "release-manifest.json", "--dir", temp);
    verifyManifest(lock, readFileSync(join(temp, "release-manifest.json")));
  } else gh("release", "upload", tag, "release-manifest.json", "--repo", REPO);
}
async function promote() {
  const lock = readLock("release-lock.json", { ready: true }); desired(lock);
  const state = validateChannelState(json(`${dir}/channel-state.json`));
  const image = json(`${dir}/image-publication.json`);
  assert.equal(image.event_id, lock.event_id);
  assert.equal(imageDigest(`${OCI}:v${state.version}`), image.digest);
  assert.equal((await npmMetadata(state.version)).dist.integrity, state.package_integrity);
  // Stop a stale run from restoring or replacing a newer channel.
  const current = (await npmMetadata())["dist-tags"][state.channel];
  assert.ok([state.previous.npm_version, state.version].includes(current), "npm channel moved since preparation");
  if (state.channel === "latest") assert.ok([state.previous.image_digest, image.digest].includes(imageDigest(`${OCI}:latest`)), "image channel moved since preparation");
  oidc(); desired(lock);
  cmd("npm", "dist-tag", "add", `${NPM}@${state.version}`, state.channel);
  if (state.channel === "latest") {
    assert.ok([state.previous.image_digest, image.digest].includes(imageDigest(`${OCI}:latest`)), "image channel moved since preparation");
    docker("buildx", "imagetools", "create", "--tag", `${OCI}:latest`, `${OCI}@${image.digest}`);
    assert.equal(imageDigest(`${OCI}:latest`), image.digest, "latest image not activated");
  }
  assert.equal((await npmMetadata())["dist-tags"][state.channel], state.version, "npm channel not activated");
  if (state.channel === "latest") gh("release", "edit", `v${state.version}`, "--repo", REPO, "--latest");
  const gate = json(`${dir}/gate-receipt.json`);
  const receipt = { role: "offline", state: "verified", delivery: "package-and-image-distribution", external_hosts: "unverified",
    event_id: lock.event_id, manifest_sha256: lock.manifest.sha256, ...state,
    ci_e2e_run_id: gate.run_id, expected_jobs: gate.expected_jobs, runtime: gate.runtime, approved_skips: [],
    deployed: { source_sha: state.source_sha, npm_version: state.version, npm_integrity: state.package_integrity, image: `${OCI}@${image.digest}`, facts: lock.facts },
    preview: { kind: "local-runtime", architectures: ["amd64", "arm64"] },
    attempt: process.env.GITHUB_RUN_ATTEMPT, completed_at: new Date().toISOString() };
  const file = `${dir}/offline-receipt-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`;
  save(file, receipt);
  try {
    gh("release", "upload", `v${state.version}`, file, "--repo", REPO);
    await alert("verified", `Verified npm ${state.channel} and the immutable multi-architecture image. External hosts are not part of this distribution receipt.`);
  } catch (e) {
    save(file, { ...receipt, state: "failed", stage: "completion-reporting", completed_at: new Date().toISOString() });
    throw e;
  }
}
async function restore() {
  const state = validateChannelState(json(`${dir}/channel-state.json`));
  // For manual restoration, only artifacts from this repository's real
  // publisher are accepted, never PR workflow artifacts or caller payloads.
  const run = api(`repos/${REPO}/actions/runs/${state.run_id}`);
  assert.equal(run.path, ".github/workflows/publish.yml");
  assert.ok(["push", "workflow_dispatch"].includes(run.event));
  assert.equal(run.head_sha, state.source_sha);
  assert.equal(String(state.run_id), process.env.RESTORE_SOURCE_RUN, "restoration artifact/run mismatch");
  const image = existsSync(`${dir}/image-publication.json`) ? json(`${dir}/image-publication.json`) : null;
  const current = (await npmMetadata())["dist-tags"][state.channel];
  assert.ok([state.version, state.previous.npm_version].includes(current), "newer npm channel must not be rolled back");
  if (state.channel === "latest") {
    const digest = imageDigest(`${OCI}:latest`);
    assert.ok([state.previous.image_digest, image?.digest].includes(digest), "newer image channel must not be rolled back");
  }
  oidc();
  cmd("npm", "dist-tag", "add", `${NPM}@${state.previous.npm_version}`, state.channel);
  assert.equal((await npmMetadata())["dist-tags"][state.channel], state.previous.npm_version, "OIDC channel restoration failed");
  if (state.channel === "latest") {
    docker("buildx", "imagetools", "create", "--tag", `${OCI}:latest`, `${OCI}@${state.previous.image_digest}`);
    assert.equal(imageDigest(`${OCI}:latest`), state.previous.image_digest, "image channel restoration failed");
    gh("release", "edit", `v${state.previous.npm_version}`, "--repo", REPO, "--latest");
  }
  save(`${dir}/restoration-receipt.json`, { ...state, state: "failed", recovery: "channels_restored", restored: state.previous,
    cli: "11.21.0", authentication: "github-oidc", attempt: process.env.GITHUB_RUN_ATTEMPT, completed_at: new Date().toISOString() });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    mkdirSync(dir, { recursive: true });
    const action = process.argv[2];
    if (action === "archive") await archive();
    else if (action === "prepare") await prepare();
    else if (action === "image") await publishImage();
    else if (action === "npm") await publishNpm();
    else if (action === "registry-needed") await registry(false);
    else if (action === "registry-verify") await registry(true);
    else if (action === "github-release") await githubRelease();
    else if (action === "promote") await promote();
    else if (action === "restore") await restore();
    else throw Error("unknown distribution action");
  } catch (e) { console.error(e); process.exitCode = 1; }
}
