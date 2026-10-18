import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

// L6 10-18: jobs that hold production credentials, run in a protected environment or have id-token: write stay on
// GitHub-hosted runners; only PR, test and check jobs use the pf-ci-spot pool.
const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = (): Record<string, any> => Object.fromEntries(readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, parse(readFileSync(new URL(name, dir), "utf8"))]));

function credentialedJobsHosted(docs: Record<string, any>) {
  for (const [file, doc] of Object.entries(docs)) {
    const workflowWrites = doc.permissions?.["id-token"] === "write";
    for (const [name, job] of Object.entries(doc.jobs ?? {}) as [string, any][]) {
      if (job.uses) continue; // A reusable-workflow caller has no runner of its own.
      const serialized = JSON.stringify(job);
      const credentialed = /secrets\.(?!GITHUB_TOKEN\b)/.test(serialized) || job.environment !== undefined ||
        job.permissions?.["id-token"] === "write" || (workflowWrites && job.permissions === undefined);
      if (!credentialed) continue;
      assert.ok(typeof job["runs-on"] === "string" && /^ubuntu-[0-9a-z.]+$/.test(job["runs-on"]),
        `credentialed job ${file}:${name} must run on a GitHub-hosted runner`);
    }
  }
}

test("credentialed release jobs stay on GitHub-hosted runners (including the pool red case)", () => {
  const docs = workflows();
  credentialedJobsHosted(docs);
  const pooled = structuredClone(docs);
  pooled["publish.yml"].jobs["mcp-registry"]["runs-on"] =
    "${{ github.event_name != 'pull_request_target' && fromJSON('[\"self-hosted\",\"pf-ci\",\"pf-ci-x64\"]') || 'ubuntu-latest' }}";
  assert.throws(() => credentialedJobsHosted(pooled), /must run on a GitHub-hosted runner/);
});
