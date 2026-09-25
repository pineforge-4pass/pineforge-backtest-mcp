import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  channel,
  checkPayload,
  compareVersions,
  gate,
  latestTag,
  nextVersion,
  parseVersion,
} from "../scripts/release-version.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/release-version.mjs", import.meta.url));

function cli(args: string[], stdin = "") {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin, encoding: "utf8" });
  const out: Record<string, string> = {};
  for (const line of proc.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { status: proc.status, out, stderr: proc.stderr, stdout: proc.stdout };
}

test("a prerelease sorts below its release (sort -V and git's v:refname get this backwards)", () => {
  const ordered = ["0.1.25", "1.0.0-alpha.1", "1.0.0-beta.1", "1.0.0-rc.1", "1.0.0-rc.2",
    "1.0.0-rc.10", "1.0.0", "1.0.1"];
  const shuffled = [...ordered].reverse();
  assert.deepEqual(shuffled.sort(compareVersions), ordered);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
});

test("only X.Y.Z and X.Y.Z-{alpha,beta,rc}.N are versions", () => {
  for (const bad of ["1.0.0rc1", "1.0.0-rc1", "1.0.0-RC.1", "1.0", "01.0.0", "1.0.0-rc.01",
    "1.0.0+b", "", "latest"]) {
    assert.throws(() => parseVersion(bad), /rejected version/, bad);
  }
});

test("latest tag is the semver maximum, prereleases included", () => {
  assert.equal(latestTag(["v0.9.31", "v0.9.32-rc.1", "v0.9.32", "junk"]), "v0.9.32");
  assert.equal(latestTag(["v0.9.31", "v0.9.32-rc.1"]), "v0.9.32-rc.1");
  assert.equal(latestTag(["v0.9.9", "v0.9.10"]), "v0.9.10");
  assert.equal(latestTag([]), "");
});

test("the payload flag must agree with the release version", () => {
  assert.deepEqual(checkPayload("1.0.0-rc.1", "true"), { version: "1.0.0-rc.1", prerelease: true });
  assert.deepEqual(checkPayload("v1.0.0", ""), { version: "1.0.0", prerelease: false });
  assert.deepEqual(checkPayload("1.0.0-rc.1", ""), { version: "1.0.0-rc.1", prerelease: true });
  assert.throws(() => checkPayload("1.0.0-rc.1", "false"), /contradicts/);
  assert.throws(() => checkPayload("1.0.0", "true"), /contradicts/);
  assert.throws(() => checkPayload("1.0.0", "yes"), /prerelease/);
});

test("gate: new base proceeds, duplicates and older bases are absorbed", () => {
  assert.equal(gate("0.1.25", "1.0.0-rc.1").proceed, true);
  assert.equal(gate("1.0.0-rc.1", "1.0.0").proceed, true); // sort -V would call this a downgrade
  assert.equal(gate("", "0.1.25").proceed, true);
  assert.equal(gate("1.0.0", "1.0.0").proceed, false);
  assert.equal(gate("1.0.0", "1.0.0-rc.1").proceed, false);
  assert.match(gate("1.0.0", "1.0.0-rc.1").reason, /downgrade guard/);
});

test("next version: a prerelease base gets a prerelease of the next patch", () => {
  assert.equal(nextVersion("0.9.31", "1.0.0-rc.1", []), "0.9.32-rc.1");
  assert.equal(nextVersion("0.9.32-rc.1", "1.0.0-rc.2", ["v0.9.32-rc.1"]), "0.9.32-rc.2");
  assert.equal(nextVersion("0.9.32-rc.2", "1.0.0", ["v0.9.32-rc.1", "v0.9.32-rc.2"]), "0.9.32");
  assert.equal(nextVersion("0.9.32", "1.0.1", ["v0.9.32"]), "0.9.33");
  assert.equal(nextVersion("0.9.31", "0.1.26", []), "0.9.32");
});

test("next version skips burned tags and never goes backwards", () => {
  assert.equal(nextVersion("0.9.31", "0.1.26", ["v0.9.32", "v0.9.33"]), "0.9.34");
  assert.equal(nextVersion("0.9.31", "1.0.0-rc.1", ["v0.9.32-rc.1"]), "0.9.33-rc.1");
  assert.equal(nextVersion("0.9.33-rc.1", "1.1.0-alpha.1", []), "0.9.34-alpha.1");
});

test("channel: prereleases go to npm next and never to latest", () => {
  assert.deepEqual(channel("0.9.32-rc.1"), { prerelease: true, npmDistTag: "next" });
  assert.deepEqual(channel("0.9.32"), { prerelease: false, npmDistTag: "latest" });
});

test("cli: payload, gate, next and channel print $GITHUB_OUTPUT lines", () => {
  let r = cli(["check-payload", "--release-version=v1.0.0-rc.1", "--prerelease-flag=true"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { version: "1.0.0-rc.1", prerelease: "true" });

  r = cli(["gate", "--current=1.0.0-rc.1", "--incoming=1.0.0"]);
  assert.deepEqual(r.out, { proceed: "true" });

  r = cli(["next", "--current=0.9.31", "--release=1.0.0-rc.1"], "v0.9.30\nv0.9.31\n");
  assert.deepEqual(r.out, { next: "0.9.32-rc.1", tag: "v0.9.32-rc.1", prerelease: "true" });

  r = cli(["latest-tag"], "v0.9.32-rc.1\nv0.9.32\n");
  assert.equal(r.stdout, "v0.9.32\n");

  r = cli(["channel", "0.9.32-rc.1"]);
  assert.deepEqual(r.out, { prerelease: "true", npm_dist_tag: "next" });
});

test("cli: a broken rule fails loud with no outputs", () => {
  const r = cli(["check-payload", "--release-version=1.0.0-rc.1", "--prerelease-flag=false"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^::error::/);
});
