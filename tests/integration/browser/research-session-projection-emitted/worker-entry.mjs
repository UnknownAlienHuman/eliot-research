import emittedWorker, {
  ResearchSession as EmittedResearchSession,
  ResearchWorkflow as EmittedResearchWorkflow,
} from "./index.js";

const qualification = __ELIOT_PROJECTION_QUALIFICATION__;
let activeBinding;
const workflowCounts = { get: 0, create: 0 };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeValue(value) {
  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return { $bytes: btoa(binary) };
  }
  if (value instanceof ArrayBuffer) return safeValue(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(safeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, safeValue(value[key])]));
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export class ResearchSession extends EmittedResearchSession {
  constructor(ctx, env) {
    super(ctx, localWorkflowOnly(env));
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/__qualification/storage") {
      const storage = this.ctx.storage;
      const tables = storage.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).toArray()
        .map((row) => row.name)
        .filter((name) => /chat|message|transcript/iu.test(name) || name.toLowerCase() === "cf_agents_state");
      const tableRows = tables.map((name) => ({
        name,
        rows: storage.sql.exec(`SELECT * FROM ${quoteIdentifier(name)}`).toArray().map(safeValue),
      }));
      const allEntries = Array.from(await storage.list()).sort(([left], [right]) => left.localeCompare(right));
      const connectionMetadata = allEntries
        .filter(([key]) => key === "research-session-chat-binding:v1")
        .map(([key, value]) => [key, safeValue(value)]);
      const sessionEntries = allEntries
        .filter(([key]) => key.startsWith("session:"))
        .map(([key, value]) => [key, safeValue(value)]);
      const transcriptEntries = allEntries
        .filter(([key]) => /chat|message|transcript/iu.test(key) && key !== "research-session-chat-binding:v1")
        .map(([key, value]) => [key, safeValue(value)]);
      return json({
        transcript_tables: tableRows,
        transcript_entries: transcriptEntries,
        session_entries: sessionEntries,
        connection_metadata: connectionMetadata,
      });
    }
    return super.fetch(request);
  }
}

export { EmittedResearchWorkflow as ResearchWorkflow };

function accessTokenFromCookie(headers) {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === "CF_Authorization") return part.slice(separator + 1).trim();
  }
  return undefined;
}

function localWorkflowOnly(env) {
  const workflow = env.RESEARCH_WORKFLOW;
  const replacement = new Proxy(workflow, {
    get(target, property) {
      if (property === "get") return async (id) => {
        workflowCounts.get += 1;
        return { id, status: async () => ({ status: "waiting" }) };
      };
      if (property === "create") return async () => {
        workflowCounts.create += 1;
        throw new Error("provider/workflow execution is disabled in this qualification harness");
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, property, receiver) {
      return property === "RESEARCH_WORKFLOW" ? replacement : Reflect.get(target, property, receiver);
    },
  });
}

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/api/__qualification/config" && request.method === "POST") {
      if (request.headers.get("x-qualification-key") !== qualification.diagnostic_key) return new Response(null, { status: 404 });
      const candidate = await request.json();
      if (candidate === null || typeof candidate !== "object" ||
          Object.keys(candidate).sort().join(",") !== "agent,authority_expires_at,credential_generation,deployment_generation,handler_generation,investigation_ref,name,operation_id,principal_ref,session_id,timeoutMs") {
        return json({ code: "QUALIFICATION_BINDING_INVALID" }, 400);
      }
      activeBinding = candidate;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/__qualification" || url.pathname === "/api/__qualification/") {
      if (activeBinding === undefined) return json({ code: "QUALIFICATION_NOT_READY" }, 409);
      const binding = JSON.stringify(activeBinding).replaceAll("<", "\\u003c");
      const html = qualification.html.replace("</head>", `<script>window.__ELIOT_PROJECTION_BINDING__=${binding};</script></head>`);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/__qualification/entry.js") {
      return new Response(qualification.browser_bundle, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/__qualification/state" || url.pathname === "/api/__qualification/counters") {
      if (request.headers.get("x-qualification-key") !== qualification.diagnostic_key) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("/counters")) return json({ ...workflowCounts });
      if (activeBinding === undefined) return json({ code: "QUALIFICATION_NOT_READY" }, 409);
      const stub = env.RESEARCH_SESSION.get(env.RESEARCH_SESSION.idFromName(activeBinding.operation_id));
      const response = await stub.fetch(new Request("https://qualification.invalid/__qualification/storage"));
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const headers = new Headers(request.headers);
    const cookieToken = accessTokenFromCookie(headers);
    if (cookieToken !== undefined) headers.set("cf-access-jwt-assertion", cookieToken);
    const forwarded = new Request(request, { headers });
    return emittedWorker.fetch(forwarded, localWorkflowOnly(env), executionContext);
  },
};
