import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The fan-out workflows run scripts/release-version.mjs where its rules apply,
// so a prerelease base never reaches npm latest, the latest image, the MCP
// Registry or GitHub's Latest release.
const read = (name: string) =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
const handler = read("pineforge-release.yml");
const publish = read("publish.yml");

function step(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `no step "${name}"`);
  const next = text.indexOf("\n      - ", start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `no job "${name}"`);
  const next = text.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

test("no rc-unsafe version sort is left in the fan-out", () => {
  for (const text of [handler, publish]) {
    assert.ok(!text.includes("sort -V"));
    assert.ok(!text.includes("--sort=-v:refname"));
  }
});

test("handler validates the prerelease flag against the release version", () => {
  const body = step(handler, "Validate release_version");
  assert.match(body, /RAW_PRERELEASE: \$\{\{ github\.event\.client_payload\.prerelease \}\}/);
  assert.ok(body.includes("node scripts/release-version.mjs check-payload"));
});

test("handler gate and next version come from the release rules", () => {
  const gate = step(handler, "Idempotency");
  assert.ok(gate.includes("git tag -l 'v*' | node scripts/release-version.mjs latest-tag"));
  assert.ok(gate.includes("node scripts/release-version.mjs gate"));
  const next = step(handler, "Compute next backtest-mcp version");
  assert.ok(next.includes("node scripts/release-version.mjs next"));
  assert.ok(handler.indexOf("- name: Setup Node") < handler.indexOf("- name: Validate release_version"));
});

test("npm publish names a dist-tag only for a prerelease (next)", () => {
  // An explicit --tag, even latest, bypasses npm's refusal to move latest to a
  // lower version, so a stable publish keeps the plain command.
  assert.ok(step(publish, "Release channel from VERSION").includes("node scripts/release-version.mjs channel"));
  const body = step(publish, "Publish to npm");
  assert.match(body, /DIST_TAG: \$\{\{ steps\.channel\.outputs\.npm_dist_tag \}\}/);
  assert.ok(body.includes('if [ "$DIST_TAG" != latest ]; then tag=(--tag "$DIST_TAG"); fi'));
  assert.ok(body.includes('npm publish --access=public ${tag[@]+"${tag[@]}"}'));
  assert.ok(!body.includes("--tag latest"));
});

test("a prerelease GitHub release is never Latest", () => {
  const body = step(publish, "Create GitHub Release");
  assert.match(body, /PRERELEASE: \$\{\{ needs\.publish\.outputs\.prerelease \}\}/);
  assert.ok(body.includes('case "$PRERELEASE" in true|false) ;;'), "an empty flag must fail, not publish a stable release");
  assert.ok(body.includes("--prerelease --latest=false"));
});

test("the latest image tag is for stable releases only", () => {
  const tags = step(publish, "Image tags");
  assert.ok(tags.includes('case "$PRERELEASE" in true|false) ;;'), "an empty flag must fail, not tag latest");
  assert.ok(tags.includes('[ "$PRERELEASE" = true ] || echo "${img}:latest"'));
  assert.ok(job(publish, "image").includes("tags: ${{ steps.tags.outputs.list }}"));
  assert.ok(!job(publish, "image").includes("pineforge-backtest-mcp:latest\n"));
});

test("a prerelease tag never falls back to a guessed stable base", () => {
  const body = step(publish, "Resolve base pineforge-release version");
  assert.ok(body.includes("refusing to guess a stable base"));
});

test("a stable tag never builds latest on a prerelease base", () => {
  const body = step(publish, "Resolve base pineforge-release version");
  assert.ok(body.includes('node scripts/release-version.mjs channel "$rel"'));
  assert.ok(body.includes("carries the prerelease base"));
});

test("the MCP Registry gets stable releases only", () => {
  const registry = job(publish, "mcp-registry");
  assert.ok(registry.includes("needs: [publish, image]"));
  assert.ok(registry.includes("needs.publish.outputs.prerelease == 'false'"));
});
