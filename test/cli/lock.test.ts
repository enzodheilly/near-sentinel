import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock } from "../../src/cli/lock.ts";

describe("one agent per state folder", () => {
  it("the second agent is refused while the first runs; the lock is free again once released", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lock-")), "paper", "agent.lock");
    const alive = (pid: number) => pid === 111;
    const first = await acquireLock(path, { pid: 111, alive });
    expect("release" in first).toBe(true);
    expect(await readFile(path, "utf8")).toBe("111\n");
    expect(await acquireLock(path, { pid: 222, alive })).toEqual({ heldBy: 111 });
    if ("release" in first) await first.release();
    expect("release" in (await acquireLock(path, { pid: 222, alive }))).toBe(true);
  });

  it("a lock left by a process that is gone (crash, reboot) is taken over", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "lock-")), "agent.lock");
    await writeFile(path, "999\n");
    const l = await acquireLock(path, { pid: 333, alive: () => false });
    expect("release" in l).toBe(true);
    expect(await readFile(path, "utf8")).toBe("333\n");
  });

  it("pnpm paper refuses to start next to a running one, and says how to stop it", async () => {
    const root = await mkdtemp(join(tmpdir(), "lock-run-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "state", "paper"), { recursive: true });
    await writeFile(join(root, "state", "paper", "agent.lock"), `${process.ppid}\n`); // a live process that is not us
    const { runPaper } = await import("../../src/cli/run.ts");
    const out: string[] = [];
    expect(await runPaper({ root, env: {}, write: (l) => out.push(l) })).toBe(2);
    expect(out.join("\n")).toMatch(new RegExp(`another paper agent is already running from this folder \\(process ${process.ppid}\\)`));
  });
});
