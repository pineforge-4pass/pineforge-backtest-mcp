import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// @ts-ignore CI wire fixtures, independent of the code under test.
import { rereleaseState, openRerelease, repo, bot, source, candidate, newMerge, annotation, npmURL, openRoute, runsRoute, publisher, gitResult } from "./fixtures/release/rerelease-inputs.mjs";

type Change = (state: any, root: string) => void;
function invoke(name = "receive", change: Change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "pf-rerelease-test-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const state = rereleaseState(root);
  change(state, root);
  const file = join(root, "mock.json");
  writeFileSync(file, JSON.stringify(state));
  const cli = readFileSync(new URL("./fixtures/release/mock-cli.mjs", import.meta.url));
  for (const tool of ["gh", "git"]) writeFileSync(join(bin, tool), cli, { mode: 0o755 });
  const env = { ...process.env };
  delete env.PUBLISHER_RUN_ID;
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./fixtures/release/invoke-chain.mjs", import.meta.url)), name,
  ], {
    cwd: root, encoding: "utf8", env: {
      ...env, PATH: `${bin}${delimiter}${env.PATH}`, PF_MOCK_STATE: file,
      GITHUB_REPOSITORY: repo, RELEASE_BOT_LOGIN: bot, RELEASE_CHAIN_OWNER: "release-owner",
      GITHUB_EVENT_PATH: join(root, "event.json"), GITHUB_EVENT_NAME: name === "advance" ? "workflow_run" : "repository_dispatch",
      GITHUB_RUN_ID: "400", GITHUB_RUN_ATTEMPT: "1",
      NODE_OPTIONS: `--import=${new URL("./fixtures/release/mock-registry.mjs", import.meta.url).href}`,
    },
  });
  assert.ok(result.stdout.trim(), result.stderr);
  return { root, result, output: JSON.parse(result.stdout), state: JSON.parse(readFileSync(file, "utf8")) };
}
const pushes = (s: any) => s.calls.filter((c: any) => c.tool === "git" && c.args[0] === "push");
const opened = (s: any) => s.calls.filter((c: any) => c.tool === "gh" &&
  c.args.slice(0, 4).join(" ") === `api --method POST repos/${repo}/pulls`);
function positive() {
  const actual = invoke();
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  assert.equal(opened(actual.state).length, 1, "failed current publication must open a fresh PR");
  return actual;
}
function refused(change: Change, error?: RegExp) {
  const actual = invoke("receive", change);
  assert.equal(opened(actual.state).length, 0, actual.output.error);
  assert.equal(pushes(actual.state).length, 0);
  assert.equal(actual.state.calls.filter((c: any) => c.tool === "git" && c.args[0] === "commit").length, 0);
  if (error) {
    assert.equal(actual.result.status, 1);
    assert.match(actual.output.error, error);
  } else assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  return actual;
}

test("MCP-136: failed current publication opens 0.9.42 with identical bytes and App identity", () => {
  const { root, state } = positive();
  assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "0.9.42\n");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.9.42");
  assert.equal(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages[""].version, "0.9.42");
  assert.equal(JSON.parse(readFileSync(join(root, "server.json"), "utf8")).version, "0.9.42");
  assert.deepEqual(readFileSync(join(root, "release-lock.json")), Buffer.from(state.lockBytes));
  assert.deepEqual(readFileSync(join(root, "release-manifest.json")), Buffer.from(state.manifest));
  const pr = opened(state)[0].input;
  assert.match(pr.head, /^bot\/pineforge-release\/main\/stable\/1\.6\.3-[0-9a-f]{12}-r0\.9\.42$/);
  assert.equal(pr.head, state.branch);
  assert.equal(pr.base, "main");
  assert.equal(pr.title, "chore(release): PineForge 1.6.3");
  assert.equal(pr.body, "Consume PineForge 1.6.3 with immutable image, package and facts identities.\n\n" +
    "The required release/ready check tests the packed npm entry point and both image architectures before merge.\n\n" +
    `<!-- pineforge-release ${JSON.stringify({
      event_id: state.lock.event_id, release_version: "1.6.3", base: "main", delivery_run: 400, bot,
    })} -->\n`);
  const git = state.calls.filter((c: any) => c.tool === "git").map((c: any) => c.args);
  assert.ok(git.some((args: string[]) => JSON.stringify(args) === JSON.stringify(["config", "user.name", bot])));
  assert.ok(git.some((args: string[]) => JSON.stringify(args) === JSON.stringify(["config", "user.email", `1234+${bot}@users.noreply.github.com`])));
  const identityIndex = state.calls.findIndex((c: any) => c.args[0] === "config" && c.args[1] === "user.name");
  const pushIndex = state.calls.findIndex((c: any) => c.tool === "git" && c.args[0] === "push");
  assert.ok(identityIndex >= 0 && identityIndex < pushIndex && pushIndex < state.calls.indexOf(opened(state)[0]));
  assert.deepEqual(pushes(state).map((c: any) => c.args), [["push", "origin", `HEAD:refs/heads/${state.branch}`]]);
  assert.ok(git.some((args: string[]) => JSON.stringify(args) === JSON.stringify(["ls-remote", "--heads", "origin", `refs/heads/${state.branch}`])));
  assert.deepEqual(git.find((args: string[]) => args[0] === "commit"),
    ["commit", "-m", "chore(release): 0.9.42 on PineForge 1.6.3"]);
  assert.deepEqual(git.find((args: string[]) => args[0] === "add"),
    ["add", "VERSION", "package.json", "package-lock.json", "server.json", "release-lock.json", "release-manifest.json"]);
  assert.ok(state.network.includes(npmURL), "must observe the registry at delivery");
  assert.ok(state.calls.some((c: any) => c.args.at(-1) === runsRoute), "must observe GitHub publisher state");
});

