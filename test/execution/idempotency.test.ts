import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DuplicateExecutionError, executeOnce } from "../../src/execution/executor.ts";
import { FileKeys, MemoryKeys } from "../../src/execution/idempotency.ts";
import { idempotencyKey, type ExecutionReport, type ExitProposal, type Quote } from "../../src/types.ts";

const exit: ExitProposal = { kind: "EXIT", asset: "NEAR", barTime: 1_790_000_000_000, reason: "STOP", referencePrice: 2, quantity: 10, fraction: 1 };
const quote = {} as Quote;
const ok: ExecutionReport = { mode: "replay", status: "SIMULATED", txRefs: [], fill: { quantityIn: 10, quantityOut: 20, price: 2 } };
const file = () => join(mkdtempSync(join(tmpdir(), "keys-")), "state", "executed.jsonl");

describe("executeOnce + idempotency registry", () => {
  it("a second execution of the same key is refused and the executor is not called", async () => {
    const keys = new MemoryKeys();
    let calls = 0;
    const ex = { execute: async () => (calls++, ok) };
    await executeOnce(ex, keys, exit, quote);
    await expect(executeOnce(ex, keys, exit, quote)).rejects.toBeInstanceOf(DuplicateExecutionError);
    expect(calls).toBe(1);
    expect(keys.has(idempotencyKey(exit))).toBe(true);
  });

  it("refused after a restart: the registry is read back from disk", async () => {
    const path = file();
    await executeOnce({ execute: async () => ok }, new FileKeys(path), exit, quote);
    const restarted = new FileKeys(path); // new process
    expect(restarted.has(idempotencyKey(exit))).toBe(true);
    await expect(executeOnce({ execute: async () => ok }, restarted, exit, quote)).rejects.toThrow(/twice/);
  });

  it("a crash during execution leaves the key pending: refused after restart, listed for reconciliation", async () => {
    const path = file();
    await expect(executeOnce({ execute: async () => { throw new Error("process killed"); } }, new FileKeys(path), exit, quote)).rejects.toThrow("killed");
    const restarted = new FileKeys(path);
    expect(restarted.has(idempotencyKey(exit))).toBe(true);
    expect(restarted.pending()).toEqual([idempotencyKey(exit)]);
  });

  it("a certain failure (FAILED, REFUNDED) releases the key so the trade can be tried again", async () => {
    for (const status of ["FAILED", "REFUNDED"] as const) {
      const keys = new FileKeys(file());
      await executeOnce({ execute: async () => ({ ...ok, status }) }, keys, exit, quote);
      expect(keys.has(idempotencyKey(exit))).toBe(false);
      await executeOnce({ execute: async () => ok }, keys, exit, quote);
      expect(keys.has(idempotencyKey(exit))).toBe(true);
    }
  });

  it("the file is plain JSON lines, last state wins", () => {
    const path = file();
    const k = new FileKeys(path, () => 42);
    k.begin("NEAR:1:ENTRY");
    k.complete("NEAR:1:ENTRY");
    expect(readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { key: "NEAR:1:ENTRY", state: "pending", at: 42 },
      { key: "NEAR:1:ENTRY", state: "done", at: 42 },
    ]);
  });

  it("a corrupted file stops the agent instead of risking a double trade", () => {
    const path = file();
    new FileKeys(path).begin("x");
    appendFileSync(path, "{not json\n");
    expect(() => new FileKeys(path)).toThrow(/line 2 is not valid JSON; refusing to start/);
    writeFileSync(path, `${JSON.stringify({ key: "x", state: "maybe" })}\n`);
    expect(() => new FileKeys(path)).toThrow(/line 1 is malformed/);
  });
});
