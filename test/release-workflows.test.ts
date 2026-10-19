import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = (name: string) => parse(read(`.github/workflows/${name}.yml`));
const receiver = workflow("pineforge-release");
const publisher = workflow("publish");
const ci = workflow("test");
const regeneration = workflow("regenerate-syminfo-trades");
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
  assert.deepEqual(ci.jobs.ready.needs, ["changes", "test", "runtime"]);
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

test("automatic reconcile runs only once the chain is configured, and a setup failure can still alert", () => {
  assert.equal(control.jobs.reconcile.if, "vars.RELEASE_CHAIN_OWNER != '' || github.event_name == 'workflow_dispatch'");
  const steps = control.jobs.reconcile.steps;
  const alert = steps.findIndex((s: any) => /release-consumer\.mjs alert/.test(s.run ?? ""));
  const rescue = steps.findIndex((s: any) => s.if === "failure() && steps.checkout.outcome != 'success'");
  assert.ok(rescue >= 0 && rescue < alert, "a checkout for the alert must precede it when setup failed");
  assert.equal(steps[rescue].with["persist-credentials"], false);
  assert.ok(steps.some((s: any) => s.id === "checkout" && s.with?.token === "${{ steps.app.outputs.token }}"));
});

const ordinaryPR = "github.event_name == 'pull_request' && !startsWith(github.head_ref, 'bot/pineforge-release/')";
const cancelExpression = "${{ " + ordinaryPR + " }}";
const groupExpression = (prefix: string) => "${{ " + ordinaryPR
  + ` && format('${prefix}-pr-{0}', github.event.pull_request.number)`
  + ` || format('${prefix}-run-{0}-{1}', github.run_id, github.run_attempt) }}`;
const fullGraph = "needs.changes.outputs.docs_only != 'true'";
const docsSkip = "needs.changes.outputs.docs_only == 'true'";
const gateNeeds = '${{ format(\'{{"test":{0},"runtime":{1}}}\', toJSON(needs.test), toJSON(needs.runtime)) }}';
const supportedExpressions = new Set([
  cancelExpression, groupExpression("test"), groupExpression("regen"),
  fullGraph, docsSkip, gateNeeds,
  "${{ needs.changes.result }}", "${{ needs.test.result }}", "${{ needs.runtime.result }}",
]);

// Only the fixed workflow expressions above are supported. Their operators are
// shared with JS. Execute the parsed YAML expression itself, with the three
// Actions functions it uses; this is deliberately not a general Actions parser.
function evaluate(expression: string, { github = {}, needs = {} }: { github?: any; needs?: any } = {}) {
  assert.ok(supportedExpressions.has(expression), `unsupported workflow expression: ${expression}`);
  const body = expression.startsWith("${{ ") ? expression.slice(4, -3) : expression;
  const format = (pattern: string, ...values: unknown[]) =>
    pattern.replace(/\{\{|\}\}|\{(\d+)\}/g, (token, index) =>
      token === "{{" ? "{" : token === "}}" ? "}" : String(values[Number(index)]));
  return new Function("github", "needs", "startsWith", "format", "toJSON", `return (${body});`)(
    github, needs, (value: string, prefix: string) => value.startsWith(prefix), format, JSON.stringify,
  );
}

