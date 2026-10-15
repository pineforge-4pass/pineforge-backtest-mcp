import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore JavaScript workflow helpers are tested directly by CI.
import { validateReady, verifyManifest, normalizedVersion, sha256, readLock } from "../scripts/release-contract.mjs";
// @ts-ignore JavaScript workflow helper.
import { decision, marker } from "../scripts/release-consumer.mjs";
import { DEFAULT_IMAGE, DockerRunner } from "../src/engine.js";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/release/release-ready-v1.json", import.meta.url), "utf8"));
const manifest = readFileSync(new URL("./fixtures/release/manifest-v1.json", import.meta.url));
const clone = () => structuredClone(fixture);

test("the exact section 3.2 fixture binds all artifact identities to original bytes", () => {
  assert.equal(validateReady(clone()).schema, "pineforge/release-ready/v1");
  assert.equal(verifyManifest(clone(), manifest).release_version, "1.6.0");
  assert.equal(sha256(manifest), fixture.manifest.sha256);
  assert.equal(normalizedVersion("1.6.0rc1"), "1.6.0-rc.1");
  assert.equal(normalizedVersion("1.6.0b2"), "1.6.0-beta.2");
});

for (const [label, corrupt] of [
  ["legacy payload", (p: any) => { delete p.schema; }],
  ["boolean string", (p: any) => { p.prerelease = "false"; }],
  ["contradictory flag", (p: any) => { p.prerelease = true; }],
  ["array versions", (p: any) => { p.versions = []; }],
  ["missing HPO after cutoff", (p: any) => { p.versions.hpo = null; }],
  ["wrong HPO package spelling", (p: any) => { p.versions.hpo.package_version = "1.6.1"; }],
  ["unexpected registry", (p: any) => { p.image.repository = "ghcr.io/attacker/image"; }],
  ["short hash", (p: any) => { p.hub_commit = "abc"; }],
  ["duplicate child", (p: any) => { p.image.arm64_digest = p.image.amd64_digest; }],
  ["unrelated facts", (p: any) => { p.facts.release_key = "1.5.0"; }],
  ["traversal asset", (p: any) => { p.manifest.asset = "../release-manifest.json"; }],
  ["unexpected field", (p: any) => { p.image.tag = "latest"; }],
  ["wrong component", (p: any) => { p.versions.codegen.version = "1.5.0"; }],
  ["string run", (p: any) => { p.run_id = "123456"; }],
  ["circular event identity", (p: any) => { p.event_id = `sha256:${"0".repeat(64)}`; }],
] as Array<[string, (p: any) => void]>) {
  test(`${label} cannot authorize an update`, () => { const p = clone(); corrupt(p); assert.throws(() => validateReady(p)); });
}

test("manifest corruption fails even if the JSON remains valid", () => {
  assert.throws(() => verifyManifest(clone(), Buffer.concat([manifest, Buffer.from("\n")])), /digest mismatch/);
  const other = JSON.parse(manifest.toString()); other.hub_commit = "a".repeat(40);
  const bytes = Buffer.from(JSON.stringify(other));
  const p = clone(); p.manifest.sha256 = sha256(bytes); p.event_id = `sha256:${p.manifest.sha256}`;
  assert.throws(() => verifyManifest(p, bytes), /contradicts hub_commit/);
});

test("pre-cutoff HPO must be explicitly null", () => {
  const p = clone(); p.release_version = "1.5.1"; p.versions.engine.version = "1.5.1"; p.versions.engine.tag = "v1.5.1";
  Object.assign(p.versions.codegen, { version: "1.5.1", pypi_version: "1.5.1", npm_version: "1.5.1" });
  p.facts.release_key = "1.5.1"; p.versions.hpo = null;
  assert.doesNotThrow(() => validateReady(p));
  delete p.versions.hpo; assert.throws(() => validateReady(p));
});

test("replays reuse identity, immutable conflicts fail and newer desired PRs supersede older ones", () => {
  const p = clone();
  const old = { release_version: "1.5.0", event_id: `sha256:${"a".repeat(64)}` };
  assert.equal(decision(old, p), "new");
  assert.equal(decision(p, p), "duplicate");
  assert.equal(decision(old, p, [p]), "duplicate");
  assert.equal(decision(old, p, [p, { release_version: "1.7.0" }]), "superseded");
  assert.throws(() => decision({ ...p, event_id: "different" }, p), /different immutable manifest/);
  const body = `<!-- pineforge-release ${JSON.stringify({ event_id: p.event_id, base: "main", delivery_run: 1 })} -->`;
  assert.equal(marker(body).event_id, p.event_id);
  assert.throws(() => marker("human PR without marker"));
});

test("RED: an npm package with the former latest default cannot pass the lock assertion", async () => {
  const pin = readLock();
  const expected = `${pin.image.repository}@${pin.image.digest}`;
  assert.equal(DEFAULT_IMAGE, expected);
  assert.equal((await new DockerRunner().engineInfo()).image, expected);
  assert.match(expected, /@sha256:[0-9a-f]{64}$/);
});

test("bootstrap pins are build-only and cannot authorize publication", () => {
  const pin = JSON.parse(readFileSync("release-lock.json", "utf8"));
  if (pin.schema === "pineforge/offline-bootstrap/v1") assert.throws(() => readLock("release-lock.json", { ready: true }));
  else assert.doesNotThrow(() => validateReady(pin));
});
