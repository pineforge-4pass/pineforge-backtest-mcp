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
  if (name === "latestGate") {
    assert.equal(typeof consumer.latestGate, "function", "latestGate must be testable");
    value = consumer.latestGate(pr);
  } else {
    assert.equal(name, "previousIdentity");
    assert.equal(typeof distribution.previousIdentity, "function", "previousIdentity must be testable");
    value = await distribution.previousIdentity("0.9.40", state.consumer_image ?? state.image_digest, "latest");
  }
  console.log(JSON.stringify({ value }));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