for (const [label, patch] of [
  ["succeeded", { status: "completed", conclusion: "success" }],
  ["in progress", { status: "in_progress", conclusion: null }],
  ["cancelled", { status: "completed", conclusion: "cancelled" }],
  ["skipped", { status: "completed", conclusion: "skipped" }],
] as Array<[string, any]>) {
  test(`MCP-136: publisher ${label} opens no PR and pushes nothing`, () => {
    refused((s) => { s.api[runsRoute] = [{ workflow_runs: [{ ...publisher(), ...patch }] }]; });
  });
}
test("MCP-136: absent publisher opens no PR and preserves same-tag dispatch", () => {
  refused((s) => { s.api[runsRoute] = [{ workflow_runs: [] }]; });
});
test("MCP-136: newest matching publisher wins over an older failure", () => {
  refused((s) => { s.api[runsRoute] = [{ workflow_runs: [publisher(), { ...publisher(), id: 202, conclusion: "success" }] }]; });
});
test("MCP-136: newer unrelated publisher cannot authorize re-release", () => {
  refused((s) => { s.api[runsRoute] = [{ workflow_runs: [
    { ...publisher(), conclusion: "success" },
    { ...publisher(), id: 202, head_sha: candidate },
    { ...publisher(), id: 203, head_branch: "v0.9.40" },
    { ...publisher(), id: 204, event: "pull_request" },
    { ...publisher(), id: 205, display_title: "another publisher" },
  ] }]; });
});
for (const [label, response] of [
  ["already on npm", { status: 200, json: { name: "@pineforge/backtest-mcp", version: "0.9.41" } }],
  ["registry HTTP 500", { status: 500, body: "registry unavailable" }],
  ["registry HTTP 403", { status: 403, body: "forbidden" }],
] as Array<[string, any]>) {
  test(`MCP-136: ${label} opens no PR and pushes nothing`, () => {
    const actual = refused((s) => { s.responses[npmURL] = response; });
    assert.ok(actual.state.network.includes(npmURL));
  });
}
test("MCP-136: registry network failure refuses without PR or push", () => {
  refused((s) => { s.responses[npmURL] = { error: "fixture registry network failure" }; }, /fixture registry network failure/);
});
test("MCP-136: different event for the same release is refused", () => {
  refused((s) => {
    const different = { ...s.lock, event_id: `sha256:${"0".repeat(64)}`, manifest: { ...s.lock.manifest, sha256: "0".repeat(64) } };
    gitResult(s, ["show", "origin/main:release-lock.json"], JSON.stringify(different));
  }, /same release has a different immutable manifest/);
});
test("MCP-136: open bot PR for the event opens no second PR and pushes nothing", () => {
  refused((s) => { s.api[openRoute] = [[s.openPR]]; });
});
test("MCP-136: tag pointing at another commit is refused", () => {
  refused((s) => {
    s.api[`repos/${repo}/git/tags/${annotation}`].object.sha = candidate;
    s.api[`repos/${repo}/commits/${candidate}/pulls`] = [s.oldPR];
    gitResult(s, ["merge-base", "--is-ancestor", candidate, "origin/main"]);
  }, /only one merged update PR may bind this VERSION/);
});
test("MCP-136: lightweight tag is refused", () => {
  refused((s) => { s.api[`repos/${repo}/git/ref/tags/v0.9.41`].object.type = "commit"; }, /re-release requires an annotated tag/);
});
test("MCP-136: missing current tag refuses without PR or push", () => {
  refused((s) => { delete s.api[`repos/${repo}/git/ref/tags/v0.9.41`]; }, /Command failed/);
});
test("MCP-136: tag source without a merged bot PR is refused", () => {
  refused((s) => { s.api[`repos/${repo}/commits/${source}/pulls`] = []; }, /only one merged update PR may bind this VERSION/);
});
test("MCP-136: tag source PR for another event is refused", () => {
  refused((s) => {
    s.api[`repos/${repo}/commits/${source}/pulls`][0].body = s.oldPR.body.replace(s.lock.event_id, `sha256:${"0".repeat(64)}`);
  }, /only one merged update PR may bind this VERSION/);
});
test("MCP-136: tag source lock for another event is refused", () => {
  refused((s) => { gitResult(s, ["show", `${source}:release-lock.json`], JSON.stringify({ ...s.lock, event_id: `sha256:${"0".repeat(64)}` })); },
    /only one merged update PR may bind this VERSION/);
});
test("MCP-136: tag source VERSION differs from main and is refused", () => {
  refused((s) => { gitResult(s, ["show", `${source}:VERSION`], "0.9.40\n"); }, /only one merged update PR may bind this VERSION/);
});
test("MCP-136: GitHub parsing failure refuses without PR or push", () => {
  refused((s) => { s.api_raw = { [runsRoute]: "{broken json" }; }, /JSON/);
});
test("MCP-136: GitHub API failure refuses without PR or push", () => {
  refused((s) => { delete s.api[runsRoute]; }, /Command failed/);
});
test("MCP-136: malformed publisher ID refuses without PR or push", () => {
  refused((s) => { s.api[runsRoute][0].workflow_runs[0].id = "201"; }, /invalid publisher run ID/);
});
for (const path of ["release-lock.json", "release-manifest.json"]) {
  test(`MCP-136: changed ${path} bytes refuse before commit or push`, () => {
    refused((s) => {
      gitResult(s, ["show", `origin/main:${path}`], path === "release-lock.json"
        ? JSON.stringify(s.lock) + "\n" : s.manifest + "\n");
    }, /must remain byte-identical to main/);
  });
}
test("MCP-136: existing re-release branch refuses without commit or push", () => {
  refused((s) => { gitResult(s, ["ls-remote", "--heads", "origin", `refs/heads/${s.branch}`], `${candidate}\trefs/heads/${s.branch}\n`); },
    /existing branch without open PR requires repair/);
});
test("MCP-136: unexpected staged file refuses without commit or push", () => {
  refused((s) => { gitResult(s, ["diff", "--cached", "--name-only"], "VERSION\nsrc/index.ts\n"); }, /unexpected staged release file/);
});

