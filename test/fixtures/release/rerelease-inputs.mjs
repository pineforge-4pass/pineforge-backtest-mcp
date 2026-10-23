// Independent wire fixtures. Hashes below describe fixture transport bytes;
// publisher status, merge bindings and expected versions are literal inputs.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const repo = "pineforge-4pass/pineforge-backtest-mcp";
const hub = "pineforge-4pass/pineforge-release";
export const prefix = "bot/pineforge-release/main/stable/";
export const bot = "pineforge-release[bot]";
export const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const candidate = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const newMerge = "cccccccccccccccccccccccccccccccccccccccc";
export const main = "dddddddddddddddddddddddddddddddddddddddd";
export const annotation = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const npmURL = "https://registry.npmjs.org/@pineforge%2fbacktest-mcp/0.9.41";
export const openRoute = `repos/${repo}/pulls?state=open&base=main&per_page=100`;
export const runsRoute = `repos/${repo}/actions/workflows/publish.yml/runs?head_sha=${source}&per_page=100`;
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const publisher = {
  id: 201, run_attempt: 1, path: ".github/workflows/publish.yml",
  head_sha: source, head_branch: "v0.9.41", event: "push",
  display_title: "Offline publish v0.9.41", status: "completed", conclusion: "failure",
};
export const gitResult = (s, args, output = "") => { s.git[JSON.stringify(args)] = output; };
export function rereleaseState(root) {
  const lock = JSON.parse(readFileSync(new URL("./release-ready-v1.json", import.meta.url), "utf8"));
  lock.release_version = "1.6.3";
  lock.versions.engine.version = "1.6.3"; lock.versions.engine.tag = "v1.6.3";
  Object.assign(lock.versions.codegen, { version: "1.6.3", pypi_version: "1.6.3", npm_version: "1.6.3" });
  Object.assign(lock.versions.hpo, { version: "1.6.3", package_version: "1.6.3", tag: "v1.6.3" });
  lock.facts.release_key = "1.6.3";
  const facts = '{"releases":{"1.6.3":{"measured":true}}}\n';
  const sdist = "fixture-codegen-sdist\n", tar = "fixture-codegen-npm\n";
  const wheel = "fixture-hpo-wheel\n", hpoSdist = "fixture-hpo-sdist\n";
  lock.facts.sha256 = hash(facts);
  lock.versions.codegen.sdist_sha256 = hash(sdist);
  lock.versions.codegen.npm_integrity = sri(tar);
  lock.versions.hpo.wheel_sha256 = hash(wheel);
  lock.versions.hpo.sdist_sha256 = hash(hpoSdist);
  const responses = {
    [npmURL]: { status: 404, body: '{"error":"Not found"}' },
    [`https://raw.githubusercontent.com/${hub}/${lock.facts.commit}/facts/facts.json`]: { body: facts },
    "https://pypi.org/pypi/pineforge-codegen/1.6.3/json": { json: { urls: [{
      packagetype: "sdist", digests: { sha256: hash(sdist) }, url: "https://files.pythonhosted.org/fixture.tar.gz",
    }] } },
    "https://files.pythonhosted.org/fixture.tar.gz": { body: sdist },
    "https://registry.npmjs.org/@pineforge%2fcodegen-pyodide/1.6.3": { json: { dist: {
      integrity: sri(tar), tarball: "https://registry.npmjs.org/fixture.tgz",
    } } },
    "https://registry.npmjs.org/fixture.tgz": { body: tar },
    [`https://ghcr.io/token?scope=repository:${hub}:pull`]: { json: { token: "fixture" } },
  };
  const oci = (kind, value) => {
    const body = JSON.stringify(value), digest = `sha256:${hash(body)}`;
    responses[`https://ghcr.io/v2/${hub}/${kind}/${digest}`] = { body };
    return digest;
  };
  const children = ["amd64", "arm64"].map((architecture) => {
    const config = oci("blobs", { architecture, config: { Labels: {
      "org.opencontainers.image.source": `https://github.com/${hub}`,
      "org.opencontainers.image.revision": lock.hub_commit,
      "org.opencontainers.image.version": "1.6.3",
      "io.pineforge.engine.version": "1.6.3", "io.pineforge.codegen.version": "1.6.3", "io.pineforge.hpo.version": "1.6.3",
    } } });
    const digest = oci("manifests", { schemaVersion: 2, config: { digest: config }, layers: [] });
    lock.image[`${architecture}_digest`] = digest;
    return { digest, platform: { os: "linux", architecture } };
  });
  lock.image.digest = oci("manifests", { schemaVersion: 2, manifests: children });
  const { event_id: _event, manifest: _manifest, ...fields } = lock;
  const manifest = JSON.stringify(fields) + "\n";
  lock.manifest.sha256 = hash(manifest); lock.event_id = `sha256:${hash(manifest)}`;
  const lockBytes = JSON.stringify(lock, null, 2) + "\n";
  const branch = `${prefix}1.6.3-${hash(manifest).slice(0, 12)}-r0.9.42`;
  const marker = (delivery) => `<!-- pineforge-release ${JSON.stringify({
    event_id: lock.event_id, release_version: "1.6.3", base: "main", delivery_run: delivery, bot,
  })} -->`;
  const oldPR = {
    number: 38, merged: true, merged_at: "2026-10-20T02:00:00Z", merge_commit_sha: source,
    updated_at: "2026-10-23T02:00:00Z", base: { ref: "main", sha: main },
    head: { ref: branch.replace("-r0.9.42", ""), sha: "1111111111111111111111111111111111111111", repo: { full_name: repo } },
    body: marker(123), state: "closed",
  };
  const openPR = {
    ...oldPR, number: 42, merged: false, merged_at: null, merge_commit_sha: null, state: "open",
    head: { ref: branch, sha: candidate, repo: { full_name: repo } }, body: marker(300), mergeable_state: "clean",
  };
  const newPR = { ...openPR, merged: true, merged_at: "2026-10-23T01:00:00Z",
    merge_commit_sha: newMerge, updated_at: "2026-10-23T01:00:00Z", state: "closed" };
  const s = {
    calls: [], network: [], api: {
      [openRoute]: [[]],
      [`users/${encodeURIComponent(bot)}`]: { id: 1234 },
      [`repos/${repo}/git/ref/tags/v0.9.41`]: { object: { type: "tag", sha: annotation } },
      [`repos/${repo}/git/tags/${annotation}`]: { object: { type: "commit", sha: source }, message: `Release v0.9.41\n\nevent_id=${lock.event_id}` },
      [`repos/${repo}/commits/${source}/pulls`]: [oldPR],
      [`repos/${repo}/pulls/38`]: oldPR,
      [`repos/${repo}/pulls/38/commits?per_page=100`]: [{ author: { login: bot } }],
      [`repos/${repo}/pulls/38/files?per_page=100`]: [{ filename: "VERSION", status: "modified" }],
      [`repos/${repo}/pulls/42`]: openPR,
      [runsRoute]: [{ workflow_runs: [publisher] }],
      [`repos/${hub}/git/ref/tags/v1.6.3`]: { object: { type: "commit", sha: lock.hub_commit } },
      "repos/pineforge-4pass/pineforge-engine/git/ref/tags/v1.6.3": { object: { type: "commit", sha: lock.versions.engine.commit } },
      "repos/pineforge-4pass/pineforge-codegen-oss/git/ref/tags/v1.6.3": { object: { type: "commit", sha: lock.versions.codegen.commit } },
      "repos/pineforge-4pass/pineforge-hpo/git/ref/tags/v1.6.3": { object: { type: "commit", sha: lock.versions.hpo.commit } },
    },
    mutations: { [`POST repos/${repo}/pulls`]: { number: 42 } },
    git: {}, responses, manifest, lock, lockBytes, branch, oldPR, openPR, newPR,
    release_files: { "v1.6.3": { "release-manifest.json": manifest, "fixture.whl": wheel, "fixture.tar.gz": hpoSdist } },
  };
  for (const ref of ["origin/main", source, candidate, newMerge, "FETCH_HEAD"]) {
    gitResult(s, ["show", `${ref}:release-lock.json`], lockBytes);
    gitResult(s, ["show", `${ref}:release-manifest.json`], manifest);
    gitResult(s, ["show", `${ref}:VERSION`], ref === candidate || ref === newMerge ? "0.9.42\n" : "0.9.41\n");
  }
  gitResult(s, ["fetch", "origin", "main", "--tags"]);
  gitResult(s, ["fetch", "origin", oldPR.head.sha]);
  gitResult(s, ["rev-parse", "FETCH_HEAD"], oldPR.head.sha);
  gitResult(s, ["merge-base", "--is-ancestor", source, "origin/main"]);
  gitResult(s, ["tag", "-l", "v*"], "v0.9.40\nv0.9.41\n");
  gitResult(s, ["config", "user.name", bot]);
  gitResult(s, ["config", "user.email", `1234+${bot}@users.noreply.github.com`]);
  gitResult(s, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  gitResult(s, ["checkout", "-b", branch, "origin/main"]);
  // Also permit the old name so a branch-name mutant fails the explicit oracle.
  const oldBranch = branch.replace("-r0.9.42", "");
  gitResult(s, ["ls-remote", "--heads", "origin", `refs/heads/${oldBranch}`]);
  gitResult(s, ["checkout", "-b", oldBranch, "origin/main"]);
  const allowed = ["VERSION", "package.json", "package-lock.json", "server.json", "release-lock.json", "release-manifest.json"];
  gitResult(s, ["add", ...allowed]);
  gitResult(s, ["diff", "--cached", "--name-only"], allowed.join("\n") + "\n");
  gitResult(s, ["commit", "-m", "chore(release): 0.9.42 on PineForge 1.6.3"]);
  gitResult(s, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  gitResult(s, ["push", "origin", `HEAD:refs/heads/${oldBranch}`]);
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "src"));
  for (const name of ["sync-version.mjs", "release-contract.mjs", "release-version.mjs"]) {
    writeFileSync(join(root, "scripts", name), readFileSync(new URL(`../../../scripts/${name}`, import.meta.url)));
  }
  writeFileSync(join(root, "package.json"), '{"name":"@pineforge/backtest-mcp","version":"0.9.41","type":"module"}\n');
  writeFileSync(join(root, "package-lock.json"), '{"version":"0.9.41","packages":{"":{"version":"0.9.41"}}}\n');
  writeFileSync(join(root, "server.json"), '{"version":"0.9.41","packages":[]}\n');
  writeFileSync(join(root, "VERSION"), "0.9.41\n");
  writeFileSync(join(root, "release-lock.json"), lockBytes);
  writeFileSync(join(root, "release-manifest.json"), manifest);
  writeFileSync(join(root, "event.json"), JSON.stringify({ action: "pineforge-release", client_payload: lock }));
  return s;
}

