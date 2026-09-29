/** Server configuration only. Client-supplied names never select an authenticated actor. */
export interface McpServiceClient {
  readonly client_id: string;
  readonly legacy: boolean;
}

// Match the existing Access principal-list bound; this is not a vendor allow-list.
const MAX_CLIENTS = 64;
const MAX_CONFIG_CHARS = 32 * 1024;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u;

export class McpServiceClientConfigurationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpServiceClientConfigurationError";
  }
}

function clientId(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !CLIENT_ID.test(value)) {
    throw new McpServiceClientConfigurationError("MCP service clients must use exact Access Client IDs");
  }
  return value;
}

/** Accept a JSON array binding or its JSON string form; never accept a token secret. */
export function readMcpServiceClients(legacy: unknown, additional: unknown): readonly McpServiceClient[] {
  const clients: McpServiceClient[] = [];
  if (legacy !== undefined) clients.push({ client_id: clientId(legacy), legacy: true });
  let decoded: unknown = additional;
  if (typeof additional === "string") {
    if (additional.length > MAX_CONFIG_CHARS) {
      throw new McpServiceClientConfigurationError("MCP service client configuration is too large");
    }
    try { decoded = JSON.parse(additional) as unknown; }
    catch (cause) { throw new McpServiceClientConfigurationError("MCP service clients must be a JSON array", cause); }
  }
  if (decoded !== undefined) {
    if (!Array.isArray(decoded) || decoded.length + clients.length > MAX_CLIENTS) {
      throw new McpServiceClientConfigurationError("MCP service clients must be an array of at most 64 Client IDs");
    }
    for (const value of decoded) clients.push({ client_id: clientId(value), legacy: false });
  }
  if (new Set(clients.map((client) => client.client_id)).size !== clients.length) {
    throw new McpServiceClientConfigurationError("MCP service Client IDs must be unique, including the legacy client");
  }
  // Snapshot and sort so caller mutation or configuration ordering cannot affect the verifier cache.
  clients.sort((left, right) => left.client_id < right.client_id ? -1 : left.client_id > right.client_id ? 1 : 0);
  return Object.freeze(clients.map((client) => Object.freeze(client)));
}
