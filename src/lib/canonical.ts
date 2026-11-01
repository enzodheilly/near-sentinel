/**
 * Canonical JSON (RFC 8785, JSON Canonicalization Scheme) and SHA-256.
 *
 * Decision records are hashed with `hashCanonical`, so the same logical record always produces
 * the same hash, whatever the key order or the machine (ARCHITECTURE.md §10).
 *
 * Before canonicalising, values are normalised strictly:
 * - `bigint` becomes its decimal string (`12n` → `"12"`), so on-chain amounts can be hashed;
 * - object properties set to `undefined` are dropped (as JSON.stringify does), which matches
 *   optional fields that are absent;
 * - anything that JSON would silently change or lose is rejected with the path of the value:
 *   non-finite numbers, `undefined` inside arrays, functions, symbols, and non-plain objects
 *   (Map, Set, class instances other than Date).
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export class CanonicalizationError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`cannot canonicalise value at ${path}: ${reason}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function normalise(value: unknown, path: string): Json | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError(path, `non-finite number (${value})`);
      return Object.is(value, -0) ? 0 : value;
    case "bigint":
      return value.toString(10);
    case "undefined":
      return undefined;
    case "function":
    case "symbol":
      throw new CanonicalizationError(path, `${typeof value} is not serialisable`);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const n = normalise(item, `${path}[${i}]`);
      if (n === undefined) throw new CanonicalizationError(`${path}[${i}]`, "undefined inside an array");
      return n;
    });
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new CanonicalizationError(path, "invalid Date");
    return value.toISOString();
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(path, `non-plain object (${proto?.constructor?.name ?? "unknown"})`);
  }
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) {
    const n = normalise(v, `${path}.${k}`);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/** RFC 8785 canonical JSON string of `value`. Throws `CanonicalizationError` on ambiguous input. */
export function canonicalJson(value: unknown): string {
  const normalised = normalise(value, "$");
  if (normalised === undefined) throw new CanonicalizationError("$", "top-level undefined");
  const out = canonicalize(normalised);
  if (out === undefined) throw new CanonicalizationError("$", "canonicalize returned undefined");
  return out;
}

/** Lowercase hex SHA-256 of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of the canonical JSON of `value`. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
