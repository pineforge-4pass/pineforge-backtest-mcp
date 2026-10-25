// Literal wire objects, independent of the release code. Only transport
// checksums are derived with node:crypto; no expected value calls the SUT.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const head = "1111111111111111111111111111111111111111";
export const otherHead = "2222222222222222222222222222222222222222";
export const todayGitHead = "b988217f2aa21b6b772fb723adbc89bd4130c3f5";
export const todayImageRevision = "f05d2565985710f72f56008dd12eaa013ca8a0eb";
export const repo = "pineforge-4pass/pineforge-backtest-mcp";
export const oci = "ghcr.io/pineforge-4pass/pineforge-backtest-mcp";
export const pr = { number: 38, merged: true, head: { sha: head } };
export const run = {
  id: 101, run_attempt: 1, path: ".github/workflows/test.yml", head_sha: head,
  status: "completed", conclusion: "success", event: "pull_request",
  created_at: "2026-10-20T01:00:00Z", pull_requests: [],
};
export const gate = {
  state: "ready", pr: 38, head_sha: head, source_sha: head,
  base_sha: "3333333333333333333333333333333333333333",
  expected_jobs: ["test", "runtime (amd64)", "runtime (arm64)"], approved_skips: [],
  run_id: 101, attempt: 1,
};
export const jobs = [
  { name: "test", status: "completed", conclusion: "success", completed_at: "2026-10-20T01:01:00Z" },
  { name: "runtime (amd64)", status: "completed", conclusion: "success", completed_at: "2026-10-20T01:02:00Z" },
  { name: "runtime (arm64)", status: "completed", conclusion: "success", completed_at: "2026-10-20T01:02:00Z" },
  { name: "release/ready", status: "completed", conclusion: "success", completed_at: "2026-10-20T01:03:00Z" },
];
export function gateState(runs = [run], gates = { 101: gate }, runJobs = jobs) {
  const api = {
    [`repos/${repo}/actions/workflows/test.yml/runs?event=pull_request&head_sha=${head}&per_page=100`]: { workflow_runs: runs },
  };
  const downloads = {};
  for (const r of runs) {
    api[`repos/${repo}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`] = [{ jobs: runJobs }];
    api[`repos/${repo}/actions/runs/${r.id}/artifacts?per_page=100`] = [{
      artifacts: [{ name: `offline-gate-${r.id}-${r.run_attempt}`, expired: false }],
    }];
    downloads[r.id] = gates[r.id];
  }
  return { calls: [], api, downloads };
}

const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const sri = (raw) => `sha512-${createHash("sha512").update(raw).digest("base64")}`;
export function packageState(root, {
  modern = false, revision, revisions = {}, gitHead = head, packedVersion = "0.9.40",
  badArch = false, missingArm = false, invalidLock = false, omitLabels = false, releaseImage,
  nullLabels = false, omitConfig = false,
} = {}) {
  const lock = JSON.parse(readFileSync(new URL("./release-ready-v1.json", import.meta.url), "utf8"));
  // The fixture's measured facts are real bytes, independent of the SUT.
  const facts = '{"releases":{"1.6.0":{"measured":true}}}\n';
  lock.facts.sha256 = hash(facts);
  const manifestFields = {
    release_version: lock.release_version, prerelease: lock.prerelease, hub_commit: lock.hub_commit,
    versions: lock.versions, image: lock.image, facts: lock.facts,
  };
  const manifest = JSON.stringify(manifestFields) + "\n";
  lock.manifest.sha256 = hash(manifest);
  lock.event_id = `sha256:${lock.manifest.sha256}`;
  const packRoot = join(root, "pack");
  mkdirSync(join(packRoot, "package"), { recursive: true });
  writeFileSync(join(packRoot, "package/package.json"), JSON.stringify({ name: "@pineforge/backtest-mcp", version: packedVersion }) + "\n");
  if (modern) writeFileSync(join(packRoot, "package/release-lock.json"), JSON.stringify(invalidLock ? {} : lock));
  const tarball = execFileSync("tar", ["-czf", "-", "-C", packRoot, "package"]);
  const responses = {};
  const put = (kind, obj) => {
    const raw = JSON.stringify(obj);
    const digest = `sha256:${hash(raw)}`;
    responses[`https://ghcr.io/v2/${repo}/${kind}/${digest}`] = { body: raw };
    return digest;
  };
  const child = (architecture) => {
    const labels = modern ? {
      "org.opencontainers.image.revision": gitHead,
      "io.pineforge.release.image": "ghcr.io/pineforge-4pass/pineforge-release@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    } : {};
    const archRevision = Object.hasOwn(revisions, architecture) ? revisions[architecture] : revision;
    if (archRevision !== undefined) labels["org.opencontainers.image.revision"] = archRevision;
    if (releaseImage !== undefined) labels["io.pineforge.release.image"] = releaseImage;
    const config = put("blobs", {
      architecture: badArch && architecture === "arm64" ? "amd64" : architecture,
      ...(omitConfig ? {} : { config: omitLabels ? {} : { Labels: nullLabels ? null : labels } }),
    });
    const digest = put("manifests", { schemaVersion: 2, config: { digest: config }, layers: [] });
    return { digest, platform: { os: "linux", architecture } };
  };
  const children = [child("amd64"), child("arm64")];
  const image_digest = put("manifests", { schemaVersion: 2, manifests: missingArm ? children.slice(0, 1) : children });
  const npm_integrity = sri(tarball);
  responses["https://registry.npmjs.org/@pineforge%2fbacktest-mcp/0.9.40"] = { json: {
    name: "@pineforge/backtest-mcp", version: "0.9.40", gitHead,
    dist: { tarball: "https://registry.npmjs.org/@pineforge/backtest-mcp/-/backtest-mcp-0.9.40.tgz", integrity: npm_integrity },
  } };
  responses["https://registry.npmjs.org/@pineforge/backtest-mcp/-/backtest-mcp-0.9.40.tgz"] = { base64: tarball.toString("base64") };
  responses[`https://ghcr.io/token?scope=repository:${repo}:pull`] = { json: { token: "fixture" } };
  responses[`https://raw.githubusercontent.com/pineforge-4pass/pineforge-release/${lock.facts.commit}/facts/facts.json`] = { body: facts };
  // Derive the oracle from literal options, independently of the served configs.
  // Mismatched inputs have no successful legacy identity to compare against.
  const expectedRevisions = ["amd64", "arm64"].map((architecture) =>
    omitConfig || omitLabels || nullLabels ? undefined
      : Object.hasOwn(revisions, architecture) ? revisions[architecture] : revision);
  const imageRevision = expectedRevisions[0] === expectedRevisions[1] ? expectedRevisions[0] ?? null : undefined;
  return {
    calls: [], responses, image_digest, manifest,
    api: { [`repos/${repo}/contents/release-lock.json?ref=${gitHead}`]: { content: Buffer.from(JSON.stringify(lock)).toString("base64") } },
    // Exact identity oracles use only the literal inputs above and standard
    // checksums, never servedIdentity/previousIdentity/canonical from the SUT.
    legacy: { legacy: true, npm_version: "0.9.40", npm_integrity, git_head: gitHead, image_digest,
      image_revision: imageRevision },
    full: {
      source: gitHead, image_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      facts_commit: "5555555555555555555555555555555555555555", facts_sha256: hash(facts),
      deployment_id_sha256: hash(JSON.stringify({ channel: "latest", image: image_digest, integrity: npm_integrity, version: "0.9.40" }) + "\n"),
    },
  };
}
