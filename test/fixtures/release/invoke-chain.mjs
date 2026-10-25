// CI-only entry point: exercise real helpers and external mock transports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
