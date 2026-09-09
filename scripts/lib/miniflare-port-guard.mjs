import { createServer } from "node:net";

/**
 * WHATWG Fetch port-blocking values that can be selected by a local Workers
 * runtime. Windows hosts with customized low dynamic TCP ranges may assign
 * these ports to a local Workers runtime.
 */
export const FETCH_FORBIDDEN_PORTS = Object.freeze([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1"]);

function noopRelease() {
  return Promise.resolve();
}

function closeServer(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

function listenReservedPort(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      server.unref();
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, ipv6Only: host === "::1", exclusive: true });
  });
}

function validateInputs(ports, hosts) {
  if (!Array.isArray(ports) || ports.length > FETCH_FORBIDDEN_PORTS.length) {
    throw new TypeError("port guard requires a bounded port list");
  }
  if (!Array.isArray(hosts) || hosts.some((host) => !LOOPBACK_HOSTS.includes(host))) {
    throw new TypeError("port guard accepts only loopback hosts");
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError("port guard requires valid TCP port numbers");
    }
  }
}

/**
 * Reserve the Fetch-forbidden loopback ports for the lifetime of a test
 * project. There is one bounded bind attempt per port/host: EADDRINUSE means
 * another process owns that endpoint and is preserved; every other error is
 * fatal after releasing reservations already made by this call.
 */
export async function reserveMiniflareForbiddenPorts({
  platform = process.platform,
  ports = FETCH_FORBIDDEN_PORTS,
  hosts = LOOPBACK_HOSTS,
} = {}) {
  validateInputs(ports, hosts);
  if (platform !== "win32") return { active: false, reservations: [], skipped: [], release: noopRelease };

  const reservations = [];
  const skipped = [];
  const release = async () => {
    const current = reservations.splice(0);
    const results = await Promise.allSettled(current.map(closeServer));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  };

  try {
    for (const port of ports) {
      for (const host of hosts) {
        try {
          const server = await listenReservedPort(port, host);
          reservations.push(server);
        } catch (error) {
          if (error?.code === "EADDRINUSE") {
            skipped.push({ host, port, reason: "EADDRINUSE" });
            continue;
          }
          throw new Error(`failed to reserve Fetch-forbidden loopback port ${host}:${port}`, { cause: error });
        }
      }
    }
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }

  return {
    active: true,
    reservations: reservations.map((server) => {
      const address = server.address();
      return typeof address === "object" && address !== null ? { host: address.address, port: address.port } : null;
    }).filter((value) => value !== null),
    skipped,
    release,
  };
}

export default async function setupMiniflarePortGuard() {
  const guard = await reserveMiniflareForbiddenPorts();
  return guard.release;
}
