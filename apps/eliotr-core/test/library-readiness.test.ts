import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { LibraryReadinessSchema } from "@eliotr/contracts";
import { handleHttp } from "../src/http.js";
import { readLibraryReadiness } from "../src/library-readiness.js";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;
let world: Q1Namespace;

beforeEach(async () => {
  const owner = `readiness-owner-${crypto.randomUUID()}`;
  world = { db, searchDb, runtime, owner, ...(await prepareQ1Namespace(runtime, db, searchDb, owner)) };
  await importAndProject(world);
});

function context(): Parameters<typeof readLibraryReadiness>[2] {
  return {
    request: new Request("https://research.example/api/v1/library/readiness"),
    principal_ref: world.owner,
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    trace_id: "readiness-test",
  };
}

function sourceId(): string {
  return `source-${world.namespace}`;
}

describe("owner active Library readiness", () => {
  it("reports independently verified exact and lexical channels through HTTP", async () => {
    const response = await handleHttp(
      new Request(`https://research.example/api/v1/library/readiness?source_id=${encodeURIComponent(sourceId())}`),
      runtime,
      {} as ExecutionContext,
      { accessVerifier: { async verify() {
        return { principal_ref: world.owner, credential_generation: "credential-1", authentication_method: "cloudflare_access", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      } } },
    );
    expect(response.status).toBe(200);
    const envelope = await response.json() as { readonly data?: unknown };
    const readiness = LibraryReadinessSchema.parse(envelope.data);
    expect(readiness.source_revision_ref).toBe(world.revision);
    expect(readiness.channels.map((channel) => [channel.channel, channel.state])).toEqual([
      ["exact_ready", "ready"], ["lexical_ready", "ready"], ["semantic_ready", "degraded"],
    ]);
    expect(readiness.readiness_basis).toBe("ACTIVE_VERIFIED");
    expect(readiness.currentness.source_revision_ref).toBe(world.revision);
  });

  it("keeps exact readiness when lexical projection is absent", async () => {
    await searchDb.prepare(
      "DELETE FROM projection_watermark WHERE channel='lexical' AND source_revision_ref=?1",
    ).bind(world.revision).run();
    const readiness = await readLibraryReadiness(
      db,
      searchDb,
      context(),
      { source_id: sourceId() },
      runtime.DEPLOYMENT_GENERATION,
    );
    expect(readiness.channels.find((channel) => channel.channel === "exact_ready")?.state).toBe("ready");
    expect(readiness.channels.find((channel) => channel.channel === "lexical_ready")?.state).toBe("not_requested");
  });

  it("fails closed when the current owner authority is fenced", async () => {
    await db.prepare(
      "UPDATE source_namespace_ownership SET status='FENCED' WHERE source_namespace_id=?1",
    ).bind(world.namespace).run();
    await expect(readLibraryReadiness(
      db,
      searchDb,
      context(),
      { source_id: sourceId() },
      runtime.DEPLOYMENT_GENERATION,
    )).rejects.toMatchObject({ status: 404, code: "LIBRARY_SOURCE_NOT_FOUND" });
  });
});
