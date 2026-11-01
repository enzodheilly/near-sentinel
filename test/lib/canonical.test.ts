import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalJson, hashCanonical, sha256Hex } from "../../src/lib/canonical.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 0, y: 1 }], c: 2 } })).toBe('{"a":{"c":2,"d":[1,{"y":1,"z":0}]},"b":1}');
  });

  it("serialises bigint as a decimal string", () => {
    expect(canonicalJson({ amount: 1_000_000_000_000_000_000_000_000n })).toBe('{"amount":"1000000000000000000000000"}');
  });

  it("drops undefined object properties, like an absent optional field", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("normalises -0 to 0 and dates to ISO strings", () => {
    expect(canonicalJson({ x: -0, t: new Date("2026-11-01T00:00:00Z") })).toBe('{"t":"2026-11-01T00:00:00.000Z","x":0}');
  });

  it.each([
    [{ a: Number.NaN }, "$.a"],
    [{ a: [1, Number.POSITIVE_INFINITY] }, "$.a[1]"],
    [{ a: [undefined] }, "$.a[0]"],
    [{ f: () => 1 }, "$.f"],
    [{ m: new Map() }, "$.m"],
    [{ s: Symbol("x") }, "$.s"],
  ])("rejects %o with the path of the bad value", (value, path) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalizationError);
    try {
      canonicalJson(value);
    } catch (e) {
      expect((e as CanonicalizationError).path).toBe(path);
    }
  });

  it("rejects a top-level undefined", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalizationError);
  });
});

describe("hashCanonical", () => {
  it("gives the same hash whatever the key insertion order (property)", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null))), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(hashCanonical(reversed)).toBe(hashCanonical(obj));
      }),
    );
  });

  it("changes when any value changes", () => {
    expect(hashCanonical({ close: 3.12 })).not.toBe(hashCanonical({ close: 3.13 }));
  });

  it("is plain SHA-256 of the canonical string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashCanonical({ b: 2, a: 1 })).toBe(sha256Hex('{"a":1,"b":2}'));
  });
});
