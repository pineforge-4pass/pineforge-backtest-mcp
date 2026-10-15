// Section 3.2 of the release-chain design. Only the ready event is accepted
// for distribution; the explicitly marked, observed 1.5.0 bootstrap is build-only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions, parseVersion } from "./release-version.mjs";

export const HUB = "pineforge-4pass/pineforge-release";
export const IMAGE = `ghcr.io/${HUB}`;
export const SCHEMA = "pineforge/release-ready/v1";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const check = (yes, message) => assert.ok(yes, message);
const hex = (x, n) => typeof x === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(x);
const digest = (x) => typeof x === "string" && /^sha256:[0-9a-f]{64}$/.test(x);
const keys = (x, expected, label) => {
  check(object(x), `${label}: expected object`);
  assert.deepEqual(Object.keys(x).sort(), expected.split(" ").sort(), `${label}: unexpected/missing fields`);
};
export function normalizedVersion(x) {
  check(typeof x === "string", "version must be a string");
  return x.replace(/^v/, "").replace(/(\d)(a|b|rc)(\d+)$/, (_, n, k, i) => `${n}-${{ a: "alpha", b: "beta", rc: "rc" }[k]}.${i}`);
}
function version(x) {
  const p = parseVersion(x);
  check(!x.startsWith("v"), "payload versions must be bare semver");
  return p;
}
export function validateImage(x) {
  keys(x, "repository digest amd64_digest arm64_digest", "image");
  assert.equal(x.repository, IMAGE, "unexpected image source");
  for (const k of ["digest", "amd64_digest", "arm64_digest"]) check(digest(x[k]), `malformed ${k}`);
  check(new Set([x.digest, x.amd64_digest, x.arm64_digest]).size === 3, "index and children must be distinct");
}
export function validateReady(x) {
  keys(x, "schema event_id release_version prerelease hub_commit versions image facts manifest run_id", "ready payload");
  assert.equal(x.schema, SCHEMA, "legacy/unrecognized event schema");
  assert.equal(typeof x.prerelease, "boolean", "prerelease must be boolean");
  assert.equal(version(x.release_version).pre !== null, x.prerelease, "contradictory prerelease flag");
  check(hex(x.hub_commit, 40), "malformed hub_commit");
  check(Number.isSafeInteger(x.run_id) && x.run_id > 0, "run_id must be a positive integer");
  keys(x.manifest, "asset sha256", "manifest");
  assert.equal(x.manifest.asset, "release-manifest.json", "unexpected manifest asset");
  check(hex(x.manifest.sha256, 64), "malformed manifest hash");
  assert.equal(x.event_id, `sha256:${x.manifest.sha256}`, "event_id must hash manifest bytes");
  validateImage(x.image);
  keys(x.facts, "commit path sha256 release_key", "facts");
  check(hex(x.facts.commit, 40) && hex(x.facts.sha256, 64), "malformed facts identity");
  assert.equal(x.facts.path, "facts/facts.json", "unexpected facts source path");
  assert.equal(x.facts.release_key, x.release_version, "facts release_key mismatch");
  keys(x.versions, "engine codegen hpo", "versions");
  const { engine, codegen, hpo } = x.versions;
  keys(engine, "version tag commit", "engine");
  keys(codegen, "version pypi_version commit sdist_sha256 npm_version npm_integrity", "codegen");
  for (const c of [engine, codegen]) {
    version(c.version);
    check(hex(c.commit, 40), "malformed component commit");
  }
  assert.equal(engine.tag, `v${engine.version}`, "engine tag mismatch");
  if (compareVersions(x.release_version, "1.0.0") >= 0) {
    assert.equal(engine.version, x.release_version, "engine lockstep mismatch");
    assert.equal(codegen.version, engine.version, "codegen lockstep mismatch");
  }
  assert.equal(normalizedVersion(codegen.pypi_version), codegen.version, "PyPI version mismatch");
  assert.equal(codegen.npm_version, codegen.version, "npm version mismatch");
  check(hex(codegen.sdist_sha256, 64), "malformed codegen sdist hash");
  check(typeof codegen.npm_integrity === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(codegen.npm_integrity), "malformed npm integrity");
  if (compareVersions(x.release_version, "1.6.0-rc.1") < 0) assert.equal(hpo, null, "HPO must be explicitly null before cutoff");
  else {
    keys(hpo, "version package_version tag commit wheel_sha256 sdist_sha256", "hpo");
    assert.equal(hpo.version, x.release_version, "HPO lockstep mismatch");
    assert.equal(normalizedVersion(hpo.package_version), hpo.version, "HPO package spelling mismatch");
    assert.equal(hpo.tag, `v${hpo.package_version}`, "HPO tag mismatch");
    check(hex(hpo.commit, 40) && hex(hpo.wheel_sha256, 64) && hex(hpo.sdist_sha256, 64), "malformed HPO identity");
  }
  return x;
}
export function readLock(path = "release-lock.json", { ready = false } = {}) {
  const x = JSON.parse(readFileSync(path, "utf8"));
  if (!ready && x.schema === "pineforge/offline-bootstrap/v1") {
    keys(x, "schema release_version hub_commit image", "bootstrap");
    version(x.release_version);
    check(hex(x.hub_commit, 40), "malformed bootstrap commit");
    validateImage(x.image);
    return x;
  }
  return validateReady(x);
}
export function verifyManifest(payload, bytes) {
  validateReady(payload);
  assert.equal(sha256(bytes), payload.manifest.sha256, "manifest byte digest mismatch");
  const manifest = JSON.parse(bytes.toString("utf8"));
  check(object(manifest) && !("event_id" in manifest) && !("manifest" in manifest), "manifest must exclude its own identity");
  // The design does not specify a separate manifest schema. Bind every artifact
  // identity in the ready event; allow the hub to include additional evidence.
  for (const key of ["release_version", "prerelease", "hub_commit", "versions", "image", "facts"]) {
    assert.deepEqual(manifest[key], payload[key], `manifest contradicts ${key}`);
  }
  return manifest;
}
export const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
export const api = (path) => JSON.parse(gh("api", path));
async function bytes(url) {
  const r = await fetch(url);
  check(r.ok, `${new URL(url).host}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function tagCommit(repo, tag) {
  let ref = api(`repos/${repo}/git/ref/tags/${tag}`).object;
  for (let n = 0; ref.type === "tag" && n < 5; n++) ref = api(`repos/${repo}/git/tags/${ref.sha}`).object;
  check(ref.type === "commit" && hex(ref.sha, 40), "unresolved release tag");
  return ref.sha;
}
export function downloadManifest(payload) {
  validateReady(payload);
  const dir = mkdtempSync(join(tmpdir(), "pf-ready-"));
  gh("release", "download", `v${payload.release_version}`, "--repo", HUB, "--pattern", "release-manifest.json", "--dir", dir);
  const b = readFileSync(join(dir, "release-manifest.json"));
  verifyManifest(payload, b);
  return b;
}
export async function verifyOCI(lock) {
  validateImage(lock.image);
  const token = JSON.parse((await bytes(`https://ghcr.io/token?scope=repository:${HUB}:pull`)).toString()).token;
  const get = async (kind, hash) => {
    const r = await fetch(`https://ghcr.io/v2/${HUB}/${kind}/${hash}`, { headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json",
    } });
    check(r.ok, `OCI ${kind}: HTTP ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(`sha256:${sha256(b)}`, hash, "OCI content hash mismatch");
    return JSON.parse(b);
  };
  const index = await get("manifests", lock.image.digest);
  for (const arch of ["amd64", "arm64"]) {
    const child = index.manifests.filter((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
    assert.equal(child.length, 1, `missing/duplicate linux/${arch}`);
    assert.equal(child[0].digest, lock.image[`${arch}_digest`], "wrong architecture digest");
    const manifest = await get("manifests", child[0].digest);
    const config = await get("blobs", manifest.config.digest);
    assert.equal(config.architecture, arch, "config architecture mismatch");
    const labels = config.config.Labels;
    assert.equal(labels["org.opencontainers.image.source"], `https://github.com/${HUB}`, "wrong OCI source");
    assert.equal(labels["org.opencontainers.image.revision"], lock.hub_commit, "wrong OCI hub commit");
    assert.equal(normalizedVersion(labels["org.opencontainers.image.version"]), lock.release_version, "wrong OCI release");
    for (const name of ["engine", "codegen", "hpo"]) if (lock.versions?.[name]) {
      assert.equal(normalizedVersion(labels[`io.pineforge.${name}.version`]), lock.versions[name].version, `wrong OCI ${name}`);
    }
  }
}
export async function verifyArtifacts(payload, manifestBytes) {
  verifyManifest(payload, manifestBytes);
  assert.equal(await tagCommit(HUB, `v${payload.release_version}`), payload.hub_commit, "hub tag moved");
  assert.equal(await tagCommit("pineforge-4pass/pineforge-engine", payload.versions.engine.tag), payload.versions.engine.commit, "engine tag mismatch");
  const factsBytes = await bytes(`https://raw.githubusercontent.com/${HUB}/${payload.facts.commit}/${payload.facts.path}`);
  assert.equal(sha256(factsBytes), payload.facts.sha256, "facts byte digest mismatch");
  const releaseFacts = JSON.parse(factsBytes).releases?.[payload.facts.release_key];
  check(object(releaseFacts) && Object.keys(releaseFacts).length > 0, "missing/empty measured release facts entry");
  const cg = payload.versions.codegen;
  assert.equal(await tagCommit("pineforge-4pass/pineforge-codegen-oss", `v${cg.version}`), cg.commit, "codegen source mismatch");
  const py = JSON.parse(await bytes(`https://pypi.org/pypi/pineforge-codegen/${cg.pypi_version}/json`));
  const sdist = py.urls.find((f) => f.packagetype === "sdist" && f.digests.sha256 === cg.sdist_sha256);
  check(sdist && new URL(sdist.url).hostname === "files.pythonhosted.org", "missing codegen sdist");
  assert.equal(sha256(await bytes(sdist.url)), cg.sdist_sha256, "sdist bytes mismatch");
  const npm = JSON.parse(await bytes(`https://registry.npmjs.org/@pineforge%2fcodegen-pyodide/${cg.npm_version}`));
  assert.equal(npm.dist.integrity, cg.npm_integrity, "npm registry identity mismatch");
  assert.equal(new URL(npm.dist.tarball).hostname, "registry.npmjs.org", "unexpected npm source");
  assert.equal(`sha512-${createHash("sha512").update(await bytes(npm.dist.tarball)).digest("base64")}`, cg.npm_integrity, "npm artifact bytes mismatch");
  const hpo = payload.versions.hpo;
  if (hpo) {
    const repo = "pineforge-4pass/pineforge-hpo";
    assert.equal(await tagCommit(repo, hpo.tag), hpo.commit, "HPO source mismatch");
    const dir = mkdtempSync(join(tmpdir(), "pf-hpo-"));
    gh("release", "download", hpo.tag, "--repo", repo, "--pattern", "*.whl", "--pattern", "*.tar.gz", "--dir", dir);
    const { readdirSync } = await import("node:fs");
    for (const [ext, hash] of [[".whl", hpo.wheel_sha256], [".tar.gz", hpo.sdist_sha256]]) {
      check(readdirSync(dir).some((f) => f.endsWith(ext) && sha256(readFileSync(join(dir, f))) === hash), `missing HPO ${ext} bytes`);
    }
  }
  await verifyOCI(payload);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const lock = readLock("release-lock.json", { ready: process.argv[2] === "verify" });
    if (process.argv[2] === "verify") await verifyArtifacts(lock, readFileSync("release-manifest.json"));
    else if (process.argv[2] === "image") await verifyOCI(lock);
    else if (process.argv[2] !== "show") throw new Error("expected verify, image or show");
    console.log(`release=${lock.release_version}\nimage=${lock.image.repository}@${lock.image.digest}\nevent_id=${lock.event_id ?? "bootstrap"}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
