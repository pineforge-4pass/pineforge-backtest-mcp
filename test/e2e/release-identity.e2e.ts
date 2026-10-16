import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "./client.js";

test("the distributed entry point serves the locked package and hub identity", async () => {
  const lock = JSON.parse(readFileSync("release-lock.json", "utf8"));
  const client = await connect();
  try {
    assert.equal(client.getServerVersion()?.version, readFileSync("VERSION", "utf8").trim());
    if (process.env.PF_E2E_MODE === "image") {
      const r = await client.callTool({ name: "engine_info", arguments: {} });
      assert.ok(!r.isError);
      const content = r.content as Array<{ text?: string }>;
      const info = r.structuredContent ?? JSON.parse(content.find((c) => c.text)?.text ?? "{}");
      assert.equal(info.version, lock.release_version);
      assert.equal(info.baked_in, true);
    } else {
      const r = await client.callTool({ name: "check_engine_image", arguments: {} });
      assert.ok(!r.isError);
      const content = r.content as Array<{ text?: string }>;
      const info = r.structuredContent ?? JSON.parse(content.find((c) => c.text)?.text ?? "{}");
      assert.equal(info.image, `${lock.image.repository}@${lock.image.digest}`);
      assert.equal(info.local_present, true);
      assert.ok(!info.error, String(info.error));
    }
  } finally { await client.close(); }
});
