// ADR-0017: permanent inert tombstone for the historical root registration.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.delete("eliotr-shell-v1"));
});
self.addEventListener("message", (event) => {
  const data = event.data;
  if (self.registration.active?.state !== "activated" || event.ports.length !== 1 ||
      typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).length !== 2 ||
      data.protocol !== "eliotr.legacy-worker-retirement.v1" || data.type !== "probe") return;
  event.ports[0].postMessage({ protocol: "eliotr.legacy-worker-retirement.v1", type: "ready" });
});
