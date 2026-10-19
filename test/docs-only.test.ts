import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDocsOnly } from "../scripts/docs-only.mjs";

const script = fileURLToPath(new URL("../scripts/docs-only.mjs", import.meta.url));
const ordinary = {
  eventName: "pull_request", headRef: "feature/docs",
  actor: "docs-author", triggeringActor: "docs-reviewer",
};

for (const { name, files, expected } of [
  { name: "docs markdown only", files: ["docs/a.md", "docs/nested/b.md"], expected: true },
  { name: "docs plus README", files: ["docs/a.md", "README.md"], expected: false },
  { name: "README only", files: ["README.md"], expected: false },
  ...[
    "docs/a.md.sh", "docs/a.mdx", "docs/x.sql", "docs/img.png", "docs/.md",
    "LEGAL.md", "LICENSE", "glama.json", "server.json", "package.json", "package-lock.json",
    "assets/x.md", "src/coverage.ts", "test/a.md", "scripts/a.md", "docker/a.md",
    "parity/a.md", ".github/a.md",
  ].map((path) => ({ name: `reject ${path}`, files: [path], expected: false })),
  { name: "rename docs to source", files: ["docs/a.md", "src/a.md"], expected: false },
  { name: "rename source to docs", files: ["src/a.md", "docs/a.md"], expected: false },
  { name: "empty diff", files: [], expected: false },
]) {
  test(`docs-only classifier: ${name}`, () => {
    assert.equal(isDocsOnly({ ...ordinary, files }), expected);
  });
}

test("docs-only classifier excludes bot release branches", () => {
  assert.equal(isDocsOnly({
    ...ordinary, headRef: "bot/pineforge-release/main/stable/1.2.3-abc", files: ["docs/a.md"],
  }), false);
});

for (const { name, actor, triggeringActor, expected } of [
  {
    name: "bot actor with human triggering actor",
    actor: "pineforge-release[bot]", triggeringActor: "docs-reviewer", expected: false,
  },
  {
    name: "human actor with bot triggering actor",
    actor: "docs-author", triggeringActor: "pineforge-release[bot]", expected: false,
  },
  {
    name: "arbitrary app actor suffix",
    actor: "another-app[bot]", triggeringActor: "docs-reviewer", expected: false,
  },
  {
    name: "arbitrary app triggering actor suffix",
    actor: "docs-author", triggeringActor: "another-app[bot]", expected: false,
  },
  { name: "both actors unset", actor: undefined, triggeringActor: undefined, expected: false },
  { name: "both actors empty", actor: "", triggeringActor: "", expected: false },
  { name: "actor unset and triggering actor empty", actor: undefined, triggeringActor: "", expected: false },
  { name: "actor empty and triggering actor unset", actor: "", triggeringActor: undefined, expected: false },
  { name: "only human actor known", actor: "docs-author", triggeringActor: undefined, expected: true },
  { name: "only human triggering actor known", actor: undefined, triggeringActor: "docs-reviewer", expected: true },
  {
    name: "bot text without suffix is a human login",
    actor: "bot-docs-author", triggeringActor: "docs-bot-reviewer", expected: true,
  },
]) {
  test(`docs-only classifier: ${name}`, () => {
    assert.equal(isDocsOnly({ ...ordinary, actor, triggeringActor, files: ["docs/a.md"] }), expected);
  });
}

for (const eventName of ["push", "workflow_dispatch"]) {
  test(`docs-only classifier: workflow_call from ${eventName} cannot skip`, () => {
    // Reusable workflows inherit the caller's event rather than workflow_call.
    assert.equal(isDocsOnly({ ...ordinary, eventName, files: ["docs/a.md"] }), false);
  });
}

test("docs-only classifier excludes every non-PR event", () => {
  for (const eventName of ["push", "workflow_dispatch", "workflow_call", "", undefined]) {
    assert.equal(isDocsOnly({ ...ordinary, eventName, files: ["docs/a.md"] }), false, eventName);
  }
});

test("docs-only classifier fails closed on git failure", () => {
  assert.equal(isDocsOnly({ ...ordinary, files: ["docs/a.md"], gitFailed: true }), false);
});