export function openRerelease(s, root) {
  s.api[openRoute] = [[s.openPR]];
  s.api[`repos/${repo}/pulls/42/commits?per_page=100`] = [{ author: { login: bot } }];
  s.api[`repos/${repo}/pulls/42/files?per_page=100`] = [{ filename: "VERSION", status: "modified" }];
  gitResult(s, ["fetch", "origin", candidate]);
  gitResult(s, ["rev-parse", "FETCH_HEAD"], candidate);
  s.api[`repos/${repo}/git/ref/heads/main`] = { object: { sha: main } };
  s.api[`repos/${repo}/actions/workflows/test.yml/runs?event=pull_request&head_sha=${candidate}&per_page=100`] = { workflow_runs: [] };
  s.api[`repos/${repo}/compare/main...${candidate}`] = { behind_by: 0 };
  s.api[`repos/${repo}/actions/runs/300`] = {
    id: 300, path: ".github/workflows/pineforge-release.yml", event: "repository_dispatch", conclusion: "success",
  };
  s.api[`repos/${repo}/actions/runs/300/artifacts?per_page=100`] = [{ artifacts: [
    { name: "offline-release-target-300-1", expired: false },
  ] }];
  s.downloads = { 300: {} };
  s.download_files = { 300: { "release-target.json": JSON.stringify(s.lock) } };
  // The named downstream row also forbids this old-source lookup explicitly.
  s.api[`repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`] = [[s.oldPR]];
  writeFileSync(join(root, "event.json"), JSON.stringify({ workflow_run: {
    id: 300, path: ".github/workflows/pineforge-release.yml", head_sha: main, conclusion: "success",
  } }));
  return s;
}
