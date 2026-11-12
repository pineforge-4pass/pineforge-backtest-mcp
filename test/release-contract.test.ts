import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// ── Engine parity: hub releases 1.11.0 and later ─────────────────────────────
// The hub's own 1.12.0 documents, byte for byte: the manifest asset, the ready
// event that names it and the candidate record the hub kept for that release.
const hubFile = (name: string) => readFileSync(new URL(`./fixtures/release/hub-1.12.0-${name}.json`, import.meta.url));
const hubManifest = hubFile("release-manifest");
const hubReady = JSON.parse(hubFile("release-ready").toString());
const hubCandidate = JSON.parse(hubFile("release-candidate").toString());
const digestOf = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
// The dispatch payload: the manifest's fields, the ready event's id and the manifest's own identity.
const hubPayload = (): any => ({
  ...JSON.parse(hubManifest.toString()),
  event_id: hubReady.event_id,
  manifest: { asset: "release-manifest.json", sha256: digestOf(hubManifest) },
});
const PARITY_KEYS: string[] = Object.keys(hubPayload().versions.engine.parity);
const PAYLOAD_NAMES: string[] = Object.keys(hubPayload().versions.engine.parity.payload_sha256);

// The hub's two hash bindings, written out here on their own rather than taken from the receiver.
// Descriptor: the four bound fields as compact JSON with keys sorted at every level, then one newline.
const descriptorText = (parity: any) => JSON.stringify({
  engine_commit: parity.engine_commit,
  payload_sha256: Object.fromEntries(Object.keys(parity.payload_sha256).sort().map((name) => [name, parity.payload_sha256[name]])),
  schema: parity.schema,
  source_manifest_sha256: parity.source_manifest_sha256,
}) + "\n";
// Sums: the descriptor line, then each payload file in sorted order, two spaces between digest and name.
const lines = (parity: any, names: string[], gap = "  ") => names.map((name) => `${parity.payload_sha256[name]}${gap}${name}\n`).join("");
const sumsOver = (parity: any, descriptor: string) =>
  digestOf(`${descriptor}  PARITY-MANIFEST.json\n${lines(parity, Object.keys(parity.payload_sha256).sort())}`);
