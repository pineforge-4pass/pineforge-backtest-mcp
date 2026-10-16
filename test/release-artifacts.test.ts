import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-ignore workflow module.
import { chooseArtifact } from "../scripts/release-artifacts.mjs";
const artifact = (name: string, expired = false) => ({ name, expired });
test("reruns retain history and use the newest evidence for the same source run", () => {
  const a = [artifact("offline-runtime-amd64-17-1"), artifact("offline-runtime-amd64-17-2"), artifact("offline-runtime-amd64-18-9")];
  assert.equal(chooseArtifact(a, "offline-runtime-amd64", 17), "offline-runtime-amd64-17-2");
  assert.equal(chooseArtifact(a, "offline-runtime-amd64", 18), "offline-runtime-amd64-18-9");
  assert.throws(() => chooseArtifact(a, "offline-runtime-arm64", 17));
  assert.throws(() => chooseArtifact(a, "offline-runtime-amd64", 19));
});
test("an expired newest attempt cannot be replaced by an older green artifact", () => {
  assert.throws(() => chooseArtifact([artifact("offline-gate-17-1"), artifact("offline-gate-17-2", true)], "offline-gate", 17), /expired/);
  assert.throws(() => chooseArtifact([artifact("offline-gate-17-two")], "offline-gate", 17), /missing/);
});

test("collectors isolate colliding artifact files and read recorded inputs from their directories", () => {
  const selections: Record<string, string[]> = {
    package: ["offline-package"],
    evidence: ["offline-package", "offline-runtime-amd64", "offline-runtime-arm64"],
    gate: ["offline-gate", "offline-package"],
    "image-input": ["offline-channels", "offline-gate", "offline-image-amd64", "offline-image-arm64"],
    "npm-input": ["offline-channels", "offline-package"],
    "promotion-input": ["offline-channels", "offline-gate", "offline-image-publication"],
    "restore-input": ["offline-channels", "offline-image-publication"],
  };
  for (const [kind, prefixes] of Object.entries(selections)) {
    const root = mkdtempSync(join(tmpdir(), "pf-artifact-test-"));
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const prefixes = ["offline-package", "offline-runtime-amd64", "offline-runtime-arm64", "offline-gate", "offline-channels", "offline-image-amd64", "offline-image-arm64", "offline-image-publication"];
if (args[0] === "api") {
  console.log(JSON.stringify([{ artifacts: prefixes.flatMap((p) => [1, 2].map((a) => ({ name: p + "-17-" + a, expired: false }))) }]));
} else {
  const name = args[args.indexOf("--name") + 1];
  const dir = args[args.indexOf("--dir") + 1];
  mkdirSync(dir, { recursive: true });
  // Exclusive creation reproduces gh's refusal to overwrite shared basenames.
  writeFileSync(join(dir, "default-pin-red.tap"), name, { flag: "wx" });
  const prefix = name.replace(/-17-[12]$/, "");
  const files = {
    "offline-package": { "package.json": { attempt: name.endsWith("-1") ? "1" : "2" } },
    "offline-gate": { "gate-receipt.json": { package: { attempt: "1" }, runtime: ["amd64", "arm64"].map((arch) => ({ arch, mode: "image", artifact_attempt: "1" })) } },
    "offline-channels": { "channel-state.json": { run_id: "17", gate_artifact: "offline-gate-17-1", package_artifact: "offline-package-17-1" } },
  };
  for (const [file, value] of Object.entries(files[prefix] || {})) writeFileSync(join(dir, file), JSON.stringify(value), { flag: "wx" });
}
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/release-artifacts.mjs", import.meta.url)), kind], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: "pineforge-4pass/pineforge-backtest-mcp", GITHUB_RUN_ID: "17", ARTIFACT_SOURCE_RUN: "17" },
    });
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    for (const prefix of prefixes) assert.ok(existsSync(join(root, ".release-ci", prefix, "default-pin-red.tap")), `${kind}: missing ${prefix}`);
    assert.ok(!existsSync(join(root, ".release-ci", "default-pin-red.tap")));
    if (["package", "evidence", "gate", "npm-input"].includes(kind)) {
      const pkg = JSON.parse(readFileSync(join(root, ".release-ci/offline-package/package.json"), "utf8"));
      assert.equal(pkg.attempt, ["gate", "npm-input"].includes(kind) ? "1" : "2");
    }
  }
});
