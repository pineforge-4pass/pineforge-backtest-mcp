// Test subprocess preload. Any accidental network call fails the regression.
import { readFileSync, writeFileSync } from "node:fs";
function pendingUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function delayedJson(payload, signal, delayMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(payload), delayMs);
    if (!signal) return;
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
globalThis.fetch = async (input, { signal } = {}) => {
  const url = String(input);
  const s = JSON.parse(readFileSync(process.env.PF_MOCK_STATE, "utf8"));
  if (s.network) {
    s.network.push(url);
    writeFileSync(process.env.PF_MOCK_STATE, JSON.stringify(s));
  }
  if (s.responses) {
    let r = s.responses[url];
    if (!r) throw Error(`unexpected network: ${url}`);
    if (r.sequence) {
      const index = (s.response_counts ??= {})[url] ?? 0;
      s.response_counts[url] = index + 1;
      r = r.sequence[Math.min(index, r.sequence.length - 1)];
      if (!r) throw Error(`empty response sequence: ${url}`);
    }
    const payload = r.npm_tags ? { "dist-tags": { ...s.npm_tags } } : r.json;
    s.events?.push({ kind: "fetch", url, status: r.status ?? 200, json: payload });
    writeFileSync(process.env.PF_MOCK_STATE, JSON.stringify(s));
    if (r.error) throw Error(r.error);
    if (r.hang === "fetch") return pendingUntilAbort(signal);
    if (r.hang === "body") return {
      status: r.status ?? 200,
      json: () => pendingUntilAbort(signal),
    };
    if (r.late) return {
      status: r.status ?? 200,
      json: () => delayedJson(payload, signal, r.delayMs),
    };
    return new Response(r.base64 ? Buffer.from(r.base64, "base64") : r.body ?? JSON.stringify(payload), { status: r.status ?? 200 });
  }
  if (url !== "https://registry.npmjs.org/@pineforge%2fbacktest-mcp") throw Error(`unexpected network: ${url}`);
  return new Response(JSON.stringify({ "dist-tags": { latest: s.npm_version } }), { status: 200 });
};
