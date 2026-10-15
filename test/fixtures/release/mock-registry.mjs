// Test subprocess preload. Any accidental network call fails the regression.
import { readFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url !== "https://registry.npmjs.org/@pineforge%2fbacktest-mcp") throw Error(`unexpected network: ${url}`);
  const s = JSON.parse(readFileSync(process.env.PF_MOCK_STATE, "utf8"));
  return new Response(JSON.stringify({ "dist-tags": { latest: s.npm_version } }), { status: 200 });
};