function bind(parity: any): any {
  parity.descriptor_sha256 = digestOf(descriptorText(parity));
  parity.sums_sha256 = sumsOver(parity, parity.descriptor_sha256);
  return parity;
}
// The same hub release re-labelled as another one: every field tied to the release version moves with it.
function atRelease(p: any, release: string): any {
  p.release_version = release;
  p.facts.release_key = release;
  const { engine, codegen, hpo } = p.versions;
  engine.version = codegen.version = hpo.version = release;
  engine.tag = hpo.tag = `v${release}`;
  codegen.pypi_version = codegen.npm_version = hpo.package_version = release;
  return p;
}
// The receiver's own text is the first line of the error: node may follow it with a diff of the compared values.
function refusesWith(fn: () => unknown, message: string) {
  assert.throws(fn, (error: any) => {
    assert.equal(String(error.message).split("\n")[0], message);
    return true;
  });
}
// One corruption of the real engine object at a time; the payload must fail on exactly this message.
function refused(label: string, message: string, corrupt: (engine: any) => void) {
  test(`${label} is refused`, () => {
    const p = hubPayload();
    corrupt(p.versions.engine);
    refusesWith(() => validateReady(p), message);
  });
}
const other = (digest: string) => `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
const spellings: Array<[string, (digest: string) => string]> = [
  ["upper-case", (d) => { assert.notEqual(d.toUpperCase(), d); return d.toUpperCase(); }],
  ["non-hex", (d) => `g${d.slice(1)}`],
  ["one-digit-short", (d) => d.slice(1)],
  ["newline-terminated", (d) => `${d}\n`],
];

test("the hub's real 1.12.0 manifest and the dispatch payload built from it pass, engine parity included", () => {
  const p = hubPayload();
  assert.equal(p.event_id, `sha256:${digestOf(hubManifest)}`, "the ready event names these manifest bytes");
  assert.deepEqual(Object.keys(p.versions.engine).sort(), ["commit", "parity", "tag", "version"]);
  assert.equal(validateReady(p).release_version, "1.12.0");
  assert.equal(verifyManifest(p, hubManifest).release_version, "1.12.0");
});

test("the real parity hashes are reproduced here from the manifest's own values and match the hub's candidate record", () => {
  const parity = hubPayload().versions.engine.parity;
  assert.deepEqual(bind({ ...structuredClone(parity), descriptor_sha256: "", sums_sha256: "" }), parity);
  const listed = hubCandidate.inventories.parity;
  assert.deepEqual(Object.keys(listed).sort(), [...PAYLOAD_NAMES, "PARITY-MANIFEST.json", "PARITY-SHA256SUMS"].sort());
  assert.equal(listed["PARITY-MANIFEST.json"], parity.descriptor_sha256);
  assert.equal(listed["PARITY-SHA256SUMS"], parity.sums_sha256);
  for (const name of PAYLOAD_NAMES) assert.equal(listed[name], parity.payload_sha256[name], name);
  assert.deepEqual(hubCandidate.versions.engine, hubPayload().versions.engine);
});

test("a parity block that agrees with its own bindings passes whoever made it, and the manifest bytes still bind it", () => {
  const p = hubPayload();
  const e = p.versions.engine;
  e.commit = e.parity.engine_commit = "b".repeat(40);
  e.parity.source_manifest_sha256 = digestOf("another source manifest");
  for (const name of PAYLOAD_NAMES) e.parity.payload_sha256[name] = digestOf(`another ${name}`);
  bind(e.parity);
  assert.notEqual(e.parity.descriptor_sha256, hubPayload().versions.engine.parity.descriptor_sha256);
  assert.equal(validateReady(p).release_version, "1.12.0");
  refusesWith(() => verifyManifest(p, hubManifest), "manifest contradicts versions");
});

test("the bindings are computed on sorted keys, whatever order the received object lists them in", () => {
  const reversed = (x: any): any => Array.isArray(x) ? x.map(reversed)
    : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reversed(v)])) : x;
  const p = hubPayload();
  p.versions.engine = reversed(p.versions.engine);
  assert.deepEqual(Object.keys(p.versions.engine.parity.payload_sha256), [...PAYLOAD_NAMES].reverse());
  assert.equal(validateReady(p).release_version, "1.12.0");
});

// Malformed parity, one defect at a time.
for (const key of PARITY_KEYS) refused(`parity without ${key}`, "engine parity: unexpected/missing fields", (e) => { delete e.parity[key]; });
refused("parity with an extra key", "engine parity: unexpected/missing fields", (e) => { e.parity.extra = digestOf("extra"); bind(e.parity); });
for (const schema of ["pineforge/parity-descriptor/v2", "pineforge/parity-descriptor/v1 ", "pineforge/release-ready/v1"]) {
  refused(`parity schema ${JSON.stringify(schema)}`, "engine parity schema mismatch", (e) => { e.parity.schema = schema; bind(e.parity); });
}
refused("a parity engine_commit that differs from the engine commit", "engine parity commit mismatch", (e) => { e.parity.engine_commit = "a".repeat(40); bind(e.parity); });
refused("an engine commit that differs from the parity engine_commit", "engine parity commit mismatch", (e) => { e.commit = "a".repeat(40); });
for (const [label, spell] of spellings) {
  refused(`${label} parity engine_commit`, "malformed engine parity commit", (e) => { e.parity.engine_commit = spell(e.parity.engine_commit); });
  refused(`${label} engine commit repeated in parity`, "malformed engine parity commit", (e) => { e.commit = e.parity.engine_commit = spell(e.commit); });
}
for (const key of ["source_manifest_sha256", "descriptor_sha256", "sums_sha256"]) for (const [label, spell] of spellings) {
  refused(`${label} ${key}`, `malformed engine parity ${key}`, (e) => { e.parity[key] = spell(e.parity[key]); });
}
refused("a null sums_sha256", "malformed engine parity sums_sha256", (e) => { e.parity.sums_sha256 = null; });
for (const name of PAYLOAD_NAMES) for (const [label, spell] of spellings) {
  refused(`${label} payload digest of ${name}`, `malformed engine parity payload digest ${name}`, (e) => { e.parity.payload_sha256[name] = spell(e.parity.payload_sha256[name]); });
}
for (const name of PAYLOAD_NAMES) {
  refused(`payload without ${name}`, "engine parity payload: unexpected/missing fields", (e) => { delete e.parity.payload_sha256[name]; bind(e.parity); });
}
refused("payload with an added file", "engine parity payload: unexpected/missing fields", (e) => { e.parity.payload_sha256["added_tool.py"] = digestOf("added"); bind(e.parity); });
refused("payload with a renamed file", "engine parity payload: unexpected/missing fields", (e) => {
  const name = PAYLOAD_NAMES[0] as string;
  e.parity.payload_sha256[name.toUpperCase()] = e.parity.payload_sha256[name];
  delete e.parity.payload_sha256[name];
  bind(e.parity);
});
for (const [label, value] of [["null", null], ["an array", []], ["a string", "digests"]] as Array<[string, unknown]>) {
  refused(`parity given as ${label}`, "engine parity: expected object", (e) => { e.parity = value; });
  refused(`payload_sha256 given as ${label}`, "engine parity payload: expected object", (e) => { e.parity.payload_sha256 = value; });
}
refused("a descriptor hash that does not match", "engine parity descriptor hash mismatch", (e) => { e.parity.descriptor_sha256 = other(e.parity.descriptor_sha256); });
refused("a sums hash that does not match", "engine parity sums hash mismatch", (e) => { e.parity.sums_sha256 = other(e.parity.sums_sha256); });
refused("a payload digest changed after the bindings were made", "engine parity descriptor hash mismatch", (e) => {
  const name = PAYLOAD_NAMES[0] as string;
  e.parity.payload_sha256[name] = other(e.parity.payload_sha256[name]);
});
refused("a source manifest digest changed after the bindings were made", "engine parity descriptor hash mismatch", (e) => {
  e.parity.source_manifest_sha256 = other(e.parity.source_manifest_sha256);
});
refused("a payload digest changed with only the descriptor hash re-bound", "engine parity sums hash mismatch", (e) => {
  const name = PAYLOAD_NAMES[1] as string;
  const sums = e.parity.sums_sha256;
  e.parity.payload_sha256[name] = other(e.parity.payload_sha256[name]);
  bind(e.parity);
  e.parity.sums_sha256 = sums;
});
refused("a descriptor hashed without its trailing newline", "engine parity descriptor hash mismatch", (e) => {
  e.parity.descriptor_sha256 = digestOf(descriptorText(e.parity).trimEnd());
  e.parity.sums_sha256 = sumsOver(e.parity, e.parity.descriptor_sha256);
});
refused("a descriptor hashed with its fields in listed rather than sorted order", "engine parity descriptor hash mismatch", (e) => {
  const p = e.parity;
  p.descriptor_sha256 = digestOf(JSON.stringify({
    schema: p.schema, source_manifest_sha256: p.source_manifest_sha256, engine_commit: p.engine_commit, payload_sha256: p.payload_sha256,
  }) + "\n");
  p.sums_sha256 = sumsOver(p, p.descriptor_sha256);
});
refused("a sums hash over single-space lines", "engine parity sums hash mismatch", (e) => {
  e.parity.sums_sha256 = digestOf(`${e.parity.descriptor_sha256} PARITY-MANIFEST.json\n${lines(e.parity, PAYLOAD_NAMES, " ")}`);
});
refused("a sums hash over unsorted payload lines", "engine parity sums hash mismatch", (e) => {
  e.parity.sums_sha256 = digestOf(`${e.parity.descriptor_sha256}  PARITY-MANIFEST.json\n${lines(e.parity, [...PAYLOAD_NAMES].reverse())}`);
});
refused("a sums hash that omits the descriptor line", "engine parity sums hash mismatch", (e) => {
  e.parity.sums_sha256 = digestOf(lines(e.parity, PAYLOAD_NAMES));
});

// Nothing else about the engine object loosens.
refused("an extra field beside parity in the engine object", "engine: unexpected/missing fields", (e) => { e.extra = "x"; });
refused("an engine object without its tag", "engine: unexpected/missing fields", (e) => { delete e.tag; });
refused("an engine tag that is not v<version>", "engine tag mismatch", (e) => { e.tag = "v1.12.1"; });
refused("an engine version that is not the release", "engine lockstep mismatch", (e) => { e.version = "1.12.1"; e.tag = "v1.12.1"; });

test("an unknown engine field is refused below 1.11.0 as well", () => {
  const p = clone();
  p.versions.engine.extra = "x";
  refusesWith(() => validateReady(p), "engine: unexpected/missing fields");
});

test("parity is accepted in the engine object only", () => {
  const parity = hubPayload().versions.engine.parity;
  for (const [put, message] of [
    [(p: any) => { p.versions.codegen.parity = parity; }, "codegen: unexpected/missing fields"],
    [(p: any) => { p.versions.hpo.parity = parity; }, "hpo: unexpected/missing fields"],
    [(p: any) => { p.versions.parity = parity; }, "versions: unexpected/missing fields"],
    [(p: any) => { p.parity = parity; }, "ready payload: unexpected/missing fields"],
  ] as Array<[(p: any) => void, string]>) {
    const p = hubPayload();
    put(p);
    refusesWith(() => validateReady(p), message);
  }
});

// The cut-off: releases below 1.11.0 keep the three historical engine fields, 1.11.0 and later carry parity.
for (const release of ["1.8.0", "1.9.0", "1.10.0"]) {
  test(`release ${release} keeps the three historical engine fields and refuses parity`, () => {
    const legacy = atRelease(hubPayload(), release);
    delete legacy.versions.engine.parity;
    assert.deepEqual(Object.keys(legacy.versions.engine).sort(), ["commit", "tag", "version"]);
    assert.equal(validateReady(legacy).release_version, release);
    refusesWith(() => validateReady(atRelease(hubPayload(), release)), "engine: unexpected/missing fields");
  });
}
for (const release of ["1.11.0", "1.12.0", "2.0.0"]) {
  test(`release ${release} requires engine parity: with it the payload passes, without it it is refused`, () => {
    assert.equal(validateReady(atRelease(hubPayload(), release)).release_version, release);
    const without = atRelease(hubPayload(), release);
    delete without.versions.engine.parity;
    refusesWith(() => validateReady(without), "engine: unexpected/missing fields");
  });
}
