import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-ignore workflow module.
import { checkEvidence, RECEIPT_POLICY } from "../scripts/release-receipt.mjs";

const ci = parse(readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8"));
const requiredNames = ["test", "runtime (amd64)", "runtime (arm64)", "release/ready"];
type Result = "success" | "skipped";
type State = { result: Result; outputs: Record<string, string> };
type Needs = Record<string, State>;
type ReportedJob = { name: string; status: string; conclusion: Result; completed_at: string };
type Context = { event_name: string; head_ref: string; actor: string; triggering_actor: string };

const bot: Context = {
  event_name: "pull_request",
  head_ref: "bot/pineforge-release/main/stable/1.2.3-abc",
  actor: "pineforge-release[bot]",
  triggering_actor: "pineforge-release[bot]",
};
const human: Context = {
  event_name: "pull_request", head_ref: "feature/docs",
  actor: "docs-author", triggering_actor: "docs-reviewer",
};

const supportedExpressions = new Set([
  "success()", "always()", "needs.changes.outputs.docs_only != 'true'",
  "${{ steps.docs.outputs.docs_only }}",
]);

// As in release-workflows.test.ts, execute the actual parsed YAML expression.
// Support only this fixed graph and the Actions status functions it uses.
function evaluate(expression: string, needs: Needs, steps = {}) {
  assert.ok(supportedExpressions.has(expression), `unsupported workflow expression: ${expression}`);
  const body = expression.startsWith("${{ ") ? expression.slice(4, -3) : expression;
  return new Function("needs", "steps", "success", "always", `return (${body});`)(
    needs, steps, () => Object.values(needs).every((job) => job.result === "success"), () => true,
  );
}

function docsMerge(root: string) {
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", args, {
      cwd, input, encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
        GIT_AUTHOR_NAME: "Docs replay", GIT_AUTHOR_EMAIL: "docs-replay@example.invalid",
        GIT_COMMITTER_NAME: "Docs replay", GIT_COMMITTER_EMAIL: "docs-replay@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  };
  // Only temporary bare-repository plumbing; never stages or commits this tree.
  git(["init", "--bare", "--quiet"]);
  const tree = (content: string) => {
    const blob = git(["hash-object", "-w", "--stdin"], content);
    const docs = git(["mktree"], `100644 blob ${blob}\tx.md\n`);
    return git(["mktree"], `040000 tree ${docs}\tdocs\n`);
  };
  const base = git(["commit-tree", tree("before\n"), "-m", "base"]);
  const changed = tree("after\n");
  const topic = git(["commit-tree", changed, "-p", base, "-m", "topic"]);
  const sha = git(["commit-tree", changed, "-p", base, "-p", topic, "-m", "merge"]);
  git(["update-ref", "HEAD", sha]);
  assert.equal(git(["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"]), "docs/x.md");
  return { cwd, sha };
}

function replay(t: TestContext, github: Context) {
  const root = mkdtempSync(join(tmpdir(), "pf-docs-bot-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cwd, sha } = docsMerge(root);
  const output = join(root, "github-output");
  const states: Needs = {};
  const jobs: ReportedJob[] = [];
  const visiting = new Set<string>();

  function visit(id: string): State {
    if (states[id]) return states[id];
    assert.ok(!visiting.has(id), `cyclic workflow needs: ${id}`);
    visiting.add(id);
    const job = ci.jobs[id];
    assert.ok(job, `unknown workflow job: ${id}`);
    const dependencies: string[] = typeof job.needs === "string" ? [job.needs] : job.needs ?? [];
    const needs: Needs = Object.fromEntries(dependencies.map((name) => [name, visit(name)]));
    const condition = job.if ?? "success()";
    // Actions implicitly adds success() to conditions without a status function.
    const run = Boolean(evaluate(condition, needs))
      && (condition === "always()" || Boolean(evaluate("success()", needs)));
    const state: State = { result: run ? "success" : "skipped", outputs: {} };
    if (id === "changes" && run) {
      const step = job.steps.find((step: any) => step.id === "docs");
      assert.ok(step);
      assert.equal(step.if, undefined);
      const command = /^node (scripts\/docs-only\.mjs)$/.exec(step.run);
      assert.ok(command, "replay must invoke the classifier command from the real YAML");
      const script = fileURLToPath(new URL(`../${command[1]}`, import.meta.url));
      const result = spawnSync(process.execPath, [script], {
        cwd, encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: github.event_name, GITHUB_HEAD_REF: github.head_ref,
          GITHUB_ACTOR: github.actor, GITHUB_TRIGGERING_ACTOR: github.triggering_actor,
          GITHUB_SHA: sha, GITHUB_OUTPUT: output,
        },
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const match = /^docs_only=(true|false)\n$/.exec(readFileSync(output, "utf8"));
      assert.ok(match);
      assert.equal(result.stdout, `${match[1]}\n`);
      state.outputs.docs_only = evaluate(job.outputs.docs_only, needs, {
        docs: { outputs: { docs_only: match[1] } },
      });
    }
    const names: string[] = job.strategy
      ? job.strategy.matrix.include.map(({ arch }: { arch: string }) => {
        assert.equal(job.name, "runtime (${{ matrix.arch }})");
        return job.name.replace("${{ matrix.arch }}", arch);
      })
      : [job.name ?? id];
    for (const name of names) jobs.push({
      name, status: "completed", conclusion: state.result, completed_at: "2026-10-19T00:00:00Z",
    });
    states[id] = state;
    visiting.delete(id);
    return state;
  }

  assert.deepEqual(Object.keys(ci.jobs).sort(), ["changes", "ready", "runtime", "test"]);
  assert.deepEqual(ci.jobs.ready.needs, ["changes", "test", "runtime"]);
  for (const id of Object.keys(ci.jobs)) visit(id);
  const run = {
    id: 101, run_attempt: 1, path: ".github/workflows/test.yml", head_sha: sha,
    event: github.event_name, status: "completed", conclusion: "success",
  };
  return { docsOnly: states.changes.outputs.docs_only, jobs, run, sha };
}

test("docs-only bot replay runs every required job and passes real receipt evidence", (t) => {
  const { docsOnly, jobs, run, sha } = replay(t, bot);
  assert.equal(docsOnly, "false");
  assert.deepEqual(jobs.map((job) => job.name).sort(), [...requiredNames, "changes"].sort());
  assert.ok(jobs.every((job) => job.conclusion === "success"));
  assert.ok(!jobs.some((job) => job.conclusion === "skipped"));
  for (const policy of [RECEIPT_POLICY.ci, RECEIPT_POLICY.e2e]) {
    assert.deepEqual(policy.expected, requiredNames);
    assert.deepEqual(policy.approved_skips, []);
    const evidence = checkEvidence(run, jobs, policy, sha);
    assert.deepEqual(evidence.results, Object.fromEntries(requiredNames.map((name) => [name, "success"])));
  }

  // The reusable publisher adds "gates / changes" alongside its expected jobs.
  const deployJobs = RECEIPT_POLICY.deploy.expected.map((name: string) => ({
    name, status: "completed", conclusion: "success", completed_at: "2026-10-19T00:00:00Z",
  }));
  deployJobs.push({ ...jobs.find((job) => job.name === "changes")!, name: "gates / changes" });
  const deploy = checkEvidence(
    { ...run, path: ".github/workflows/publish.yml" }, deployJobs, RECEIPT_POLICY.deploy, sha,
  );
  assert.deepEqual(Object.keys(deploy.results), RECEIPT_POLICY.deploy.expected);
  assert.ok(!Object.hasOwn(deploy.results, "gates / changes"));
});

test("docs-only human replay skips test/runtime and real receipt evidence rejects it", (t) => {
  const { docsOnly, jobs, run, sha } = replay(t, human);
  assert.equal(docsOnly, "true");
  assert.deepEqual(Object.fromEntries(jobs.map((job) => [job.name, job.conclusion])), {
    changes: "success", test: "skipped",
    "runtime (amd64)": "skipped", "runtime (arm64)": "skipped", "release/ready": "success",
  });
  for (const policy of [RECEIPT_POLICY.ci, RECEIPT_POLICY.e2e]) {
    assert.deepEqual(policy.approved_skips, []);
    assert.throws(() => checkEvidence(run, jobs, policy, sha), /unsuccessful required job: test/);
  }
});