for (const [prefix, w] of [["test", ci], ["regen", regeneration]] as const) {
  test(`${prefix} concurrency expressions match the ordinary-PR-only contract`, () => {
    assert.deepEqual(w.concurrency, { group: groupExpression(prefix), "cancel-in-progress": cancelExpression });
  });

  for (const fixture of [
    { name: "ordinary PR", eventName: "pull_request", headRef: "feature/code", cancel: true },
    {
      name: "bot release PR", eventName: "pull_request",
      headRef: "bot/pineforge-release/main/stable/1.2.3-abc", cancel: false,
    },
    { name: "workflow_call from push", eventName: "push", headRef: "", cancel: false },
    { name: "workflow_call from workflow_dispatch", eventName: "workflow_dispatch", headRef: "", cancel: false },
  ]) {
    test(`${prefix} concurrency evaluates safely for ${fixture.name}`, () => {
      const context = (run: number, attempt = 1, number = 81) => ({
        github: {
          event_name: fixture.eventName, head_ref: fixture.headRef, run_id: run, run_attempt: attempt,
          event: fixture.eventName === "pull_request" ? { pull_request: { number } } : {},
        },
      });
      const group = (run: number, attempt = 1, number = 81) =>
        evaluate(w.concurrency.group, context(run, attempt, number));
      const first = group(100);
      const second = group(101);
      assert.equal(evaluate(w.concurrency["cancel-in-progress"], context(100)), fixture.cancel);
      assert.equal(evaluate(w.concurrency["cancel-in-progress"], context(101)), fixture.cancel);
      if (fixture.cancel) {
        assert.equal(first, `${prefix}-pr-81`);
        assert.equal(first, second, "two pushes to one PR must replace stale work");
        assert.notEqual(first, group(100, 1, 82), "different PRs must be independent");
      } else {
        assert.equal(first, `${prefix}-run-100-1`);
        assert.notEqual(first, second, "independent runs must never queue or replace one another");
        assert.notEqual(first, group(100, 2), "reruns must use their own attempt group");
      }
      for (const actual of [first, second, group(100, 2)]) {
        for (const reserved of [
          "offline-release-publish", "offline-release-control",
          publisher.concurrency.group, receiver.concurrency.group, control.concurrency.group,
        ]) assert.notEqual(actual, reserved);
      }
    });
  }
}

test("test and regeneration concurrency namespaces cannot collide", () => {
  for (const event_name of ["pull_request", "push", "workflow_dispatch"]) {
    const github = {
      event_name, head_ref: "feature/code", run_id: 100, run_attempt: 1,
      event: { pull_request: { number: 81 } },
    };
    assert.notEqual(evaluate(ci.concurrency.group, { github }), evaluate(regeneration.concurrency.group, { github }));
  }
  assert.deepEqual(regeneration.on.pull_request.paths, [
    "test/fixtures/syminfo/**", "scripts/regenerate-syminfo-trades.mjs", ".github/workflows/regenerate-syminfo-trades.yml",
  ]);
});

test("changes uses a shallow merge checkout and contents-read-only classifier", () => {
  const changes = ci.jobs.changes;
  assert.equal(Object.keys(ci.jobs)[0], "changes");
  assert.equal(changes.name, "changes");
  assert.equal(changes["runs-on"], "ubuntu-latest");
  assert.deepEqual(changes.permissions, { contents: "read" });
  assert.equal(changes.if, undefined, "classification must also run for publisher calls");
  assert.equal(changes.needs, undefined);
  assert.deepEqual(changes.outputs, { docs_only: "${{ steps.docs.outputs.docs_only }}" });
  assert.deepEqual(changes.steps, [
    { uses: "actions/checkout@v4", with: { "fetch-depth": 2, "persist-credentials": false } },
    { id: "docs", run: "node scripts/docs-only.mjs" },
  ]);
});

function readySteps() {
  const steps = ci.jobs.ready.steps;
  const evidence = steps.find((s: any) => s.run === "node scripts/release-artifacts.mjs evidence");
  const gate = steps.find((s: any) => s.run === "node scripts/release-evidence.mjs gate");
  const upload = steps.find((s: any) => s.with?.name === "offline-gate-${{ github.run_id }}-${{ github.run_attempt }}");
  const docs = steps.find((s: any) => s.name === "Verify the documentation-only skip");
  assert.ok(evidence && gate && upload && docs, "all aggregate paths must exist");
  return { steps, evidence, gate, upload, docs };
}

