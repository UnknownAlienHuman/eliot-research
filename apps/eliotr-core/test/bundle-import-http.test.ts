import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalDigest, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { bundleFixture } from "../../../packages/platform-cloudflare/src/ingest-test-fixture.js";
import { prepareBrowserBundle } from "../../eliotr-pwa/src/bundle-input.js";
import { createBrowserBundleImport, importBrowserBundle } from "../../eliotr-pwa/src/bundle-import.js";
import { type ImportTransport } from "../../eliotr-pwa/src/bundle-import-api.js";
import { decodeApiProblem } from "../../eliotr-pwa/src/api.js";
import { handleHttp } from "../src/http.js";
import { type Env } from "../src/env.js";

interface Migration { name: string; queries: string[]; }
const runtime = env as unknown as Env & { CORE_MIGRATIONS: Migration[]; SEARCH_MIGRATIONS: Migration[] };
const db = runtime.CORE_DB; const owner = "pwa-import-owner";
let namespace = ""; let revision = "";
const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");
let initial: Record<string, number>;
async function delta(table: string): Promise<number> {
  const after = await count(table); const before = initial[table];
  if (after === null || before === undefined) throw new Error("Missing count fixture"); return after - before;
}

async function setup(allowed = owner) {
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) VALUES (?1,1,?2,?3,?4,1,'ACTIVE',?5)")
    .bind(namespace, "fixture-owner", "incarnation-1", "owner-generation-1", now).run();
  await db.prepare("INSERT INTO source_admission_policy VALUES (?1,1,?2,?3,'document','QUALIFIED','DATA_ONLY','READ_ONLY',?4,?5,?6,?7,?8,?9,'standard',?10)")
    .bind(namespace, JSON.stringify([allowed]), '["immutable_import"]', '["research"]', "owner-only", "license-1",
      "NORMALIZED_CLOUD_ONLY", "residency-1", "retention-1", now).run();
}
const transport: ImportTransport = async (path, init) => {
  const request = new Request(`https://research.example${path}`, init);
  const response = await handleHttp(request, runtime, {} as ExecutionContext, { accessVerifier: { async verify() {
    return { principal_ref: owner, credential_generation: "credential-1", authentication_method: "cloudflare_access",
      expires_at: new Date(Date.now() + 3600000).toISOString() };
  } } });
  const value: unknown = await response.json();
  if (!response.ok) throw decodeApiProblem(value, response.status);
  return value;
};
async function input() {
  const fixture = await bundleFixture();
  const manifest = { ...fixture.manifest, origin: { ...fixture.manifest.origin,
    source_namespace_id: namespace, source_revision_ref: revision }, source: { ...fixture.manifest.source, logical_id: `source-${namespace}` } };
  const bytes = JSON.stringify(manifest);
  const content = fixture.files["content.md"];
  if (!content) throw new Error("Missing fixture content");
  return prepareBrowserBundle([
    { path: "content.md", blob: new Blob([new Uint8Array(content)]) },
    { path: "manifest.json", blob: new Blob([bytes]) },
    { path: "hashes.sha256", blob: new Blob([`${manifest.content.markdown_sha256}  content.md\n${await sha256Utf8(bytes)}  manifest.json\n`]) },
  ]);
}
beforeEach(async () => {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  const id = crypto.randomUUID(); namespace = `ns-${id}`; revision = `rev-${id}`;
  initial = Object.fromEntries(await Promise.all(["source_revision", "outbox", "scope_read_policy", "bundle_ingest_operation"]
    .map(async (table) => [table, (await count(table)) ?? 0] as const)));
});
describe("actual PWA import protocol through Worker/D1/R2", () => {
  it("prepares, uploads, admits, reads back and replays without creating read grants", async () => {
    await setup(); const bundle = await input();
    const receipt = await importBrowserBundle(bundle, "pwa-first-import", { transport });
    expect(receipt?.decision).toBe("ADMITTED");
    expect(receipt?.manifest_sha256).toBe(await canonicalDigest(bundle.manifest));
    expect(receipt?.manifest_sha256).not.toBe(bundle.hashes["manifest.json"]);
    expect(await delta("source_revision")).toBe(1);
    expect(await delta("outbox")).toBe(1);
    expect(await delta("scope_read_policy")).toBe(0);
    expect(await importBrowserBundle(bundle, "pwa-first-import", { transport })).toEqual(receipt);
    expect(await delta("bundle_ingest_operation")).toBe(1);
  });
  it("denies a non-authorized principal before storing an ingest operation", async () => {
    await setup("someone-else"); const bundle = await input();
    await expect(importBrowserBundle(bundle, "denied-import", { transport })).rejects.toMatchObject({ status: 403 });
    expect(await delta("bundle_ingest_operation")).toBe(0);
    expect(await delta("source_revision")).toBe(0);
  });
  it("does not resend a committed request when its HTTP acknowledgement is lost", async () => {
    await setup(); const bundle = await input(); let commits = 0;
    const lost: ImportTransport = async (path, init) => {
      const value = await transport(path, init);
      if (path.endsWith("/commit")) { ++commits; throw new Error("lost commit response"); } return value;
    };
    await expect(importBrowserBundle(bundle, "lost-commit", { transport: lost })).rejects.toThrow("lost commit response");
    expect(commits).toBe(1);
    expect(await delta("source_revision")).toBe(1);
    const receipt = await importBrowserBundle(bundle, "lost-commit", { transport });
    expect(receipt?.decision).toBe("ADMITTED");
    expect(await delta("source_revision")).toBe(1);
  });
  it("rejects shorter and longer multipart bodies without a completed source", async () => {
    await setup(); const bundle = await input();
    for (const offset of [-1, 1]) {
      const altered: ImportTransport = async (path, init) => {
        if (path.includes("/parts/")) {
          const url = new URL(path, "https://research.example");
          url.searchParams.set("size_bytes", String(Number(url.searchParams.get("size_bytes")) + offset));
          return transport(`${url.pathname}${url.search}`, init);
        }
        return transport(path, init);
      };
      await expect(importBrowserBundle(bundle, "wrong-size", { transport: altered })).rejects.toMatchObject({ code: "STAGING_PART_INVALID" });
    }
    expect(await delta("source_revision")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM bundle_ingest_operation WHERE source_namespace_id=?1 AND state='COMMITTED'")
      .bind(namespace).first("n")).toBe(0);
  });
  it("replays the original reservation but still rejects changed input and revoked policy", async () => {
    await setup(); const bundle = await input(); const key = "replay-fences";
    const receipt = await importBrowserBundle(bundle, key, { transport });
    const preparedRequest = { manifest: bundle.manifest, file_hashes: bundle.hashes, total_bytes: bundle.totalBytes, idempotency_key: key };
    await expect(transport("/api/v1/ingest/bundles/prepare", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...preparedRequest, total_bytes: bundle.totalBytes + 1 }) })).rejects.toMatchObject({ code: "INGEST_AUTHORITY_CONFLICT" });
    expect(await importBrowserBundle(bundle, key, { transport })).toEqual(receipt);
    await db.prepare("UPDATE source_admission_policy SET authorized_principal_refs_json='[\"someone-else\"]' WHERE source_namespace_id=?1")
      .bind(namespace).run();
    await expect(importBrowserBundle(bundle, key, { transport })).rejects.toMatchObject({ code: "INGEST_POLICY_DENIED" });
    expect(await delta("source_revision")).toBe(1);
  });

  it.each(["part-before", "part-after", "complete-before", "complete-after", "commit-before", "commit-after"])("continues %s failure against actual R2/D1 with one operation and one source revision", async (fault) => {
    await setup(); const bundle = await input(); let injected = false;
    const calls: string[] = []; const bodies: Blob[] = [];
    const broken: ImportTransport = async (path, init) => {
      calls.push(path);
      const kind = path.includes("/parts/") ? "part" : path.endsWith("/files/complete") ? "complete" :
        path.endsWith("/commit") ? "commit" : "other";
      if (kind === "part") bodies.push(init?.body as Blob);
      if (!injected && fault === `${kind}-before`) { injected = true; throw new Error("interrupted"); }
      const value = await transport(path, init);
      if (!injected && fault === `${kind}-after`) { injected = true; throw new Error("lost acknowledgement"); }
      return value;
    };
    const attempt = createBrowserBundleImport(bundle, `same-tab-${namespace}`);
    await expect(attempt.run({ transport: broken })).rejects.toThrow();
    expect(attempt.canResume).toBe(true);
    const before = calls.length;
    expect((await attempt.run({ transport: broken }))?.decision).toBe("ADMITTED");
    expect(calls[before]).toMatch(/^\/api\/v1\/ingest\/bundles\/ingest-/u);
    expect(calls.filter((path) => path.endsWith("/prepare"))).toHaveLength(1);
    expect(calls.filter((path) => path.includes("/parts/"))).toHaveLength(bundle.files.length + (fault.startsWith("part-") ? 1 : 0));
    if (fault.startsWith("part-")) expect(await bodies[0]?.text()).toBe(await bodies[1]?.text());
    expect(await delta("bundle_ingest_operation")).toBe(1);
    expect(await delta("source_revision")).toBe(1); expect(await delta("outbox")).toBe(1);
    expect(await delta("scope_read_policy")).toBe(0);
    attempt.dispose();
  });
  it("refuses continuation after admission policy revocation before any further R2 write", async () => {
    await setup(); const attempt = createBrowserBundleImport(await input(), "revoked-continuation");
    await expect(attempt.run({ transport: async (path, init) => {
      if (path.includes("/parts/")) throw new Error("interrupted"); return transport(path, init);
    } })).rejects.toThrow("interrupted");
    await db.prepare("UPDATE source_admission_policy SET authorized_principal_refs_json='[\"revoked-owner\"]' WHERE source_namespace_id=?1").bind(namespace).run();
    const calls: string[] = [];
    await expect(attempt.run({ transport: async (path, init) => { calls.push(path); return transport(path, init); } }))
      .rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1); expect(attempt.canResume).toBe(false);
    expect(await delta("source_revision")).toBe(0);
  });

  it("rolls back source/head/outbox when the policy changes immediately before the commit batch", async () => {
    await setup(); const bundle = await input(); let raced = false;
    const guardedDb = new Proxy(db, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const row = await db.prepare("SELECT state FROM bundle_ingest_operation WHERE source_namespace_id=?1").bind(namespace).first<{ state: string }>();
        if (!raced && row?.state === "AUTHORIZED") {
          raced = true;
          await db.prepare("UPDATE source_admission_policy SET license_policy_ref='changed-license' WHERE source_namespace_id=?1").bind(namespace).run();
        }
        return target.batch(statements);
      };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const racedTransport: ImportTransport = async (path, init) => {
      const response = await handleHttp(new Request(`https://research.example${path}`, init), { ...runtime, CORE_DB: guardedDb }, {} as ExecutionContext,
        { accessVerifier: { async verify() { return { principal_ref: owner, credential_generation: "credential-1",
          authentication_method: "cloudflare_access", expires_at: new Date(Date.now() + 3600000).toISOString() }; } } });
      const value: unknown = await response.json(); if (!response.ok) throw decodeApiProblem(value, response.status); return value;
    };
    await expect(importBrowserBundle(bundle, `commit-race-${namespace}`, { transport: racedTransport })).rejects.toThrow();
    expect(raced).toBe(true);
    expect(await delta("source_revision")).toBe(0); expect(await delta("outbox")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM source WHERE source_namespace_id=?1").bind(namespace).first("n")).toBe(0);
    expect(await db.prepare("SELECT state FROM bundle_ingest_operation WHERE source_namespace_id=?1").bind(namespace).first("state")).toBe("AUTHORIZED");
  });

});
