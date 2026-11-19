import { chmod, copyFile, writeFile } from "node:fs/promises";

// Only use these for files inside the server's private per-run directory.
// Docker mounts the file itself, so the engine can read it without traversing
// that directory. The chmod after creation deliberately bypasses umask.
export async function writeBindInput(path: string, text: string): Promise<void> {
  await writeFile(path, text, "utf8");
  await chmod(path, 0o644);
}

export async function copyBindInput(from: string, path: string): Promise<void> {
  await copyFile(from, path);
  await chmod(path, 0o644);
}
