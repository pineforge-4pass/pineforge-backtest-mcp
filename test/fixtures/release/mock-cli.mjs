#!/usr/bin/env node
// Test-only external tools. The production distribution script remains intact.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const file = process.env.PF_MOCK_STATE;
const s = JSON.parse(readFileSync(file, "utf8"));
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const input = args.includes("--input") ? JSON.parse(readFileSync(0, "utf8")) : undefined;
s.calls.push({ tool, args, ...(input ? { input } : {}) });
writeFileSync(file, JSON.stringify(s));
if (tool === "git" && s.git) {
  const key = JSON.stringify(args);
  if (!(key in s.git)) { console.error(`unexpected git command: ${key}`); process.exit(2); }
  if (args[0] === "fetch" && args.length === 3 && /^[0-9a-f]{40}$/.test(args[2])) {
    s.fetched_sha = args[2];
    writeFileSync(file, JSON.stringify(s));
  }
  process.stdout.write(args.join(" ") === "rev-parse FETCH_HEAD" && s.fetched_sha ? s.fetched_sha : s.git[key]);
} else if (tool === "gh" && args[0] === "api" && s.api) {
  if (input) {
    const key = `${args[args.indexOf("--method") + 1]} ${args[args.indexOf("--method") + 2]}`;
    if (!(key in (s.mutations ?? {}))) { console.error(`unexpected mutation: ${key}`); process.exit(2); }
    console.log(JSON.stringify(s.mutations[key]));
    process.exit(0);
  }
  const route = args.at(-1);
  if (route in (s.api_raw ?? {})) { process.stdout.write(s.api_raw[route]); process.exit(0); }
  if (!(route in s.api)) { console.error(`unexpected API route: ${route}`); process.exit(2); }
  console.log(JSON.stringify(s.api[route]));
} else if (tool === "gh" && args.slice(0, 2).join(" ") === "run download" && s.downloads) {
  const receipt = s.downloads[args[2]];
  if (!receipt) { console.error("missing fixture receipt"); process.exit(2); }
  const dir = args[args.indexOf("--dir") + 1];
  if (s.download_files?.[args[2]]) {
    for (const [name, body] of Object.entries(s.download_files[args[2]])) writeFileSync(`${dir}/${name}`, body);
  } else writeFileSync(`${dir}/gate-receipt.json`, JSON.stringify(receipt));
} else if (tool === "gh" && args.slice(0, 2).join(" ") === "release download" && s.release_files?.[args[2]]) {
  for (const [name, body] of Object.entries(s.release_files[args[2]])) writeFileSync(`${args[args.indexOf("--dir") + 1]}/${name}`, body);
} else if (tool === "gh" && args.slice(0, 2).join(" ") === "release download" && s.manifest) {
  writeFileSync(`${args[args.indexOf("--dir") + 1]}/release-manifest.json`, s.manifest);
} else if (tool === "gh" && args[0] === "api") {
  console.log(JSON.stringify({ path: s.workflow ?? ".github/workflows/publish.yml", event: "push", head_sha: "b".repeat(40) }));
} else if (tool === "gh" && args[0] === "release") {
  // Recorded previous GitHub Latest pointer restoration.
} else if (tool === "gh" && args[0] === "issue" && s.incident_url) {
  // Promotion's incident notification stays inside the mock transport.
  if (args[1] === "create") console.log(s.incident_url);
} else if (tool === "npm" && args[0] === "--version") console.log(s.cli ?? "11.21.0");
else if (tool === "npm" && args[0] === "dist-tag" && args[1] === "add") {
  if (s.deny_dist_tag) { console.error("trusted publisher cannot manage dist-tags"); process.exit(1); }
  s.npm_version = args[2].split("@").at(-1);
  writeFileSync(file, JSON.stringify(s));
} else if (tool === "docker" && args.slice(0, 3).join(" ") === "buildx imagetools inspect") {
  if (s.missing_image) { console.error("manifest unknown"); process.exit(1); }
  console.log(`Digest: ${s.image_digest}`);
} else if (tool === "docker" && args.slice(0, 3).join(" ") === "buildx imagetools create") {
  s.image_digest = args.at(-1).split("@")[1]; writeFileSync(file, JSON.stringify(s));
} else { console.error(`unexpected ${tool} ${args.join(" ")}`); process.exit(2); }