// Build actual merge commits with plumbing; no staging, checkout, or working
// repository metadata is touched. Both rename endpoints are identical blobs.
function repository(root: string, before: Record<string, string>, after?: Record<string, string>) {
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", args, {
      cwd, input, encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
        GIT_AUTHOR_NAME: "Docs test", GIT_AUTHOR_EMAIL: "docs-test@example.invalid",
        GIT_COMMITTER_NAME: "Docs test", GIT_COMMITTER_EMAIL: "docs-test@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  };
  git(["init", "--bare", "--quiet"]);
  function tree(files: Record<string, string>): string {
    const entries: string[] = [];
    const dirs = new Map<string, Record<string, string>>();
    for (const [path, content] of Object.entries(files)) {
      const slash = path.indexOf("/");
      if (slash < 0) {
        entries.push(`100644 blob ${git(["hash-object", "-w", "--stdin"], content)}\t${path}`);
      } else {
        const dir = path.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, {});
        dirs.get(dir)![path.slice(slash + 1)] = content;
      }
    }
    for (const [name, files] of dirs) entries.push(`040000 tree ${tree(files)}\t${name}`);
    return git(["mktree"], entries.join("\n") + (entries.length ? "\n" : ""));
  }
  const base = git(["commit-tree", tree(before), "-m", "base"]);
  let head = base;
  if (after) {
    const nextTree = tree(after);
    const topic = git(["commit-tree", nextTree, "-p", base, "-m", "topic"]);
    head = git(["commit-tree", nextTree, "-p", base, "-p", topic, "-m", "merge"]);
  }
  git(["update-ref", "HEAD", head]);
  return cwd;
}

const cliCases: {
  name: string;
  before: Record<string, string>;
  after?: Record<string, string>;
  eventName?: string;
  headRef?: string;
  actor?: string | null;
  triggeringActor?: string | null;
  expected: boolean;
}[] = [
  {
    name: "docs markdown merge", before: { "docs/a.md": "before" },
    after: { "docs/a.md": "after", "docs/nested/b.md": "new" }, expected: true,
  },
  {
    name: "docs plus shipped README", before: {},
    after: { "docs/a.md": "new", "README.md": "shipped" }, expected: false,
  },
  { name: "README only", before: {}, after: { "README.md": "shipped" }, expected: false },
  { name: "non-markdown docs", before: {}, after: { "docs/img.png": "image" }, expected: false },
  {
    name: "rename docs to source", before: { "docs/a.md": "identical" },
    after: { "src/a.md": "identical" }, expected: false,
  },
  {
    name: "rename source to docs", before: { "src/a.md": "identical" },
    after: { "docs/a.md": "identical" }, expected: false,
  },
  { name: "empty merge diff", before: { "docs/a.md": "same" }, after: { "docs/a.md": "same" }, expected: false },
  {
    name: "bot release branch", before: {}, after: { "docs/a.md": "new" },
    headRef: "bot/pineforge-release/main/stable/1.2.3-abc", expected: false,
  },
  {
    name: "bot actor with human triggering actor", before: {}, after: { "docs/a.md": "new" },
    actor: "pineforge-release[bot]", expected: false,
  },
  {
    name: "human actor with bot triggering actor", before: {}, after: { "docs/a.md": "new" },
    triggeringActor: "pineforge-release[bot]", expected: false,
  },
  {
    name: "arbitrary app actor suffix", before: {}, after: { "docs/a.md": "new" },
    actor: "another-app[bot]", expected: false,
  },
  {
    name: "arbitrary app triggering actor suffix", before: {}, after: { "docs/a.md": "new" },
    triggeringActor: "another-app[bot]", expected: false,
  },
  {
    name: "both actors unset", before: {}, after: { "docs/a.md": "new" },
    actor: null, triggeringActor: null, expected: false,
  },
  {
    name: "both actors empty", before: {}, after: { "docs/a.md": "new" },
    actor: "", triggeringActor: "", expected: false,
  },
  {
    name: "actor unset and triggering actor empty", before: {}, after: { "docs/a.md": "new" },
    actor: null, triggeringActor: "", expected: false,
  },
  {
    name: "actor empty and triggering actor unset", before: {}, after: { "docs/a.md": "new" },
    actor: "", triggeringActor: null, expected: false,
  },
  {
    name: "only human actor known", before: {}, after: { "docs/a.md": "new" },
    triggeringActor: null, expected: true,
  },
  {
    name: "only human triggering actor known", before: {}, after: { "docs/a.md": "new" },
    actor: null, expected: true,
  },
  { name: "publisher push", before: {}, after: { "docs/a.md": "new" }, eventName: "push", expected: false },
  {
    name: "publisher dispatch", before: {}, after: { "docs/a.md": "new" },
    eventName: "workflow_dispatch", expected: false,
  },
  { name: "git failure without first parent", before: { "docs/a.md": "base" }, expected: false },
];

for (const fixture of cliCases) {
  test(`docs-only CLI: ${fixture.name}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "pf-docs-only-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cwd = repository(root, fixture.before, fixture.after);
    const output = join(root, "github-output");
    const result = spawnSync(process.execPath, [script], {
      cwd, encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: fixture.eventName ?? ordinary.eventName,
        GITHUB_HEAD_REF: fixture.headRef ?? ordinary.headRef,
        GITHUB_ACTOR: fixture.actor === null ? undefined : fixture.actor ?? ordinary.actor,
        GITHUB_TRIGGERING_ACTOR: fixture.triggeringActor === null ? undefined : fixture.triggeringActor ?? ordinary.triggeringActor,
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout, `${fixture.expected}\n`);
    assert.equal(readFileSync(output, "utf8"), `docs_only=${fixture.expected}\n`);
  });
}
