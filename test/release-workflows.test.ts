import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = (name: string) => parse(read(`.github/workflows/${name}.yml`));
const receiver = workflow("pineforge-release");
const publisher = workflow("publish");
const ci = workflow("test");
const control = workflow("release-pr");
const consumer = read("scripts/release-consumer.mjs");
const distribution = read("scripts/distribution.mjs");
function dependencies(w: any, name: string, seen = new Set<string>()): Set<string> {
  const needs = w.jobs[name].needs ?? [];
  for (const need of typeof needs === "string" ? [needs] : needs) {
    if (!seen.has(need)) { seen.add(need); dependencies(w, need, seen); }
  }
  return seen;
}
function runs(job: any): string { return job.steps.map((s: any) => s.run ?? "").join("\n"); }

test("the original event name accepts only the versioned ready contract", () => {
  assert.deepEqual(receiver.on.repository_dispatch.types, ["pineforge-release"]);
  assert.match(runs(receiver.jobs["update-pr"]), /release-consumer\.mjs receive/);
  assert.match(consumer, /validateReady\(event\.client_payload\)/);
  assert.match(consumer, /verifyArtifacts\(incoming, manifest\)/);
});

test("receipt opens a PR and cannot directly push main or a release tag", () => {
  assert.doesNotMatch(runs(receiver.jobs["update-pr"]), /git push|npm publish|distribution\.mjs/);
  const receive = consumer.slice(consumer.indexOf("async function receive()"), consumer.indexOf("function latestGate"));
  assert.match(receive, /repos\/\$\{REPO\}\/pulls/);
  assert.doesNotMatch(receive, /HEAD:main|refs\/tags|--force|--delete/);
  assert.match(consumer, /nextVersion\(/);
  for (const f of ["VERSION", "package.json", "package-lock.json", "server.json", "release-lock.json", "release-manifest.json"]) assert.ok(consumer.includes(`"${f}"`));
});

test("App tokens are scoped to this consumer and privileged transitions use trusted main", () => {
  for (const w of [receiver, control]) {
    const job = Object.values(w.jobs)[0] as any;
    const app = job.steps.find((s: any) => s.uses?.startsWith("actions/create-github-app-token@"));
    assert.equal(app.with.repositories, "pineforge-backtest-mcp");
    assert.equal(app.with.owner, "${{ github.repository_owner }}");
    assert.equal(app.with["permission-contents"], "write");
    assert.equal(app.with["permission-pull-requests"], "write");
    assert.equal(job.steps.find((s: any) => s.uses?.startsWith("actions/checkout@")).with.ref, "main");
  }
  assert.doesNotMatch(consumer, /--admin|git push.*--force/);
});

test("the required aggregate covers every runtime architecture and packed npm distribution", () => {
  assert.equal(ci.jobs.ready.name, "release/ready");
  assert.equal(ci.jobs.ready.if, "always()");
  assert.deepEqual(ci.jobs.ready.needs, ["test", "runtime"]);
  assert.deepEqual(ci.jobs.runtime.strategy.matrix.include.map((x: any) => x.arch), ["amd64", "arm64"]);
  assert.equal(ci.jobs.runtime.strategy["fail-fast"], false);
  assert.match(runs(ci.jobs.test), /npm run build/);
  assert.match(runs(ci.jobs.test), /npm test/);
  assert.match(runs(ci.jobs.test), /npm pack --ignore-scripts/);
  assert.match(runs(ci.jobs.runtime), /runtime-e2e\.mjs npm/);
  assert.match(runs(ci.jobs.runtime), /runtime-e2e\.mjs image/);
  assert.match(runs(ci.jobs.ready), /release-evidence\.mjs gate/);
});

test("no publication path bypasses the same complete CI and runtime graph", () => {
  assert.equal(publisher.jobs.gates.uses, "./.github/workflows/test.yml");
  for (const name of ["image", "publish", "mcp-registry", "release", "promote"]) assert.ok(dependencies(publisher, name).has("gates"), `${name} bypasses E2E`);
  assert.match(runs(publisher.jobs.publish), /distribution\.mjs npm/);
  assert.doesNotMatch(runs(publisher.jobs.publish), /npm run build|npm install --no-package-lock/);
  assert.match(runs(publisher.jobs.image), /distribution\.mjs image/);
  assert.doesNotMatch(runs(publisher.jobs.image), /build-push-action|buildx build/);
  assert.match(distribution, /saved tested image changed/);
  assert.match(distribution, /packed|tarball|package_integrity/);
});

test("prereleases never reach latest or the MCP Registry", () => {
  assert.equal(publisher.jobs["mcp-registry"].if, "needs.prepare.outputs.prerelease == 'false'");
  assert.match(distribution, /if \(lock\.prerelease\) args\.push\("--prerelease"\)/);
  assert.match(distribution, /--latest=false/);
  assert.match(distribution, /if \(state\.channel === "latest"\)/);
  assert.match(distribution, /package channel contradicts hub/);
});

test("no publication guesses a latest hub base or uses unsafe prerelease sorting", () => {
  for (const text of [consumer, distribution, read(".github/workflows/publish.yml")]) {
    assert.doesNotMatch(text, /sort -V|--sort=-v:refname|release:latest|refusing to guess/);
  }
  assert.match(read("docker/Dockerfile"), /FROM \$\{PINEFORGE_RELEASE_IMAGE\}/);
  assert.doesNotMatch(read("src/engine.ts"), /pineforge-release:latest/);
});

test("channel mutation and restoration use the same OIDC-capable CLI and retain evidence", () => {
  for (const name of ["publish", "promote", "restore"]) {
    assert.equal(publisher.jobs[name].permissions["id-token"], "write");
    assert.match(runs(publisher.jobs[name]), /npm install -g npm@11\.21\.0/);
    const node = publisher.jobs[name].steps.find((s: any) => s.uses?.startsWith("actions/setup-node@"));
    assert.equal(node.with["registry-url"], undefined, "setup-node must not install a fallback auth-token placeholder");
  }
  assert.match(distribution, /npm", "dist-tag", "add"/);
  assert.match(distribution, /oidc-proof\.json/);
  assert.match(distribution, /restoration-receipt\.json/);
  assert.match(distribution, /newer npm channel must not be rolled back/);
});

test("explicit receipt and candidate paths in hidden CI storage are actually uploaded", () => {
  for (const w of [ci, receiver, publisher, control]) for (const job of Object.values(w.jobs) as any[]) {
    for (const s of job.steps ?? []) if (s.uses?.startsWith("actions/upload-artifact@")) {
      assert.equal(s.with["include-hidden-files"], true, "hidden .release-ci artifacts would otherwise be absent");
      assert.match(s.with.path, /\.release-ci\//);
    }
  }
});

test("only ready successful stable distributions can activate latest", () => {
  assert.ok(dependencies(publisher, "promote").has("mcp-registry"));
  assert.match(publisher.jobs.promote.if, /needs\.gates\.result == 'success'/);
  assert.match(publisher.jobs.promote.if, /needs\.mcp-registry\.result == 'success'/);
  assert.match(publisher.jobs.restore.if, /failure/);
  assert.match(publisher.jobs["report-failure"].if, /always\(\)/);
  assert.notEqual(receiver.concurrency.group, publisher.concurrency.group);
  assert.notEqual(control.concurrency.group, publisher.concurrency.group);
  assert.equal(publisher.concurrency["cancel-in-progress"], false);
});

test("only the trusted coordinator uploads the one literal contract artifact, then sends a hub-only signal", () => {
  const steps = control.jobs.reconcile.steps;
  const uploadIndex = steps.findIndex((s: any) => s.with?.name === "release-receipt-offline");
  const upload = steps[uploadIndex];
  assert.ok(uploadIndex > 0);
  assert.equal(upload.with.path, ".release-ci/release-receipt.json");
  assert.equal(upload.with.overwrite, true);
  assert.equal(upload.with["if-no-files-found"], "error");
  const hub = steps.find((s: any) => s.id === "hub");
  assert.equal(hub.with.repositories, "pineforge-release");
  assert.equal(hub.with["permission-contents"], "write");
  const signalIndex = steps.findIndex((s: any) => s.run === "node scripts/release-receipt.mjs signal");
  assert.ok(signalIndex > uploadIndex);
  assert.match(steps[signalIndex].if, /steps\.receipt\.outcome == 'success'/);
  for (const w of [receiver, publisher]) {
    assert.doesNotMatch(JSON.stringify(w), /consumer-receipt\.json|offline-receipt-|release-receipt-offline/);
  }
  assert.ok(control.on.workflow_run.workflows.includes("Publish to npm"));
  assert.ok(control.on.workflow_run.workflows.includes("pineforge-release"));
  assert.match(consumer, /final reporting run must be at the landed source/);
  assert.match(consumer, /"workflow", "run", "publish\.yml".*"--ref", tag/);
  assert.match(consumer, /"workflow", "run", "release-pr\.yml".*"--ref", tag/);
  const finalDispatch = consumer.slice(consumer.indexOf("function ensureFinalReport"), consumer.indexOf("async function reportPublication"));
  assert.ok(finalDispatch.indexOf("trustedPublisher(publisher)") < finalDispatch.indexOf('gh("workflow", "run"'), "validate the workflow definition's source before dispatch");
});
