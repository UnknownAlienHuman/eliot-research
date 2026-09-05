import { describe, expect, it } from "vitest";
import { canonicalNavigationJson } from "@eliotr/retrieval";
import { navigationStorageJson, parseStoredNavigationJson } from "./navigation-storage-codec.js";

describe("navigation persistence input boundaries", () => {
  it("preserves prototype-shaped keys in canonical identity bytes", () => {
    const input = JSON.parse('{"z":0,"__proto__":{"polluted":true},"constructor":"data"}');
    expect(canonicalNavigationJson(input)).toBe('{"__proto__":{"polluted":true},"constructor":"data","z":0}');
    expect(parseStoredNavigationJson(navigationStorageJson(input))).toEqual(input);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });
  it("rejects getters without executing them and rejects hidden runtime state", () => {
    let called = false;
    const getter = { get value() { called = true; return "secret"; } };
    const hidden = Object.defineProperty({}, "secret", { value: 1, enumerable: false });
    for (const input of [getter, hidden, new Date(), { [Symbol("symbol")]: 1 }, { value: undefined }, NaN, 1.5, () => 0]) {
      expect(() => navigationStorageJson(input)).toThrow();
    }
    expect(called).toBe(false);
  });
  it("rejects sparse, extended, cyclic and over-wide structures before schema recursion", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const extended = Object.assign([1], { extra: 2 });
    for (const input of [Array(1), Array(40_000).fill(1), extended, cyclic]) expect(() => navigationStorageJson(input)).toThrow();
    let deep: unknown = 1;
    for (let n = 0; n < 40; n += 1) deep = [deep];
    expect(() => navigationStorageJson(deep)).toThrow();
  });
  it("counts UTF-8 and escaped JSON bytes, including property names", () => {
    for (const input of ["я".repeat(500_001), "\u0000".repeat(170_000), { ["x".repeat(1_000_001)]: 0 }]) {
      expect(() => navigationStorageJson(input)).toThrow();
    }
    expect(navigationStorageJson("123", 5)).toBe('"123"');
    expect(() => navigationStorageJson("1234", 5)).toThrow();
  });
  it("rejects malformed, noncanonical and oversized persisted bytes", () => {
    for (const input of [null, "{", '{"b":1,"a":2}', '{"a":1,"a":1}', "[ 1 ]", '"' + "x".repeat(1_000_000) + '"']) {
      expect(() => parseStoredNavigationJson(input)).toThrow();
    }
  });
});
