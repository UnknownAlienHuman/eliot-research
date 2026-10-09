import { describe, expect, it } from "vitest";
import { createSessionEpoch } from "./epoch";

describe("session epoch", () => {
  it("captures an object capture only while open", () => {
    const epoch = createSessionEpoch();
    expect(epoch.capture()).toBeDefined();
    epoch.close();
    expect(epoch.capture()).toBeUndefined();
  });

  it("answers current only for its own live capture", () => {
    const epoch = createSessionEpoch();
    const capture = epoch.capture();
    expect(epoch.isCurrent(capture)).toBe(true);
    expect(epoch.isCurrent(undefined)).toBe(false);
    expect(epoch.isCurrent({ minted: Symbol("forged"), serial: 1 })).toBe(false);
    const other = createSessionEpoch();
    expect(epoch.isCurrent(other.capture())).toBe(false);
  });

  it("advance keeps one live identity and invalidates the previous", () => {
    const epoch = createSessionEpoch();
    const before = epoch.advance();
    const after = epoch.advance();
    expect(after).not.toBe(before);
    expect(epoch.isCurrent(before)).toBe(false);
    expect(epoch.isCurrent(after)).toBe(true);
    const captured = epoch.capture();
    expect(captured).toBe(after);
  });

  it("close blocks capture until advance", () => {
    const epoch = createSessionEpoch();
    const first = epoch.capture();
    epoch.close();
    expect(epoch.isCurrent(first)).toBe(false);
    expect(epoch.capture()).toBeUndefined();
    const fresh = epoch.advance();
    expect(epoch.capture()).toBe(fresh);
    expect(epoch.isCurrent(fresh)).toBe(true);
  });

  it("dispose is terminal and advance then throws", () => {
    const epoch = createSessionEpoch();
    const first = epoch.capture();
    epoch.dispose();
    expect(epoch.capture()).toBeUndefined();
    expect(epoch.isCurrent(first)).toBe(false);
    expect(() => epoch.advance()).toThrow(TypeError);
    expect(() => epoch.close()).not.toThrow();
  });
});
