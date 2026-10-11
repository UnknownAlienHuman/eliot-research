const LEGACY_CACHE = "eliotr-shell-v1";
const RETIREMENT_PROTOCOL = "eliotr.legacy-worker-retirement.v1";
const RELOAD_MARKER = "eliotr:legacy-worker-retirement:reload";
const RETIREMENT_TIMEOUT_MS = 10_000;

function bounded<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  if (Date.now() >= deadline) return Promise.reject(new Error("Worker retirement timed out"));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Worker retirement timed out")), Math.max(0, deadline - Date.now()));
    Promise.resolve().then(operation).then(
      value => { window.clearTimeout(timer); resolve(value); },
      error => { window.clearTimeout(timer); reject(error); },
    );
  });
}

function workers(registration: ServiceWorkerRegistration): ServiceWorker[] {
  return [registration.installing, registration.waiting, registration.active]
    .filter((worker): worker is ServiceWorker => worker !== null);
}

function exactUrl(value: string, expected: string): boolean {
  try { return new URL(value, window.location.origin).href === expected; }
  catch { return false; }
}

function isLegacyWorker(worker: ServiceWorker): boolean {
  return exactUrl(worker.scriptURL, new URL("/sw.js", window.location.origin).href);
}

function isRootRegistration(registration: ServiceWorkerRegistration): boolean {
  return exactUrl(registration.scope, new URL("/", window.location.origin).href);
}

function hasLegacyWorker(registration: ServiceWorkerRegistration): boolean {
  const held = workers(registration);
  return isRootRegistration(registration) && (held.length === 0 || held.some(isLegacyWorker));
}

function isExactRegistration(registration: ServiceWorkerRegistration): boolean {
  const held = workers(registration);
  return isRootRegistration(registration) && held.length > 0 && held.every(isLegacyWorker);
}

function waitForActivation(registration: ServiceWorkerRegistration, deadline: number): Promise<boolean> {
  if (Date.now() >= deadline) return Promise.resolve(false);
  return new Promise(resolve => {
    const observed = new Set<ServiceWorker>();
    let finished = false;
    const timer = window.setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
    function finish(ready: boolean) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      registration.removeEventListener("updatefound", inspect);
      for (const worker of observed) worker.removeEventListener("statechange", inspect);
      resolve(ready);
    }
    function inspect() {
      if (!isExactRegistration(registration)) { finish(false); return; }
      for (const worker of workers(registration)) {
        if (!observed.has(worker)) {
          observed.add(worker);
          worker.addEventListener("statechange", inspect);
        }
      }
      // An activated old worker is not sufficient while its replacement is pending.
      if (!registration.installing && !registration.waiting && registration.active?.state === "activated") finish(true);
    }
    registration.addEventListener("updatefound", inspect);
    inspect();
  });
}

function acknowledgeTombstone(registration: ServiceWorkerRegistration, deadline: number): Promise<ServiceWorker | undefined> {
  const active = registration.active;
  if (Date.now() >= deadline || !active || active.state !== "activated" || !isExactRegistration(registration)) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let finished = false;
    const timer = window.setTimeout(() => finish(undefined), Math.max(0, deadline - Date.now()));
    function finish(worker: ServiceWorker | undefined) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      channel.port1.removeEventListener("message", response);
      channel.port1.removeEventListener("messageerror", failed);
      channel.port1.close(); channel.port2.close();
      resolve(worker);
    }
    function failed() { finish(undefined); }
    function response(event: MessageEvent<unknown>) {
      const data = event.data;
      const ready = typeof data === "object" && data !== null && !Array.isArray(data) &&
        Object.keys(data).length === 2 && "protocol" in data && data.protocol === RETIREMENT_PROTOCOL &&
        "type" in data && data.type === "ready";
      finish(ready && registration.active === active && active?.state === "activated" &&
        !registration.installing && !registration.waiting && isExactRegistration(registration) ? active : undefined);
    }
    channel.port1.addEventListener("message", response);
    channel.port1.addEventListener("messageerror", failed);
    channel.port1.start();
    try { active.postMessage({ protocol: RETIREMENT_PROTOCOL, type: "probe" }, [channel.port2]); }
    catch { finish(undefined); }
  });
}

/** ADR-0017 §2: retire only the known root /sw.js; never register a worker. */
export async function ensureLegacyWorkerRetired(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator)) return true;
    const serviceWorkers = navigator.serviceWorker;
    const deadline = Date.now() + RETIREMENT_TIMEOUT_MS;
    if (serviceWorkers.controller && !isLegacyWorker(serviceWorkers.controller)) return false;
    const registrations = await bounded(() => serviceWorkers.getRegistrations(), deadline);
    // A mixed or unidentified root registration is not ours to mutate.
    if (registrations.some(registration => hasLegacyWorker(registration) && !isExactRegistration(registration))) return false;
    const legacy = registrations.filter(isExactRegistration);
    for (const registration of legacy) {
      await bounded(() => {
        if (!isExactRegistration(registration)) throw new Error("Worker registration identity changed");
        return registration.update();
      }, deadline);
      if (!await waitForActivation(registration, deadline) || !isExactRegistration(registration)) return false;
      const tombstone = await acknowledgeTombstone(registration, deadline);
      if (!tombstone || registration.active !== tombstone || !isExactRegistration(registration)) return false;
      await bounded(() => {
        if (registration.active !== tombstone || tombstone.state !== "activated" ||
            registration.installing || registration.waiting || !isExactRegistration(registration)) {
          throw new Error("Acknowledged tombstone is no longer active");
        }
        return registration.unregister();
      }, deadline);
    }
    // No cleanup mutation on a fresh page or for an unrelated registration.
    if (legacy.length > 0) await bounded(() => caches.delete(LEGACY_CACHE), deadline);
    const remaining = await bounded(() => serviceWorkers.getRegistrations(), deadline);
    if (remaining.some(hasLegacyWorker)) return false;
    if ((await bounded(() => caches.keys(), deadline)).includes(LEGACY_CACHE)) return false;
    const controller = serviceWorkers.controller;
    if (controller === null) return true;
    if (!isLegacyWorker(controller)) return false;
    // Unregistering cannot release an already controlled document. One native
    // navigation is allowed; the marker survives interruption and reload.
    if (window.sessionStorage.getItem(RELOAD_MARKER) !== null) return false;
    window.sessionStorage.setItem(RELOAD_MARKER, "1");
    if (window.sessionStorage.getItem(RELOAD_MARKER) !== "1") return false;
    window.location.reload();
    return false;
  } catch {
    // Denied storage, update failures and incomplete readback keep the guard inert.
    return false;
  }
}
