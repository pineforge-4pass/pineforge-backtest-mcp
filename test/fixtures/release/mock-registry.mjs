// Test subprocess preload. Any accidental network call fails the regression.
import { readFileSync, writeFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  const url = String(input);
  const s = JSON.parse(readFileSync(process.env.PF_MOCK_STATE, "utf8"));
  if (s.network) {
    s.network.push(url);
    writeFileSync(process.env.PF_MOCK_STATE, JSON.stringify(s));
  }
  if (s.responses) {
    const r = s.responses[url];
    if (!r) throw Error(`unexpected network: ${url}`);
    if (r.error) throw Error(r.error);
    return new Response(r.base64 ? Buffer.from(r.base64, "base64") : r.body ?? JSON.stringify(r.json), { status: r.status ?? 200 });
  }
  if (url !== "https://registry.npmjs.org/@pineforge%2fbacktest-mcp") throw Error(`unexpected network: ${url}`);
  return new Response(JSON.stringify({ "dist-tags": { latest: s.npm_version } }), { status: 200 });
};
