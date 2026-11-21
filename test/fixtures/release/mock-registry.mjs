// Test subprocess preload. Any accidental network call fails the regression.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
function pendingUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    const keepalive = setInterval(() => {}, 60_000);
    const abort = () => {
      clearInterval(keepalive);
      reject(signal.reason);
    };
    if (!signal) return;
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
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
    if (r.npm_tags) {
      for (const [tag, visibility] of Object.entries(s.npm_tag_visibility ?? {})) {
        visibility.reads += 1;
        if (visibility.remaining > 0) {
          payload["dist-tags"][tag] = visibility.previous;
          visibility.remaining -= 1;
        }
      }
    }
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
    if (r.lateIgnoresSignal) return {
      status: r.status ?? 200,
      json: () => delayedJson(payload, undefined, r.delayMs),
    };
    return new Response(r.base64 ? Buffer.from(r.base64, "base64") : r.body ?? JSON.stringify(payload), { status: r.status ?? 200 });
  }
  if (url !== "https://registry.npmjs.org/@pineforge%2fbacktest-mcp") throw Error(`unexpected network: ${url}`);
  return new Response(JSON.stringify({ "dist-tags": s.npm_tags ?? { latest: s.npm_version } }), { status: 200 });
};

// Test-only subprocess entry point, following invoke-chain's publishNpm harness.
// Inject only a virtual clock; production CLI timing/defaults remain untouched.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const action = process.argv[2];
    if (!["promote", "restore"].includes(action)) throw Error("unknown mock distribution action");
    const distribution = await import("../../../scripts/distribution.mjs");
    if (typeof distribution[action] === "function") {
      let elapsed = 0;
      await distribution[action]({
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
          const current = JSON.parse(readFileSync(process.env.PF_MOCK_STATE, "utf8"));
          (current.sleeps ??= []).push(ms);
          current.elapsed = elapsed;
          writeFileSync(process.env.PF_MOCK_STATE, JSON.stringify(current));
        },
      });
    } else {
      // Parent revisions must fail on their real single read, not missing exports.
      execFileSync(process.execPath, [
        fileURLToPath(new URL("../../../scripts/distribution.mjs", import.meta.url)), action,
      ], { stdio: "inherit" });
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
}