test("docs-only conditions skip exactly the test/runtime graph and gate receipt", () => {
  assert.equal(ci.jobs.test.needs, "changes");
  assert.equal(ci.jobs.test.if, fullGraph);
  assert.equal(ci.jobs.test.name ?? "test", "test");
  assert.equal(ci.jobs.runtime.needs, "test");
  assert.equal(ci.jobs.runtime.if, undefined);
  assert.equal(ci.jobs.runtime.name, "runtime (${{ matrix.arch }})");
  assert.deepEqual(ci.jobs.ready.needs, ["changes", "test", "runtime"]);
  assert.equal(ci.jobs.ready.if, "always()");
  const { steps, evidence, gate, upload, docs } = readySteps();
  assert.equal(steps.length, 6);
  assert.equal(steps[0].uses, "actions/checkout@v4");
  assert.equal(steps[1].uses, "actions/setup-node@v4");
  assert.equal(steps[0].if, undefined);
  assert.equal(steps[1].if, undefined);
  assert.equal(docs.if, docsSkip);
  for (const step of [evidence, gate, upload]) assert.equal(step.if, fullGraph);
  for (const docs_only of ["true", "false", ""]) {
    const needs = { changes: { outputs: { docs_only } } };
    assert.equal(evaluate(ci.jobs.test.if, { needs }), docs_only !== "true");
    for (const step of [evidence, gate, upload]) assert.equal(evaluate(step.if, { needs }), docs_only !== "true");
    assert.equal(evaluate(docs.if, { needs }), docs_only === "true");
  }
});

test("gate NEEDS_JSON evaluates to exactly test and runtime, excluding changes", () => {
  const { gate } = readySteps();
  assert.equal(gate.env.NEEDS_JSON, gateNeeds);
  for (const testResult of ["success", "failure", "skipped", "cancelled"]) {
    const needs = {
      changes: { result: "success", outputs: { docs_only: "false" } },
      test: { result: testResult, outputs: { package: "packed" } },
      runtime: { result: "success", outputs: {} },
    };
    const actual = JSON.parse(evaluate(gate.env.NEEDS_JSON, { needs }));
    assert.deepEqual(Object.keys(actual).sort(), ["runtime", "test"]);
    assert.deepEqual(actual, { test: needs.test, runtime: needs.runtime });
  }
});

test("failed changes with empty docs_only runs the evidence gate and cannot use the docs skip", () => {
  const { evidence, gate, upload, docs } = readySteps();
  const needs = {
    changes: { result: "failure", outputs: { docs_only: "" } },
    test: { result: "skipped" }, runtime: { result: "skipped" },
  };
  assert.equal(ci.jobs.ready.if, "always()");
  for (const step of [evidence, gate, upload]) assert.equal(evaluate(step.if, { needs }), true);
  assert.equal(evaluate(docs.if, { needs }), false);
  const projected = JSON.parse(evaluate(gate.env.NEEDS_JSON, { needs }));
  assert.deepEqual(Object.values(projected).map((job: any) => job.result), ["skipped", "skipped"]);
});

test("docs-only ready step succeeds only for successful changes and two skipped jobs", () => {
  const { docs } = readySteps();
  assert.deepEqual(docs.env, {
    CHANGES_RESULT: "${{ needs.changes.result }}",
    TEST_RESULT: "${{ needs.test.result }}",
    RUNTIME_RESULT: "${{ needs.runtime.result }}",
  });
  const results = ["success", "failure", "cancelled", "skipped", ""];
  for (const changes of results) for (const test of results) for (const runtime of results) {
    const needs = { changes: { result: changes }, test: { result: test }, runtime: { result: runtime } };
    const env = Object.fromEntries(Object.entries(docs.env)
      .map(([key, expression]) => [key, evaluate(expression as string, { needs })]));
    const result = spawnSync("bash", ["-c", docs.run], { encoding: "utf8", env: { ...process.env, ...env } });
    const allowed = changes === "success" && test === "skipped" && runtime === "skipped";
    assert.equal(result.status, allowed ? 0 : 1, JSON.stringify(needs));
    if (allowed) assert.ok(result.stdout.includes("::notice::Documentation-only PR skipped the runtime graph"));
    else assert.ok(result.stdout.includes("::error::"), JSON.stringify(needs));
  }
});
