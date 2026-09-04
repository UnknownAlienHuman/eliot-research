import { AccessVerificationError, type AccessVerifier } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
} from "@eliotr/cloudflare-ai";
import { createApplication } from "./composition-root.js";
import type { Env } from "./env.js";
import { handleHttp } from "./http.js";
import {
  PROJECTION_EXECUTION_PROFILE,
  projectionManagedGenerationIsActive,
} from "./projection-execution-handler.js";
import worker from "./index.js";

interface DatabaseFixture {
  readonly database: D1Database;
  readonly statements: string[];
}

function databaseFixture(input: {
  readonly projects?: readonly Record<string, unknown>[];
  readonly sources?: readonly Record<string, unknown>[];
  readonly schemaGeneration?: string;
} = {}): DatabaseFixture {
  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind() { return statement; },
        async first<T>() {
          if (sql.includes("schema_state")) {
            return {
              value: input.schemaGeneration ?? "core-v8-erasure-closure",
            } as T;
          }
          if (sql.includes("COUNT(*) AS pending_count")) return { pending_count: 0 } as T;
          return null;
        },
        async all<T>() {
          const results = sql.includes("FROM project")
            ? input.projects ?? []
            : sql.includes("FROM source s")
              ? input.sources ?? []
              : [];
          return { success: true, results: [...results] as T[] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { database, statements };
}

function environment(
  core: D1Database,
  search: D1Database = databaseFixture({
    schemaGeneration: "search-v4-ai-search-generation-registry",
  }).database,
): Env {
  return {
    CORE_DB: core,
    SEARCH_DB: search,
    ASSETS: { fetch: async () => new Response("asset") },
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "test-generation",
    AI_GATEWAY_REASONING_URL: "https://example.invalid/reasoning",
    AI_GATEWAY_RETRIEVAL_URL: "https://example.invalid/retrieval",
  } as unknown as Env;
}

function executionContext(): ExecutionContext {
  return {} as ExecutionContext;
}

function verifier(method: "cloudflare_access" | "service_token"): AccessVerifier {
  return {
    async verify() {
      return {
        principal_ref: method === "service_token" ? "service-agent" : "owner-subject",
        credential_generation: "credential-v1",
        authentication_method: method,
        expires_at: "2030-01-01T00:00:00.000Z",
      };
    },
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("worker export", () => {
  it("exposes fetch, queue and scheduled handlers", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.queue).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });
});

describe("HTTP authority boundary", () => {
  it("keeps public health minimal and independent of Access configuration", async () => {
    const fixture = databaseFixture();
    const response = await handleHttp(
      new Request("https://research.example/healthz"),
      environment(fixture.database),
      executionContext(),
    );
    expect(response.status).toBe(200);
    const document = await body(response);
    expect(document.ready).toBe(true);
    expect(document).not.toHaveProperty("blocking_reason_codes");
  });

  it("rejects missing protected-route authentication", async () => {
    const fixture = databaseFixture();
    const missing: AccessVerifier = {
      async verify(): Promise<never> {
        throw new AccessVerificationError("ACCESS_JWT_MISSING", "missing");
      },
    };
    const response = await handleHttp(
      new Request("https://research.example/api/v1/system/health"),
      environment(fixture.database),
      executionContext(),
      { accessVerifier: missing },
    );
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ code: "ACCESS_JWT_MISSING" });
  });

  it("does not let a service principal use the owner-only catalog", async () => {
    const fixture = databaseFixture();
    const response = await handleHttp(
      new Request("https://research.example/api/v1/research/catalog"),
      environment(fixture.database),
      executionContext(),
      { accessVerifier: verifier("service_token") },
    );
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ code: "PRINCIPAL_CLASS_DENIED" });
  });

  it("blocks protected application routes on a stale Core schema generation", async () => {
    const fixture = databaseFixture({ schemaGeneration: "core-v5-ingest-admission" });
    const health = await handleHttp(
      new Request("https://research.example/api/v1/system/health"),
      environment(fixture.database),
      executionContext(),
      { accessVerifier: verifier("cloudflare_access") },
    );
    expect(health.status).toBe(200);
    const healthDocument = await body(health);
    const healthData = healthDocument.data as Record<string, unknown>;
    expect(healthData.ready).toBe(false);
    expect(healthData.blocking_reason_codes).toEqual([
      "CORE_SCHEMA_GENERATION_MISMATCH",
    ]);

    const catalog = await handleHttp(
      new Request("https://research.example/api/v1/research/catalog"),
      environment(fixture.database),
      executionContext(),
      { accessVerifier: verifier("cloudflare_access") },
    );
    expect(catalog.status).toBe(503);
    expect(await body(catalog)).toMatchObject({ code: "SCHEMA_NOT_READY" });
  });

  it("returns a bounded D1 catalog and only queries authoritative LIVE heads", async () => {
    const fixture = databaseFixture({
      projects: [
        { id: "project-a", title: "Project A", generation: 1 },
        { id: "project-b", title: "Project B", generation: 2 },
      ],
      sources: [
        { id: "source-a", title: "Source A", head_rev: "revision-a" },
        { id: "source-b", title: "Source B", head_rev: "revision-b" },
      ],
    });
    const response = await handleHttp(
      new Request("https://research.example/api/v1/research/catalog?limit=1"),
      environment(fixture.database),
      executionContext(),
      { accessVerifier: verifier("cloudflare_access") },
    );
    expect(response.status).toBe(200);
    const document = await body(response);
    const data = document.data as Record<string, unknown>;
    expect(data.projects).toEqual([
      { id: "project-a", title: "Project A", generation: "1" },
    ]);
    expect(data.sources).toEqual([{
      id: "source-a",
      title: "Source A",
      readiness_ref: "readiness:source-a:revision-a",
    }]);
    expect(data.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const sourceSql = fixture.statements.find(
      (statement) => statement.includes("FROM source s"),
    );
    expect(sourceSql).toContain("r.source_revision_ref = s.head_rev");
    expect(sourceSql).toContain("r.purge_state = 'LIVE'");
  });

  it("rejects a catalog cursor reused under another project scope", async () => {
    const fixture = databaseFixture({
      projects: [
        { id: "project-a", title: "Project A", generation: 1 },
        { id: "project-b", title: "Project B", generation: 2 },
      ],
    });
    const first = await handleHttp(
      new Request(
        "https://research.example/api/v1/research/catalog?project_id=project-a&limit=1",
      ),
      environment(fixture.database),
      executionContext(),
      { accessVerifier: verifier("cloudflare_access") },
    );
    const firstDocument = await body(first);
    const cursor = (firstDocument.data as Record<string, unknown>).next_cursor;
    expect(typeof cursor).toBe("string");
    const second = await handleHttp(
      new Request(
        `https://research.example/api/v1/research/catalog?project_id=project-b&limit=1&cursor=${String(cursor)}`,
      ),
      environment(fixture.database),
      executionContext(),
      { accessVerifier: verifier("cloudflare_access") },
    );
    expect(second.status).toBe(400);
    expect(await body(second)).toMatchObject({
      code: "CATALOG_CURSOR_SCOPE_MISMATCH",
    });
  });

  it("returns typed 404 and 405 responses instead of falling through to static assets", async () => {
    const fixture = databaseFixture();
    const missing = await handleHttp(
      new Request("https://research.example/api/v1/unknown"),
      environment(fixture.database),
      executionContext(),
    );
    expect(missing.status).toBe(404);
    const wrongMethod = await handleHttp(
      new Request("https://research.example/api/v1/system/health", {
        method: "POST",
      }),
      environment(fixture.database),
      executionContext(),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });
});


