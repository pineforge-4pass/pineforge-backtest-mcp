import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const [, , mask, entrypoint] = process.argv;
if (!/^0[0-7]{2}$/.test(mask ?? "") || !entrypoint || !isAbsolute(entrypoint)) {
  throw new Error("usage: with-umask.mjs <octal mask> <absolute installed entrypoint> [args...]");
}

process.umask(Number.parseInt(mask, 8));
process.argv.splice(1, 2); // The installed entrypoint sees the same argv as a direct Node launch.
await import(pathToFileURL(entrypoint).href);
