/**
 * One agent per state folder. Two `pnpm paper` (or `pnpm live`) started from the same folder would each decide every
 * bar and write the same portfolio: double decisions, and in live mode possibly double trades. The first one takes
 * `state/<mode>/agent.lock` (its pid); the next one refuses to start while that process is alive. A lock left by a
 * process that no longer exists (crash, reboot) is taken over.
 */

import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type Lock = { readonly release: () => Promise<void> };

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

export async function acquireLock(path: string, o: { pid?: number; alive?: (pid: number) => boolean } = {}): Promise<Lock | { heldBy: number }> {
  const pid = o.pid ?? process.pid, alive = o.alive ?? isAlive;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const f = await open(path, "wx"); // fails if the file exists: no two processes can both create it
      await f.writeFile(`${pid}\n`);
      await f.close();
      return { release: async () => { await rm(path, { force: true }); } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const other = Number.parseInt((await readFile(path, "utf8").catch(() => "")).trim(), 10);
    if (Number.isInteger(other) && other > 0 && other !== pid && alive(other)) return { heldBy: other };
    await rm(path, { force: true }); // stale: its process is gone
  }
  throw new Error(`${path}: could not take the lock`);
}