describe("managed projection generation authority", () => {
  it("targets the primary g2 instance but keeps it shadow by default", () => {
    expect(PROJECTION_EXECUTION_PROFILE).toMatchObject({
      managed_instance_id: "private-prose-g2",
      managed_generation: AI_SEARCH_PRIMARY_GENERATION,
      managed_generation_active: false,
    });
  });

  it("requires the exact ACTIVE registry record before semantic readiness", () => {
    expect(projectionManagedGenerationIsActive(null)).toBe(false);
    expect(projectionManagedGenerationIsActive({
      artifact: {
        registry: {
          active_head_generation: "another-generation",
          generations: [],
        },
      },
    } as never)).toBe(false);
    expect(projectionManagedGenerationIsActive({
      artifact: {
        registry: {
          active_head_generation: AI_SEARCH_PRIMARY_GENERATION,
          generations: [{
            generation: AI_SEARCH_PRIMARY_GENERATION,
            state: "ACTIVE",
            profile: AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
          }],
        },
      },
    } as never)).toBe(true);
  });

  it("rejects an active-head record with a different immutable profile", () => {
    expect(() => projectionManagedGenerationIsActive({
      artifact: {
        registry: {
          active_head_generation: AI_SEARCH_PRIMARY_GENERATION,
          generations: [{
            generation: AI_SEARCH_PRIMARY_GENERATION,
            state: "ACTIVE",
            profile: {
              ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
              embedding_model: "@cf/incompatible/model",
            },
          }],
        },
      },
    } as never)).toThrow(/immutable desired profile/u);
  });
});

describe("federation application contract", () => {
  it("exposes the complete V1 surface and keeps every operation fail-closed", async () => {
    const fixture = databaseFixture();
    const application = createApplication({
      env: environment(fixture.database),
      executionContext: executionContext(),
    });

    expect(Object.keys(application.services.federation).sort()).toEqual([
      "cancel",
      "changes",
      "readBundle",
      "readBundleManifest",
      "result",
      "status",
      "submit",
    ]);
    await expect(
      application.services.federation.readBundle(
        {} as never,
        { id: "bundle-1", revision: 1 },
      ),
    ).rejects.toMatchObject({
      code: "IMPLEMENTATION_SLICE_PENDING",
      operation: "federation.bundle.read",
      retryable: false,
    });
    const capabilities = await application.services.owner.systemCapabilities(
      {} as never,
    );
    expect(capabilities.disabled_slices).toEqual(
      expect.arrayContaining(["FEDERATION"]),
    );
  });
});
