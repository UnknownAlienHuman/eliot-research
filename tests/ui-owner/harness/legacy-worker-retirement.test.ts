import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLegacyWorkerRetired } from "../../../apps/eliotr-web/src/app/legacy-worker-retirement";

const ORIGIN = "https://owner.example";
const SCRIPT = `${ORIGIN}/sw.js`;
const CACHE = "eliotr-shell-v1";
const PROTOCOL = "eliotr.legacy-worker-retirement.v1";

class Worker extends EventTarget {
  constructor(readonly scriptURL: string, public state: ServiceWorkerState = "activated", readonly tombstone = false) { super(); }
  readonly postMessage = vi.fn((data: { protocol: string; type: string }, transfer: MessagePort[]) => {
    if (this.tombstone && this.state === "activated" && data.protocol === PROTOCOL && data.type === "probe") {
      transfer[0]?.postMessage({ protocol: PROTOCOL, type: "ready" });
    }
  });
  transition(state: ServiceWorkerState) { this.state = state; this.dispatchEvent(new Event("statechange")); }
}
class Registration extends EventTarget {
  installing: Worker | null = null;
  waiting: Worker | null = null;
  readonly update = vi.fn<() => Promise<Registration>>(async () => this);
  readonly unregister = vi.fn<() => Promise<boolean>>(async () => true);
  constructor(readonly scope: string, public active: Worker | null) { super(); }
}
function nativeBoundary(controller: Worker | null = null) {
  const registrations: Registration[] = [];
  const cacheNames = new Set<string>();
  const storage = new Map<string, string>();
  const serviceWorkers = Object.assign(new EventTarget(), {
    controller,
    getRegistrations: vi.fn(async () => registrations.slice()),
  });
  const cacheStorage = {
    keys: vi.fn(async () => [...cacheNames]),
    delete: vi.fn(async (name: string) => cacheNames.delete(name)),
  };
  const sessionStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
  };
  const reload = vi.fn();
  vi.stubGlobal("navigator", { serviceWorker: serviceWorkers });
  vi.stubGlobal("caches", cacheStorage);
  vi.stubGlobal("window", {
    location: { origin: ORIGIN, reload }, sessionStorage,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  });
  function addRegistration(scope = `${ORIGIN}/`, script = SCRIPT) {
    const registration = new Registration(scope, new Worker(script));
    registrations.push(registration);
    registration.update.mockImplementation(async () => {
      registration.active = new Worker(script, "activated", true);
      return registration;
    });
    registration.unregister.mockImplementation(async () => {
      registrations.splice(registrations.indexOf(registration), 1);
      return true;
    });
    return registration;
  }
  return { serviceWorkers, registrations, cacheNames, cacheStorage, sessionStorage, storage, reload, addRegistration };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("native exact legacy-worker retirement", () => {
  it("leaves a fresh browser and unrelated caches unchanged", async () => {
    const native = nativeBoundary();
    native.cacheNames.add("another-app");
    expect(await ensureLegacyWorkerRetired()).toBe(true);
    expect(native.cacheStorage.delete).not.toHaveBeenCalled();
    expect(native.sessionStorage.setItem).not.toHaveBeenCalled();
    expect(native.reload).not.toHaveBeenCalled();
  });

  it.each([
    [`${ORIGIN}/elsewhere/`, SCRIPT],
    [`${ORIGIN}/`, `${SCRIPT}?version=old`],
    [`${ORIGIN}/`, `${SCRIPT}#old`],
    [`${ORIGIN}/`, "https://other.example/sw.js"],
    [`${ORIGIN}/`, `${ORIGIN}/another-worker.js`],
  ])("preserves unmatched scope/script identities (%s, %s)", async (scope, script) => {
    const native = nativeBoundary();
    const registration = native.addRegistration(scope, script);
    expect(await ensureLegacyWorkerRetired()).toBe(true);
    expect(registration.update).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(native.cacheStorage.delete).not.toHaveBeenCalled();
    expect(native.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("waits for the replacement activation rather than trusting an old active worker", async () => {
    const native = nativeBoundary();
    const registration = native.addRegistration();
    const replacement = new Worker(SCRIPT, "installing", true);
    registration.update.mockImplementation(async () => { registration.installing = replacement; return registration; });
    native.cacheNames.add(CACHE);
    native.cacheNames.add("another-app");
    let observed!: () => void;
    const listening = new Promise<void>(resolve => { observed = resolve; });
    const addListener = replacement.addEventListener.bind(replacement);
    vi.spyOn(replacement, "addEventListener").mockImplementation((type, listener, options) => {
      addListener(type, listener, options);
      if (type === "statechange") observed();
    });
    const ready = ensureLegacyWorkerRetired();
    await listening;
    expect(registration.unregister).not.toHaveBeenCalled();
    registration.installing = null;
    registration.waiting = replacement;
    replacement.transition("installed");
    expect(registration.unregister).not.toHaveBeenCalled();
    registration.waiting = null;
    registration.active = replacement;
    replacement.transition("activated");
    expect(await ready).toBe(true);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(registration.unregister).toHaveBeenCalledOnce();
    expect(native.cacheStorage.delete).toHaveBeenCalledExactlyOnceWith(CACHE);
    expect([...native.cacheNames]).toEqual(["another-app"]);
    expect(native.reload).not.toHaveBeenCalled();
  });

  it("requires registration readback even when unregister reports success", async () => {
    const native = nativeBoundary();
    const registration = native.addRegistration();
    registration.unregister.mockResolvedValue(true); // Deliberately retained by the native boundary.
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(native.reload).not.toHaveBeenCalled();
  });

  it("accepts an already activated tombstone only through its readiness acknowledgement", async () => {
    const native = nativeBoundary();
    const registration = native.addRegistration();
    registration.active = new Worker(SCRIPT, "activated", true);
    registration.update.mockResolvedValue(registration);
    expect(await ensureLegacyWorkerRetired()).toBe(true);
    expect(registration.active.postMessage).toHaveBeenCalledOnce();
    expect(registration.unregister).toHaveBeenCalledOnce();
  });

  it("reloads a controlled retired page once and requires controller-null after reload", async () => {
    const native = nativeBoundary(new Worker(SCRIPT));
    native.addRegistration();
    native.cacheNames.add(CACHE);
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(native.reload).toHaveBeenCalledOnce();
    expect(native.sessionStorage.setItem).toHaveBeenCalledOnce();
    expect(native.registrations).toEqual([]);
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(native.reload).toHaveBeenCalledOnce();
    native.serviceWorkers.controller = null;
    expect(await ensureLegacyWorkerRetired()).toBe(true);
    expect(native.reload).toHaveBeenCalledOnce();
    expect(native.sessionStorage.setItem).toHaveBeenCalledOnce();
  });

  it("fails closed for an unrelated controller without touching even an exact registration", async () => {
    const native = nativeBoundary(new Worker(`${ORIGIN}/another-worker.js`));
    const registration = native.addRegistration();
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(registration.update).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(native.cacheStorage.delete).not.toHaveBeenCalled();
    expect(native.reload).not.toHaveBeenCalled();
  });

  it("does not mutate a mixed root registration", async () => {
    const native = nativeBoundary();
    const registration = native.addRegistration();
    registration.waiting = new Worker(`${ORIGIN}/another-worker.js`, "installed");
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(registration.update).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("rejects a readiness reply from the wrong protocol", async () => {
    const native = nativeBoundary();
    const registration = native.addRegistration();
    const tombstone = new Worker(SCRIPT, "activated", true);
    tombstone.postMessage.mockImplementation((_data, transfer) => {
      transfer[0]?.postMessage({ protocol: "wrong", type: "ready" });
    });
    registration.update.mockImplementation(async () => { registration.active = tombstone; return registration; });
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("rejects a valid reply if the exact active worker was replaced", async () => {
    const native = nativeBoundary();
    const registration = native.addRegistration();
    const tombstone = new Worker(SCRIPT, "activated", true);
    tombstone.postMessage.mockImplementation((_data, transfer) => {
      registration.active = new Worker(SCRIPT, "activated", true);
      transfer[0]?.postMessage({ protocol: PROTOCOL, type: "ready" });
    });
    registration.update.mockImplementation(async () => { registration.active = tombstone; return registration; });
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("bounds a stalled update and performs no late unregistration", async () => {
    vi.useFakeTimers();
    const native = nativeBoundary();
    const registration = native.addRegistration();
    let finishUpdate!: (value: Registration) => void;
    registration.update.mockImplementation(() => new Promise<Registration>(resolve => { finishUpdate = resolve; }));
    const ready = ensureLegacyWorkerRetired();
    await vi.runAllTimersAsync();
    expect(await ready).toBe(false);
    finishUpdate(registration);
    await Promise.resolve();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(native.cacheStorage.delete).not.toHaveBeenCalled();
  });

  it("does not accept an old activated /sw.js without the tombstone acknowledgement", async () => {
    vi.useFakeTimers();
    const native = nativeBoundary();
    const registration = native.addRegistration();
    registration.update.mockResolvedValue(registration);
    const ready = ensureLegacyWorkerRetired();
    await vi.runAllTimersAsync();
    expect(await ready).toBe(false);
    expect(registration.active?.postMessage).toHaveBeenCalledOnce();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(native.cacheStorage.delete).not.toHaveBeenCalled();
    expect(native.reload).not.toHaveBeenCalled();
  });

  it("bounds activation when a waiting update never becomes active", async () => {
    vi.useFakeTimers();
    const native = nativeBoundary();
    const registration = native.addRegistration();
    registration.waiting = new Worker(SCRIPT, "installed");
    const ready = ensureLegacyWorkerRetired();
    await vi.runAllTimersAsync();
    expect(await ready).toBe(false);
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("does not delete an orphan cache without an actual matching registration", async () => {
    const native = nativeBoundary();
    native.cacheNames.add(CACHE);
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(native.cacheStorage.delete).not.toHaveBeenCalled();
  });

  it("fails closed when it cannot persist the one-reload marker", async () => {
    const native = nativeBoundary(new Worker(SCRIPT));
    native.sessionStorage.setItem.mockImplementation(() => { throw new Error("Storage denied"); });
    expect(await ensureLegacyWorkerRetired()).toBe(false);
    expect(native.reload).not.toHaveBeenCalled();
  });
});

it("the permanent tombstone has no fetch/claim and acknowledges only the exact readiness protocol", async () => {
  type NativeEvent = { data?: unknown; ports?: { postMessage(data: unknown): void }[]; waitUntil(operation: Promise<unknown>): void };
  const handlers = new Map<string, (event: NativeEvent) => void>();
  const skipWaiting = vi.fn(async () => {});
  const deleteCache = vi.fn(async () => true);
  const code = readFileSync(new URL("../../../apps/eliotr-web/public/sw.js", import.meta.url), "utf8");
  runInNewContext(code, {
    self: { addEventListener: (type: string, handler: (event: NativeEvent) => void) => handlers.set(type, handler), skipWaiting,
      registration: { active: { state: "activated" } } },
    caches: { delete: deleteCache },
  });
  expect([...handlers.keys()]).toEqual(["install", "activate", "message"]);
  const install = handlers.get("install");
  const activate = handlers.get("activate");
  const message = handlers.get("message");
  if (install === undefined || activate === undefined || message === undefined) {
    throw new Error("Missing native tombstone handler");
  }
  const operations: Promise<unknown>[] = [];
  const event = { waitUntil: (operation: Promise<unknown>) => { operations.push(operation); } };
  install(event);
  activate(event);
  await Promise.all(operations);
  expect(skipWaiting).toHaveBeenCalledOnce();
  expect(deleteCache).toHaveBeenCalledExactlyOnceWith(CACHE);
  const postMessage = vi.fn();
  message({ ...event, data: { protocol: "wrong", type: "probe" }, ports: [{ postMessage }] });
  expect(postMessage).not.toHaveBeenCalled();
  message({ ...event, data: { protocol: PROTOCOL, type: "probe" }, ports: [{ postMessage }] });
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ protocol: PROTOCOL, type: "ready" });
});