for (const order of ["old PR updated newest", "new PR updated newest"]) {
  test(`MCP-136: landed selection binds 0.9.42 when ${order}`, () => {
    // Exercise both transport orders for each updated_at ordering. A first
    // event match cannot pass either named row just by sorting its fixture.
    for (const oldFirst of [true, false]) {
      const actual = invoke("landedPR", (s) => {
        s.merged_prs = oldFirst ? [s.oldPR, s.newPR] : [s.newPR, s.oldPR];
        if (order === "new PR updated newest") s.newPR.updated_at = "2026-10-24T00:00:00Z";
      });
      assert.equal(actual.result.status, 0, actual.output.error);
      assert.equal(actual.output.value.number, 42);
      assert.equal(actual.output.value.merge_commit_sha, newMerge);
    }
  });
}
test("MCP-136: advance handles the open re-release instead of failing the old tag", () => {
  const actual = invoke("advance", openRerelease);
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  assert.ok(!actual.state.calls.some((c: any) => String(c.args.at(-1)).includes("pulls?state=closed")),
    "open re-release must reach the candidate path before tagLanded");
  assert.ok(actual.state.calls.some((c: any) => c.args.at(-1) === `repos/${repo}/compare/main...${candidate}`));
  const receipt = JSON.parse(readFileSync(join(actual.root, ".release-ci/release-receipt.json"), "utf8"));
  assert.equal(receipt.event_id, actual.state.lock.event_id);
  assert.equal(receipt.state, "pending");
  assert.equal(receipt.attempt, 400);
  assert.equal(receipt.sequence, 1);
  assert.equal(pushes(actual.state).length, 0);
});
test("MCP-136: failed redelivery still advances an existing re-release candidate", () => {
  const actual = invoke("advance", (s, root) => {
    openRerelease(s, root);
    s.api[`repos/${repo}/actions/runs/300`].conclusion = "failure";
  });
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  const receipt = JSON.parse(readFileSync(join(actual.root, ".release-ci/release-receipt.json"), "utf8"));
  assert.equal(receipt.state, "pending");
  assert.ok(actual.state.calls.some((c: any) => c.args.at(-1) === `repos/${repo}/compare/main...${candidate}`));
});
test("MCP-136: delayed old publisher failure cannot fail an open re-release", () => {
  const actual = invoke("advance", (s, root) => {
    openRerelease(s, root);
    writeFileSync(join(root, "event.json"), JSON.stringify({ workflow_run: publisher() }));
    s.api[`repos/${repo}/actions/runs/201`] = publisher();
    s.api[`repos/${repo}/actions/workflows/release-pr.yml/runs?event=workflow_dispatch&head_sha=${source}&per_page=100`] = [{ workflow_runs: [] }];
    gitResult(s, ["fetch", "origin", source]);
  });
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  assert.ok(!existsSync(join(actual.root, ".release-ci/release-receipt.json")));
  assert.equal(pushes(actual.state).length, 0);
});
test("MCP-136: superseded lookup preserves the second merged PR's expired report", () => {
  const actual = invoke("advance", (s, root) => {
    openRerelease(s, root);
    s.api[openRoute] = [[]];
    const newer = JSON.parse(JSON.stringify(s.lock));
    newer.release_version = "1.6.4";
    newer.event_id = `sha256:${"0".repeat(64)}`;
    newer.manifest.sha256 = "0".repeat(64);
    newer.facts.release_key = "1.6.4";
    Object.assign(newer.versions.engine, { version: "1.6.4", tag: "v1.6.4" });
    Object.assign(newer.versions.codegen, { version: "1.6.4", pypi_version: "1.6.4", npm_version: "1.6.4" });
    Object.assign(newer.versions.hpo, { version: "1.6.4", package_version: "1.6.4", tag: "v1.6.4" });
    gitResult(s, ["show", "origin/main:release-lock.json"], JSON.stringify(newer));
    s.api[`repos/${repo}/pulls?state=closed&base=main&per_page=100`] = [[s.oldPR, s.newPR]];
    s.api[`repos/${repo}/actions/workflows/release-pr.yml/runs?event=workflow_dispatch&head_sha=${source}&per_page=100`] = [{ workflow_runs: [] }];
    s.api[`repos/${repo}/actions/workflows/release-pr.yml/runs?event=workflow_dispatch&head_sha=${newMerge}&per_page=100`] = [{ workflow_runs: [{
      id: 350, head_sha: newMerge, display_title: "Offline receipt for publisher 250",
      run_attempt: 1, conclusion: "success",
    }] }];
    s.api[`repos/${repo}/actions/runs/350/artifacts?per_page=100`] = [{ artifacts: [
      { name: "release-receipt-offline", expired: true },
    ] }];
  });
  assert.equal(actual.result.status, 0, actual.output.error ?? actual.result.stderr);
  assert.ok(!existsSync(join(actual.root, ".release-ci/release-receipt.json")));
  assert.ok(actual.state.calls.some((c: any) => String(c.args.at(-1)).includes(`head_sha=${newMerge}`)));
});
for (const path of ["release-lock.json", "release-manifest.json"]) {
  test(`MCP-136: advance refuses re-release with changed ${path} bytes`, () => {
    const actual = invoke("advance", (s, root) => {
      openRerelease(s, root);
      gitResult(s, ["show", `${candidate}:${path}`], path === "release-lock.json"
        ? JSON.stringify(s.lock) + "\n" : s.manifest + "\n");
    });
    assert.equal(actual.result.status, 1);
    assert.match(actual.output.error, /must remain byte-identical to main/);
    assert.equal(pushes(actual.state).length, 0);
    assert.ok(!existsSync(join(actual.root, ".release-ci/release-receipt.json")));
  });
}

test("MCP-136: malformed publisher state cannot contaminate another invocation", () => {
  const malformed = refused((s) => {
    s.api[runsRoute][0].workflow_runs[0].id = "201";
  }, /invalid publisher run ID/);
  const fresh = positive();
  assert.notEqual(fresh.root, malformed.root, "invocations must own separate mock state files");
  assert.equal(fresh.state.api[runsRoute][0].workflow_runs[0].id, 201);
  const preserved = JSON.parse(readFileSync(join(malformed.root, "mock.json"), "utf8"));
  assert.equal(preserved.api[runsRoute][0].workflow_runs[0].id, "201");
});
