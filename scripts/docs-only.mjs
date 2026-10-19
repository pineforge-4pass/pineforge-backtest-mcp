import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isDocsOnly({ eventName, headRef, actor, triggeringActor, files, gitFailed = false }) {
  // The release App's slug is discovered at run time. Exclude every bot in
  // either identity, and require at least one identity before allowing a skip.
  const actors = [actor, triggeringActor].filter((login) => typeof login === "string" && login !== "");
  return eventName === "pull_request"
    && typeof headRef === "string"
    && !headRef.startsWith("bot/pineforge-release/")
    && actors.length > 0
    && actors.every((login) => !login.endsWith("[bot]"))
    && !gitFailed
    && Array.isArray(files)
    && files.length > 0
    && files.every((path) => typeof path === "string" && /^docs\/.+\.md$/.test(path));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let files = [];
  let gitFailed = false;
  try {
    // PR checkout is the merge commit: its first parent is the tested base.
    // Disabling rename detection keeps both the removed and added paths.
    files = execFileSync("git", ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter((path) => path !== "");
  } catch {
    gitFailed = true;
  }
  const docsOnly = isDocsOnly({
    eventName: process.env.GITHUB_EVENT_NAME,
    headRef: process.env.GITHUB_HEAD_REF,
    actor: process.env.GITHUB_ACTOR,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    files,
    gitFailed,
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
  console.log(String(docsOnly));
}
