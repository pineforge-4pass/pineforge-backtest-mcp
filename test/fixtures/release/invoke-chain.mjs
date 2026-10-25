// CI-only entry point: exercise real helpers and external mock transports.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as consumer from "../../../scripts/release-consumer.mjs";
import * as distribution from "../../../scripts/distribution.mjs";
import { pr } from "./chain-inputs.mjs";

const state = JSON.parse(readFileSync(process.env.PF_MOCK_STATE, "utf8"));
try {
  const name = process.argv[2];
  let value;
  const observation = {};
  if (name === "latestGate") {
    assert.equal(typeof consumer.latestGate, "function", "latestGate must be testable");
    value = consumer.latestGate(pr);
  } else if (name === "receive" || name === "advance") {
    assert.equal(typeof consumer[name], "function", `${name} must be testable`);
    // Keep the wire result parseable while retaining coordinator diagnostics.
    const log = console.log;
    console.log = (...args) => console.error(...args);
    try { await consumer[name](); value = "done"; }
    finally { console.log = log; }
  } else if (name === "landedPR") {
    assert.equal(typeof consumer.landedPR, "function", "landedPR must bind the current VERSION");
    value = consumer.landedPR(state.merged_prs, state.lock, "0.9.42");
  } else if (name === "existingImage") {
    assert.equal(typeof distribution.existingImage, "function", "existingImage must be testable");
    value = distribution.existingImage(state.image_ref);
  } else if (name === "publishNpm") {
    let elapsed = 0;
    const timing = {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
        const current = JSON.parse(readFileSync(process.env.PF_MOCK_STATE, "utf8"));
        (current.sleeps ??= []).push(ms);
        current.elapsed = elapsed;
        writeFileSync(process.env.PF_MOCK_STATE, JSON.stringify(current));
      },
      ...(state.timing ?? {}),
    };
    if (typeof distribution.publishNpm === "function") await distribution.publishNpm(timing);
    else {
      // Red-case runs on the original script must exercise its real CLI, not
      // fail just because that revision did not yet export publishNpm.
      const output = execFileSync(process.execPath, [fileURLToPath(new URL("../../../scripts/distribution.mjs", import.meta.url)), "npm"], { encoding: "utf8" });
      process.stderr.write(output);
    }
    value = "published";
  } else if (name === "publishDefaultClock") {
    const wallStart = Date.now();
    Date.now = () => wallStart - 3_600_000;
    await distribution.publishNpm(state.timing);
    value = "published";
  } else if (name === "npmScratchTag") {
    assert.equal(typeof distribution.npmScratchTag, "function", "npmScratchTag must be testable");
    value = distribution.npmScratchTag(...state.scratch_inputs);
  } else {
    assert.equal(name, "previousIdentity");
    assert.equal(typeof distribution.previousIdentity, "function", "previousIdentity must be testable");
    value = await distribution.previousIdentity("0.9.40", state.consumer_image ?? state.image_digest, "latest", observation);
  }
  console.log(JSON.stringify({ value, ...observation }));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
