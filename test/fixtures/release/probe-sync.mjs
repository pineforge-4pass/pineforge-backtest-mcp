// Enter the real sync script after dropping root's permission bypass. Drop
// inside Node so a root-owned Node installation can still start the control.
import { pathToFileURL } from "node:url";

if (process.getuid?.() === 0) {
  process.setgid(65534);
  process.setuid(65534);
}
await import(pathToFileURL(process.argv[2]).href);
