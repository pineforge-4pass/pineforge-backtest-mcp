import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore workflow module.
import { verifyEvidence } from "../scripts/release-evidence.mjs";
// @ts-ignore workflow module.
import { verifyTap, verifyVouchTap } from "../scripts/runtime-e2e.mjs";
const lock = JSON.parse(readFileSync(new URL("./fixtures/release/release-ready-v1.json", import.meta.url), "utf8"));
const inventory = JSON.parse(readFileSync(new URL("./fixtures/release/runtime-inventory.json", import.meta.url), "utf8"));
function evidence() {
  return ["amd64", "arm64"].flatMap((arch) => ["npm", "image"].map((mode) => ({
    arch, mode, source_sha: "1".repeat(40), run_id: "17", event_id: lock.event_id,
    artifact_attempt: "1", package_integrity: `sha512-${"A".repeat(86)}==`,
    hub_image: `${lock.image.repository}@${lock.image.digest}`, image_id: `sha256:${"7".repeat(64)}`,
    suites: Object.entries(inventory.suites).map(([suite, expected]) => ({ suite, expected, passed: expected, skipped: 0, result: "success" })),
  })));
}

test("both entry points on both architectures with every declared suite authorize readiness", () => {
  assert.equal(verifyEvidence(lock, inventory, evidence(), "1".repeat(40), "17"), true);
});
for (const [label, corrupt] of [
  ["missing arm64", (e: any[]) => e.splice(2)],
  ["stale head", (e: any[]) => { e[0].source_sha = "2".repeat(40); }],
  ["stale run", (e: any[]) => { e[0].run_id = "16"; }],
  ["wrong manifest", (e: any[]) => { e[0].event_id = `sha256:${"9".repeat(64)}`; }],
  ["wrong image", (e: any[]) => { e[0].hub_image = "ghcr.io/pineforge-4pass/pineforge-release:latest"; }],
  ["skipped negative suite", (e: any[]) => { e[0].suites[3].skipped = 1; }],
  ["failed syminfo", (e: any[]) => { e[0].suites[2].result = "failure"; }],
  ["missing suite", (e: any[]) => e[0].suites.pop()],
  ["zero tests", (e: any[]) => { e[0].suites[0].passed = 0; }],
  ["duplicate architecture", (e: any[]) => { e[2].arch = "amd64"; }],
] as Array<[string, (e: any[]) => void]>) {
  test(`RED: ${label} blocks the aggregate`, () => { const e = evidence(); corrupt(e); assert.throws(() => verifyEvidence(lock, inventory, e, "1".repeat(40), "17")); });
}
const tap = "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
test("an empty, skipped or failed runtime run can never pass by exit code alone", () => {
  assert.doesNotThrow(() => verifyTap(tap, 1));
  assert.throws(() => verifyTap("", 1));
  assert.throws(() => verifyTap(tap, 0));
  assert.throws(() => verifyTap(tap.replace("# skipped 0", "# skipped 1"), 1));
  assert.throws(() => verifyTap(tap.replace("# fail 0", "# fail 1"), 1));
  assert.throws(() => verifyTap(tap, 2));
});

const vouchName = "the pinned release image accepts its generated C++ vouch and refuses changed mounted bytes";
const legacyReason = "legacy release before 1.9.1: pinned image predates strategy.cpp vouch enforcement";
const vouchPass = `ok 1 - ${vouchName}`;
const vouchSkip = `${vouchPass} # SKIP ${legacyReason}`;
const currentRelease = "1.13.0";
const legacyRelease = "1.9.0";

function vouchTap(result: string, skipped = false) {
  return tap.replace("1..1\n", `${result}\n1..1\n`)
    .replace("# pass 1", `# pass ${skipped ? 0 : 1}`)
    .replace("# skipped 0", `# skipped ${skipped ? 1 : 0}`);
}

test("vouch TAP: accepts the named pass", () => {
  assert.doesNotThrow(() => verifyVouchTap(vouchTap(vouchPass), currentRelease));
});

test("vouch TAP: accepts the named legacy skip", () => {
  assert.doesNotThrow(() => verifyVouchTap(vouchTap(vouchSkip, true), legacyRelease));
});

test("vouch TAP: rejects a legacy skip with the wrong reason", () => {
  assert.throws(() => verifyVouchTap(vouchTap(`${vouchPass} # SKIP not supported`, true), legacyRelease));
});

for (const [label, release, output, error] of [
  ["a green file entry with no test", currentRelease, vouchTap("ok 1 - test/e2e/strategy-cpp-vouch.e2e.ts"), /unexpected named vouch result/],
  ["an unrelated pass", currentRelease, vouchTap("ok 1 - a different control"), /unexpected named vouch result/],
  ["a nested named pass", currentRelease, vouchTap(`    ${vouchPass}\nok 1 - a different control`), /unexpected named vouch result/],
  ["a failed named result with green totals", currentRelease, vouchTap(`not ${vouchPass}`), /unexpected named vouch result/],
  ["a canonical #67 skip", currentRelease, vouchTap(vouchSkip, true), /vouch control must pass exactly once/],
  ["a #67 skip with green totals and a lowercase directive", currentRelease, vouchTap(`${vouchPass} # skip ${legacyReason}`), /unexpected named vouch result/],
  ["a legacy skip whose reason appears only in a comment", legacyRelease, vouchTap(`${vouchPass} # SKIP\n# diagnostic: # SKIP ${legacyReason}`, true), /unexpected named vouch result/],
  ["a decorated named pass", currentRelease, vouchTap(`${vouchPass} # TODO investigate`), /unexpected named vouch result/],
  ["duplicate result rows", currentRelease, vouchTap(`${vouchPass}\nok 2 - ${vouchName}`), /expected exactly one top-level vouch result/],
  ["a legacy skip with extra text in its reason", legacyRelease, vouchTap(`${vouchSkip} (unverified)`, true), /unexpected named vouch result/],
] as const) {
  test(`vouch TAP: rejects ${label}`, () => {
    assert.throws(() => verifyVouchTap(output, release), error);
  });
}

test("pinned suite counts cover the actual existing stdio tests", () => {
  for (const [suite, expected] of Object.entries(inventory.suites)) {
    const source = readFileSync(new URL(`./e2e/${suite}`, import.meta.url), "utf8");
    assert.equal([...source.matchAll(/^test\(/gm)].length, expected, `${suite} inventory drift`);
  }
  assert.ok(inventory.parity_sample > 0);
  assert.match(inventory.corpus_commit, /^[0-9a-f]{40}$/);
});
