#!/usr/bin/env node
// Release rules for the pineforge-release fan-out (run by the release workflows).
//
// Versions are X.Y.Z or X.Y.Z-{alpha,beta,rc}.N (a leading "v" is dropped),
// ordered by semver precedence: 1.0.0-rc.1 < 1.0.0, which `sort -V` and git's
// v:refname sort get backwards. A prerelease base pineforge-release gives this
// package a prerelease of its own next patch (base 1.0.0-rc.1 -> 0.9.32-rc.1,
// then 1.0.0 -> 0.9.32), published on npm dist-tag `next`, never `latest`.
//
// CLI (key=value lines on stdout for $GITHUB_OUTPUT; errors on stderr, exit 1):
//   check-payload --release-version=V --prerelease-flag=F   version, prerelease
//   gate --current=BASE --incoming=V                        proceed
//   next --current=VERSION --release=V   (tags on stdin)    next, tag, prerelease
//   latest-tag                           (tags on stdin)    the highest tag
//   channel VERSION                                         prerelease, npm_dist_tag
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const PRE_RANK = { alpha: 0, beta: 1, rc: 2 };

export function parseVersion(text) {
  const m = typeof text === "string" ? VERSION_RE.exec(text) : null;
  if (!m) {
    throw new Error(`rejected version ${JSON.stringify(text)}: expected X.Y.Z or X.Y.Z-{alpha,beta,rc}.N`);
  }
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? { kind: m[4], num: Number(m[5]) } : null,
  };
}

function format(v) {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre ? `${core}-${v.pre.kind}.${v.pre.num}` : core;
}

function key(v) {
  // A release outranks every prerelease of the same X.Y.Z.
  const tail = v.pre ? [0, PRE_RANK[v.pre.kind], v.pre.num] : [1, 0, 0];
  return [v.major, v.minor, v.patch, ...tail];
}

export function compareVersions(a, b) {
  const ka = key(parseVersion(a));
  const kb = key(parseVersion(b));
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
}

export function latestTag(tags) {
  let best = "";
  for (const raw of tags) {
    const tag = raw.trim();
    if (!VERSION_RE.test(tag)) continue;
    if (!best || compareVersions(tag, best) > 0) best = tag;
  }
  return best;
}

export function checkPayload(releaseVersion, prereleaseFlag) {
  const v = parseVersion(releaseVersion);
  if (!["", "true", "false"].includes(prereleaseFlag)) {
    throw new Error(`bad client_payload.prerelease ${JSON.stringify(prereleaseFlag)} (expected true or false)`);
  }
  const prerelease = v.pre !== null;
  if (prereleaseFlag !== "" && (prereleaseFlag === "true") !== prerelease) {
    throw new Error(`client_payload.prerelease=${prereleaseFlag} contradicts release_version ${format(v)}`);
  }
  return { version: format(v), prerelease };
}

export function gate(current, incoming) {
  const inc = format(parseVersion(incoming));
  if (!current) return { proceed: true, reason: `bumping base pineforge-release ∅ -> ${inc}` };
  const order = compareVersions(inc, current);
  if (order === 0) {
    return { proceed: false, reason: `base already ${inc} — nothing to do (duplicate fan-out absorbed).` };
  }
  if (order < 0) {
    // Near-simultaneous upstream releases fan out in arrival order, not version
    // order (observed 2026-07-12): never move the base to a LOWER version.
    return {
      proceed: false,
      reason: `incoming base ${inc} < current ${current} — out-of-order fan-out absorbed (downgrade guard).`,
    };
  }
  return { proceed: true, reason: `bumping base pineforge-release ${current} -> ${inc}` };
}

export function nextVersion(current, release, existingTags) {
  const cur = parseVersion(current);
  const rel = parseVersion(release);
  const tags = new Set(existingTags.map((t) => t.trim()));
  // A stable VERSION is released, so the next one starts at its patch + 1; a
  // prerelease VERSION's X.Y.Z is not, so its release keeps that X.Y.Z.
  let patch = cur.patch + (cur.pre ? 0 : 1);
  const make = () => format({ major: cur.major, minor: cur.minor, patch, pre: rel.pre });
  let next = make();
  while (tags.has(`v${next}`) || compareVersions(next, current) <= 0) {
    patch += 1;
    next = make();
  }
  return next;
}

export function channel(version) {
  const prerelease = parseVersion(version).pre !== null;
  return { prerelease, npmDistTag: prerelease ? "next" : "latest" };
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (m) opts[m[1]] = m[2];
    else positional.push(arg);
  }
  return { opts, positional };
}

function readStdinLines() {
  try {
    return readFileSync(0, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function emit(pairs) {
  for (const [k, v] of Object.entries(pairs)) console.log(`${k}=${v}`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { opts, positional } = parseArgs(rest);
  const need = (name) => {
    if (!(name in opts)) throw new Error(`${cmd}: missing --${name}=`);
    return opts[name];
  };
  switch (cmd) {
    case "check-payload": {
      const r = checkPayload(need("release-version"), opts["prerelease-flag"] ?? "");
      emit({ version: r.version, prerelease: String(r.prerelease) });
      return;
    }
    case "gate": {
      const r = gate(opts.current ?? "", need("incoming"));
      emit({ proceed: String(r.proceed) });
      console.error(r.reason);
      return;
    }
    case "next": {
      const next = nextVersion(need("current"), need("release"), readStdinLines());
      emit({ next, tag: `v${next}`, prerelease: String(channel(next).prerelease) });
      console.error(`backtest-mcp ${opts.current} -> ${next} (base pineforge-release ${opts.release})`);
      return;
    }
    case "latest-tag": {
      const tag = latestTag(readStdinLines());
      if (tag) console.log(tag);
      return;
    }
    case "channel": {
      const r = channel(positional[0]);
      emit({ prerelease: String(r.prerelease), npm_dist_tag: r.npmDistTag });
      return;
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(cmd)}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
