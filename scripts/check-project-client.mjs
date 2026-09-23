#!/usr/bin/env node
// Independent wire client: one real scoped read, never owner cookies or model effects.
import { createHash } from "node:crypto";
import { URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";

const usage = `Usage: node scripts/check-project-client.mjs --confirm-live --origin https://APP_HOST --project PROJECT_ID --grant GRANT_ID --generation DEPLOYMENT_GENERATION
Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the service client's private environment.
Only the explicit HTTPS origin receives these credentials; redirects are refused. No credentials,
source text, project titles or response bodies are printed or saved. Success confirms one past
catalog read, not continuing access, model availability or full-project coverage.`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_BYTES = 32 * 1024;
class CheckError extends Error {}
const fail = (message) => { throw new CheckError(message); };
function bounded(value, maximum, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} is invalid`);
  return value;
}
function identifier(value, label) {
  const text = bounded(value, 256, label);
  if (!ID.test(text)) fail(`${label} is invalid`);
  return text;
}
function record(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail("Response contract mismatch");
  return value;
}
function argumentsOf(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!["--confirm-live", "--origin", "--project", "--grant", "--generation"].includes(flag) || values.has(flag)) {
      fail("Unknown or duplicate option; use --help");
    }
    if (flag === "--confirm-live") values.set(flag, true);
    else {
      const value = args[++index];
      if (typeof value !== "string" || value.startsWith("--")) fail("An option value is missing; use --help");
      values.set(flag, value);
    }
  }
  if (values.get("--confirm-live") !== true) fail("No request sent. Explicit --confirm-live is required; use --help");
  let origin;
  try { origin = new URL(values.get("--origin")); } catch { fail("An explicit HTTPS origin is required"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== "/" || origin.origin !== values.get("--origin")) fail("Use a canonical HTTPS origin without a path, credentials or trailing slash");
  return { origin: origin.origin, project: identifier(values.get("--project"), "Project ID"),
    grant: identifier(values.get("--grant"), "Grant ID"), generation: identifier(values.get("--generation"), "Deployment generation") };
}
async function bodyBytes(response) {
  const sizeHeader = response.headers.get("content-length");
  if (sizeHeader !== null && (!/^[0-9]+$/u.test(sizeHeader) || Number(sizeHeader) > MAX_BYTES)) {
    await response.body?.cancel(); fail("Response exceeds the byte budget");
  }
  if (!response.body) fail("Response body is missing");
  const reader = response.body.getReader(); const chunks = []; let bytes = 0; let count = 0; let complete = false;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (++count > 4096 || bytes > MAX_BYTES) fail("Response exceeds the byte budget");
      chunks.push(next.value);
    }
    complete = true; return Buffer.concat(chunks, bytes);
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* Preserve the original bounded error. */ } }
    reader.releaseLock();
  }
}
function decodeCatalog(raw, config) {
  const outer = record(raw, ["data", "trace_id", "deployment_generation"]);
  const trace = bounded(outer.trace_id, 128, "Trace ID"); if (!TRACE.test(trace)) fail("Invalid trace ID");
  if (identifier(outer.deployment_generation, "Deployment generation") !== config.generation) fail("Deployment differs from the explicitly selected generation");
  const data = record(outer.data, ["projects", "sources"], ["next_cursor"]);
  if (!Array.isArray(data.projects) || data.projects.length > 1 || !Array.isArray(data.sources) || data.sources.length > 1) fail("Response exceeded the requested page size");
  for (const project of data.projects) {
    record(project, ["id", "title", "generation"]);
    if (identifier(project.id, "Project ID") !== config.project) fail("Response contains a different project");
    identifier(project.generation, "Project generation"); bounded(project.title, 4096, "Project title");
  }
  for (const source of data.sources) {
    record(source, ["id", "title", "readiness_ref"]);
    const sourceId = identifier(source.id, "Source ID"); bounded(source.title, 4096, "Source title");
    const readiness = bounded(source.readiness_ref, 1024, "Readiness locator");
    const prefix = `readiness:${sourceId}:`;
    if (!readiness.startsWith(prefix)) fail("Readiness identity mismatch");
    identifier(readiness.slice(prefix.length), "Source revision");
  }
  if (data.next_cursor !== undefined && (typeof data.next_cursor !== "string" ||
      !/^[A-Za-z0-9_-]{1,2048}$/u.test(data.next_cursor) || (!data.projects.length && !data.sources.length))) fail("Invalid catalog continuation");
  if (data.projects.length !== 1 || data.sources.length !== 1) {
    fail("Read is inconclusive: no readable project/source witness was returned. Add an authorized source or review policy; no verification claimed");
  }
  return trace;
}
async function run() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) { console.log(usage); return; }
  const config = argumentsOf(args);
  const clientId = bounded(process.env.CF_ACCESS_CLIENT_ID, 256, "CF_ACCESS_CLIENT_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u.test(clientId)) fail("CF_ACCESS_CLIENT_ID is invalid");
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (typeof secret !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(secret)) fail("CF_ACCESS_CLIENT_SECRET is missing or invalid");
  const url = new URL("/api/v1/research/catalog", config.origin);
  url.search = new URLSearchParams({ project_id: config.project, limit: "1" }).toString();
  const response = await fetch(url, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
    signal: globalThis.AbortSignal.timeout(30_000), headers: { accept: "application/json", "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": secret, "X-Eliotr-Client-Grant": config.grant } });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel(); fail("Access redirected the request; service identity was not confirmed");
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    await response.body?.cancel(); fail("Expected an authenticated JSON API response");
  }
  const bytes = await bodyBytes(response);
  let raw;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("Invalid JSON response"); }
  if (response.status !== 200) {
    // Never echo provider error bodies: they may contain reflected credentials or private data.
    fail(`Catalog read was not confirmed (HTTP ${response.status}). Check Access policy, current grant and source permissions`);
  }
  const trace = decodeCatalog(raw, config);
  console.log(JSON.stringify({ check: "project-service-catalog", status: "AUTHORIZED_CATALOG_READ",
    project_id: config.project, requested_grant_id: config.grant, deployment_generation: config.generation,
    trace_id: trace, client_checked_at: new Date().toISOString(), response_sha256: createHash("sha256").update(bytes).digest("hex"),
    scope: "ONE_BOUNDED_PAGE", current_presence: "NOT_ASSERTED" }, null, 2));
}
await run().catch((error) => {
  console.error(error instanceof CheckError ? error.message : "Client read interrupted or unavailable; no verification claimed");
  process.exitCode = 1;
});
