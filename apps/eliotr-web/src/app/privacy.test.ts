import { describe, expect, it } from "vitest";
import { bindPrivacyLifecycle, createPrivacyController, type SessionVerification } from "./privacy";

const session: SessionVerification = { principal: "owner", credentialGeneration: "credentials", deploymentGeneration: "deployment", expiresAt: "2027-01-01T00:00:00.000Z" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function harness(verify: (signal: AbortSignal) => Promise<SessionVerification | undefined> = async () => session) {
  const actions: string[] = [];
  let masked = false;
  const privacy = createPrivacyController({
    now: () => Date.parse("2026-10-09T00:00:00.000Z"),
    timers: { setTimeout: () => 0, clearTimeout() {} },
    mask() { masked = true; actions.push("mask"); }, reveal() { masked = false; actions.push("reveal"); },
    cancelReads() { expect(masked).toBe(true); actions.push("cancel"); },
    clearProtected() { expect(masked).toBe(true); actions.push("clear"); }, verify,
  });
  return { privacy, actions, masked: () => masked };
}
describe("composition-root privacy", () => {
  it("starts masked and reveals only the exact verified render commit", async () => {
    const test = harness();
    const initial = test.privacy.getSnapshot();
    expect(test.masked()).toBe(true);
    await test.privacy.refresh();
    expect(test.masked()).toBe(true);
    expect(test.privacy.commitVisible(initial)).toBe(false);
    expect(test.privacy.commitVisible({ ...test.privacy.getSnapshot() })).toBe(false);
    expect(test.privacy.commitVisible(test.privacy.getSnapshot())).toBe(true);
    expect(test.masked()).toBe(false);
  });
  it("masks synchronously before pagehide/auth cleanup and closes the old context", async () => {
    const test = harness(); const target = new EventTarget(); const unbind = bindPrivacyLifecycle(test.privacy, target);
    await test.privacy.refresh(); const rendered = test.privacy.getSnapshot();
    if (rendered.phase !== "available") throw new Error("Expected available fixture");
    test.privacy.commitVisible(rendered); test.actions.length = 0;
    target.dispatchEvent(new Event("pagehide"));
    expect(test.actions).toEqual(["mask", "cancel", "clear"]);
    expect(test.masked()).toBe(true); expect(test.privacy.isCurrent(rendered.context)).toBe(false);
    expect(test.privacy.commitVisible(rendered)).toBe(false);
    target.dispatchEvent(new Event("eliotr:authorization-cleared"));
    expect(test.privacy.getSnapshot().phase).toBe("verifying"); unbind();
  });
  it("persisted pageshow stays masked while fresh verification is unresolved", async () => {
    const pending = deferred<SessionVerification | undefined>(); const test = harness(() => pending.promise);
    const target = new EventTarget(); const unbind = bindPrivacyLifecycle(test.privacy, target);
    target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(test.masked()).toBe(true); expect(test.privacy.getSnapshot().phase).toBe("verifying");
    pending.resolve(session); await Promise.resolve();
    expect(test.privacy.getSnapshot().phase).toBe("available"); expect(test.masked()).toBe(true); unbind();
  });
  it("late verification cannot restore an old session or reveal old DOM", async () => {
    const first = deferred<SessionVerification | undefined>(); const second = deferred<SessionVerification | undefined>();
    let count = 0; const signals: AbortSignal[] = [];
    const test = harness(signal => { signals.push(signal); return count++ === 0 ? first.promise : second.promise; });
    const old = test.privacy.refresh(); const next = test.privacy.refresh();
    second.resolve({ ...session, credentialGeneration: "new" }); await next;
    const current = test.privacy.getSnapshot(); first.resolve(session); await old;
    expect(signals[0]?.aborted).toBe(true); expect(test.privacy.getSnapshot()).toBe(current);
    expect(test.masked()).toBe(true);
  });
  it("failed verification commits only the safe unavailable view", async () => {
    const test = harness(async () => undefined); await test.privacy.refresh();
    expect(test.privacy.getSnapshot().phase).toBe("unavailable");
    expect(test.privacy.commitVisible(test.privacy.getSnapshot())).toBe(true);
  });
  it("repeated React commit never disposes the root controller; disposal rejects late commit", async () => {
    const test = harness(); await test.privacy.refresh(); const rendered = test.privacy.getSnapshot();
    expect(test.privacy.commitVisible(rendered)).toBe(true); expect(test.privacy.commitVisible(rendered)).toBe(true);
    test.privacy.dispose(); test.privacy.dispose(); await test.privacy.refresh();
    expect(test.masked()).toBe(true); expect(test.privacy.commitVisible(rendered)).toBe(false);
  });
  it("unbinding removes all lifecycle listeners", async () => {
    const test = harness(); const target = new EventTarget(); const unbind = bindPrivacyLifecycle(test.privacy, target);
    await test.privacy.refresh(); test.privacy.commitVisible(test.privacy.getSnapshot()); unbind();
    test.actions.length = 0; target.dispatchEvent(new Event("pagehide"));
    target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    target.dispatchEvent(new Event("eliotr:authorization-cleared")); expect(test.actions).toEqual([]);
  });
  it("rejects an expired verification without revealing protected content", async () => {
    const test = harness(async () => ({ ...session, expiresAt: "2026-10-08T23:59:59.000Z" }));
    await test.privacy.refresh();
    expect(test.privacy.getSnapshot().phase).toBe("unavailable");
    expect(test.masked()).toBe(true);
  });
  it("expiry masks before cancelling reads and clearing cache", async () => {
    const actions: string[] = [];
    let now = Date.parse("2026-10-09T00:00:00.000Z");
    let deadline: (() => void) | undefined;
    const privacy = createPrivacyController({
      now: () => now,
      timers: { setTimeout(callback) { deadline = callback; return 1; }, clearTimeout() {} },
      mask() { actions.push("mask"); }, reveal() { actions.push("reveal"); },
      cancelReads() { actions.push("cancel"); }, clearProtected() { actions.push("clear"); },
      async verify() { return { ...session, expiresAt: "2026-10-09T00:00:01.000Z" }; },
    });
    await privacy.refresh();
    const rendered = privacy.getSnapshot();
    if (rendered.phase !== "available" || !deadline) throw new Error("Expected verified deadline");
    expect(privacy.commitVisible(rendered)).toBe(true);
    actions.length = 0;
    now += 1_000;
    deadline();
    expect(actions).toEqual(["mask", "cancel", "clear"]);
    expect(privacy.isCurrent(rendered.context)).toBe(false);
    expect(privacy.commitVisible(rendered)).toBe(false);
    expect(privacy.getSnapshot().phase).toBe("unavailable");
  });
  it("an expiry crossed before React commits cannot paint the available tree", async () => {
    let now = Date.parse("2026-10-09T00:00:00.000Z");
    let revealed = false;
    const privacy = createPrivacyController({
      now: () => now, timers: { setTimeout: () => 0, clearTimeout() {} },
      mask() { revealed = false; }, reveal() { revealed = true; },
      cancelReads() {}, clearProtected() {},
      async verify() { return { ...session, expiresAt: "2026-10-09T00:00:01.000Z" }; },
    });
    await privacy.refresh();
    const rendered = privacy.getSnapshot();
    now += 1_000;
    expect(privacy.commitVisible(rendered)).toBe(false);
    expect(revealed).toBe(false);
    expect(privacy.getSnapshot().phase).toBe("unavailable");
  });
});
