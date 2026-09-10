import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { reserveMiniflareForbiddenPorts } from "./lib/miniflare-port-guard.mjs";

function listen(host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.removeAllListeners("error");
      resolve(server);
    });
  });
}

async function close(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("non-Windows profiles do not bind or claim ports", async () => {
  const guard = await reserveMiniflareForbiddenPorts({ platform: "linux", ports: [6000], hosts: ["127.0.0.1"] });
  assert.equal(guard.active, false);
  assert.deepEqual(guard.reservations, []);
  await guard.release();
});

test("Windows guard holds a free loopback port and releases only its socket", async () => {
  const probe = await listen();
  const port = probe.address().port;
  await close(probe);
  const guard = await reserveMiniflareForbiddenPorts({ platform: "win32", ports: [port], hosts: ["127.0.0.1"] });
  assert.deepEqual(guard.reservations, [{ host: "127.0.0.1", port }]);
  await assert.rejects(listen("127.0.0.1", port), (error) => error?.code === "EADDRINUSE");
  await guard.release();
  const after = await listen("127.0.0.1", port);
  await close(after);
});

test("EADDRINUSE preserves an existing owner and is not retried", async () => {
  const owner = await listen();
  const port = owner.address().port;
  const guard = await reserveMiniflareForbiddenPorts({ platform: "win32", ports: [port], hosts: ["127.0.0.1"] });
  assert.deepEqual(guard.reservations, []);
  assert.deepEqual(guard.skipped, [{ host: "127.0.0.1", port, reason: "EADDRINUSE" }]);
  assert.equal(owner.listening, true);
  await guard.release();
  await close(owner);
});
