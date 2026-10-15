// Resolve immutable artifacts by run and attempt. Failed-job reruns may reuse
// successful jobs from an earlier attempt of the same source, but never hide a
// newer failed runtime attempt behind older success evidence.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gh } from "./release-contract.mjs";

export function chooseArtifact(artifacts, prefix, run) {
  assert.match(String(run), /^[1-9][0-9]*$/);
  const matches = artifacts.filter((a) => a.name.startsWith(`${prefix}-${run}-`) && /^[1-9][0-9]*$/.test(a.name.slice(`${prefix}-${run}-`.length)))
    .sort((a, b) => Number(b.name.split("-").at(-1)) - Number(a.name.split("-").at(-1)));
  assert.ok(matches.length, `missing ${prefix} artifact`);
  assert.equal(matches[0].expired, false, "latest evidence expired; cannot fall back");
  return matches[0].name;
}
export function collect(kind, run = process.env.GITHUB_RUN_ID) {
  const repo = process.env.GITHUB_REPOSITORY;
  assert.match(repo ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(String(run), /^[1-9][0-9]*$/);
  const artifacts = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${run}/artifacts?per_page=100`)).flatMap((p) => p.artifacts);
  mkdirSync(".release-ci", { recursive: true });
  // Each selected artifact has its own directory: runtime TAP files and image
  // metadata can share basenames with artifacts from other jobs.
  const download = (prefix, name) => {
    assert.ok(name.startsWith(`${prefix}-${run}-`) && /^[1-9][0-9]*$/.test(name.slice(`${prefix}-${run}-`.length)), "wrong recorded artifact identity");
    assert.ok(artifacts.some((a) => a.name === name && !a.expired), `missing recorded artifact ${name}`);
    gh("run", "download", String(run), "--repo", repo, "--name", name, "--dir", `.release-ci/${prefix}`);
  };
  const latest = (prefix) => download(prefix, chooseArtifact(artifacts, prefix, run));
  const read = (prefix, file) => JSON.parse(readFileSync(`.release-ci/${prefix}/${file}`, "utf8"));
  if (kind === "package") latest("offline-package");
  else if (kind === "evidence") {
    latest("offline-package");
    for (const arch of ["amd64", "arm64"]) latest(`offline-runtime-${arch}`);
  } else if (kind === "gate") {
    latest("offline-gate");
    const p = read("offline-gate", "gate-receipt.json").package;
    download("offline-package", `offline-package-${run}-${p.attempt}`);
  } else {
    latest("offline-channels");
    const state = read("offline-channels", "channel-state.json");
    assert.equal(String(state.run_id), String(run));
    if (kind === "image-input") {
      download("offline-gate", state.gate_artifact);
      const gate = read("offline-gate", "gate-receipt.json");
      for (const arch of ["amd64", "arm64"]) {
        const evidence = gate.runtime.find((e) => e.arch === arch && e.mode === "image");
        download(`offline-image-${arch}`, `offline-image-${arch}-${run}-${evidence.artifact_attempt}`);
      }
    } else if (kind === "npm-input") download("offline-package", state.package_artifact);
    else if (kind === "promotion-input") {
      download("offline-gate", state.gate_artifact);
      latest("offline-image-publication");
    } else if (kind === "restore-input") latest("offline-image-publication");
    else throw Error("unrecognized artifact selection");
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { collect(process.argv[2], process.env.ARTIFACT_SOURCE_RUN ?? process.env.GITHUB_RUN_ID); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
