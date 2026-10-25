// Invoke the real exported helper with only the external gh transport replaced.
import { readFileSync } from "node:fs";
import { latestGate } from "../../../scripts/release-consumer.mjs";

const state = JSON.parse(readFileSync(process.env.PF_PROBE_STATE, "utf8"));
try {
  console.log(JSON.stringify({ value: latestGate(state.pr) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
