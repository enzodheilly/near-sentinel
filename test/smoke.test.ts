import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs TypeScript tests on Node 22+", () => {
    const [major] = process.versions.node.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
