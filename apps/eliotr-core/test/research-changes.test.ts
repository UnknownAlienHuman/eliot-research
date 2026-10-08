import { beforeAll, describe, expect, it } from "vitest";
import type {
  AuthenticatedRequestContext,
  ResearchChangesRequest,
  ResearchChangesResult,
} from "@eliotr/interfaces";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { handleHttp } from "../src/http.js";
import {
  createResearchChangesService,
  recordResearchChange,
} from "../src/research-changes.js";
import type { Env } from "../src/env.js";
import {
  body,
  credential,
  db,
  insert,
  principal,
  runtime,
  setupOrientationDatabase,
  verifier,
} from "./orientation-fixture.js";

const TEST_CURSOR_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW_MS = Date.parse("2026-09-11T12:00:00.000Z");

beforeAll(async () => {
  await setupOrientationDatabase();
  await seedChange(1, "SOURCE_ADMITTED");
  await seedChange(2, "SOURCE_UPDATED");
  await seedChange(3, "SOURCE_UPDATED");
});

function context(
  key: string,
  input: {
    readonly who?: string;
    readonly credentialGeneration?: string;
  } = {},
): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/changes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
      },
    }),
    principal_ref: input.who ?? principal,
    client_class: "owner_pwa",
    credential_generation: input.credentialGeneration ?? credential,
    trace_id: `trace-${key}`,
  };
}

function service(input: {
  readonly deployment?: string;
  readonly now?: () => number;
  readonly key?: string;
} = {}) {
  return createResearchChangesService({
    CORE_DB: db,
    DEPLOYMENT_GENERATION: input.deployment ?? "test-generation",
    RESEARCH_CHANGES_CURSOR_KEY: input.key ?? TEST_CURSOR_KEY,
  }, {
    now: input.now ?? (() => NOW_MS),
  });
}

async function readChanges(
  raw: unknown,
  input: {
    readonly who?: string;
    readonly credentialGeneration?: string;
    readonly deployment?: string;
    readonly now?: () => number;
  } = {},
): Promise<ResearchChangesResult> {
  return service(input)(
    context("read", input),
    raw as ResearchChangesRequest,
  );
}

async function seedChange(index: number, kind: "SOURCE_ADMITTED" | "SOURCE_UPDATED") {
  return recordResearchChange(db, {
    change_ref: `manual-change-${index}`,
    kind,
    subject_ref: "source:changes-source",
    subject_revision: index,
    payload_ref: `payload:changes-${index}`,
    payload_sha256: index.toString(16).repeat(64),
    occurred_at: `2026-09-11T11:00:0${index}.000Z`,
    metadata: { exact: true, index },
  });
}

async function grantEmptyGlobalScope() {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  await insert("scope_read_policy", {
    source_namespace_id: "scope-change-empty-namespace",
    principal_ref: principal,
    client_class: "owner_pwa",
    policy_ref: "scope-change-empty-policy",
    generation: 1,
    allowed_use_json: '["research"]',
    disclosure_ceiling: "private",
    state: "ACTIVE",
    expires_at: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
    created_at: createdAt,
  });
  const access = { principal_ref: principal, client_class: "owner_pwa" as const, credential_generation: credential };
  const owner = createOwnerScopeAuthority(db, access, () => now);
  const scopes = createD1ScopeService(db, owner, { now: () => now });
  const snapshot = await scopes.freeze({ kind: "GLOBAL_LIBRARY" }, credential);
  if (snapshot.member_source_revision_refs.length !== 0) throw new Error("expected an empty GLOBAL_LIBRARY fixture scope");
  await owner.grant(snapshot);
  return snapshot;
}

describe("durable authenticated research changes", () => {
  it("records exact immutable changes and paginates with an HMAC-bound cursor", async () => {
    const first = await readChanges({
      after_cursor: null,
      limit: 2,
      kinds: ["SOURCE_UPDATED", "SOURCE_ADMITTED"],
    });
    expect(first).toMatchObject({
      protocol: "eliotr.research-changes.v1",
      has_more: true,
    });
    expect(first.items.map((item) => item.change_ref)).toEqual([
      "manual-change-1",
      "manual-change-2",
    ]);
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    const replay = await readChanges({
      after_cursor: null,
      limit: 2,
      kinds: ["SOURCE_ADMITTED", "SOURCE_UPDATED"],
    });
    expect(replay).toEqual(first);

    const second = await readChanges({
      after_cursor: first.next_cursor,
      limit: 2,
      kinds: ["SOURCE_ADMITTED", "SOURCE_UPDATED"],
    });
    expect(second.items.map((item) => item.change_ref)).toEqual(["manual-change-3"]);
    expect(second.has_more).toBe(false);

    const token = first.next_cursor as string;
    const changed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await expect(readChanges({ after_cursor: changed, limit: 2, kinds: [
      "SOURCE_ADMITTED",
      "SOURCE_UPDATED",
    ] })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_INVALID" });

    await expect(recordResearchChange(db, {
      change_ref: "manual-change-1",
      kind: "SOURCE_UPDATED",
      subject_ref: "source:other",
      subject_revision: 9,
      payload_ref: "payload:other",
      payload_sha256: "f".repeat(64),
      occurred_at: "2026-09-11T11:30:00.000Z",
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CONFLICT" });
  });

  it("binds cursors to principal, credential, deployment and normalized filters", async () => {
    const first = await readChanges({
      after_cursor: null,
      limit: 1,
      kinds: ["SOURCE_ADMITTED", "SOURCE_UPDATED"],
    });
    expect(first.next_cursor).not.toBeNull();

    for (const input of [
      { who: "other-owner" },
      { credentialGeneration: "credential-v2" },
      { deployment: "test-generation-v2" },
    ]) {
      await expect(readChanges({
        after_cursor: first.next_cursor,
        limit: 1,
        kinds: ["SOURCE_ADMITTED", "SOURCE_UPDATED"],
      }, input)).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_BINDING_MISMATCH" });
    }

    await expect(readChanges({
      after_cursor: first.next_cursor,
      limit: 1,
      kinds: ["SOURCE_UPDATED"],
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_BINDING_MISMATCH" });
  });

  it("expires cursors and refuses to operate without a server-owned key", async () => {
    let clock = NOW_MS;
    const expiring = service({ now: () => clock });
    const first = await expiring(context("expiry"), {
      after_cursor: null,
      limit: 1,
      kinds: ["SOURCE_ADMITTED", "SOURCE_UPDATED"],
    });
    clock += 24 * 60 * 60 * 1_000 + 1;
    await expect(expiring(context("expiry-replay"), {
      after_cursor: first.next_cursor,
      limit: 1,
      kinds: ["SOURCE_ADMITTED", "SOURCE_UPDATED"],
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_INVALID" });

    await expect(service({ key: "invalid" })(context("missing-key"), {
      after_cursor: null,
      limit: 1,
      kinds: [],
    })).rejects.toMatchObject({
      code: "RESEARCH_CHANGES_CONFIG_INVALID",
      status: 503,
      retryable: true,
    });
  });

  it("rechecks scope grants on every page and hides revoked scope events", async () => {
    const scope = await grantEmptyGlobalScope();
    await recordResearchChange(db, {
      change_ref: "scope-private-change",
      kind: "ARTIFACT_DRAFTED",
      subject_ref: "artifact:scope-private",
      subject_revision: 1,
      payload_ref: "payload:scope-private",
      payload_sha256: "c".repeat(64),
      visibility_principal_ref: principal,
      visibility_scope_ref: { id: scope.snapshot_id, revision: scope.revision },
      occurred_at: "2026-09-11T11:40:00.000Z",
    });

    const beforeRevocation = await readChanges({
      after_cursor: null,
      limit: 3,
      kinds: [],
    });
    expect(beforeRevocation.items.map((item) => item.change_ref)).toEqual([
      "manual-change-1",
      "manual-change-2",
      "manual-change-3",
    ]);
    expect(beforeRevocation.has_more).toBe(true);

    await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 " +
      "AND principal_ref=?3 AND client_class='owner_pwa' AND credential_generation=?4")
      .bind(scope.snapshot_id, scope.revision, principal, credential).run();
    const afterRevocation = await readChanges({
      after_cursor: beforeRevocation.next_cursor,
      limit: 100,
      kinds: [],
    });
    expect(afterRevocation.items.map((item) => item.change_ref)).not.toContain("scope-private-change");
    expect(afterRevocation.items).toEqual([]);
  });

  it("serves the owner-only bounded HTTP route", async () => {
    const testEnv = new Proxy(runtime, {
      get(target, key, receiver) {
        if (key === "RESEARCH_CHANGES_CURSOR_KEY") return TEST_CURSOR_KEY;
        return Reflect.get(target, key, receiver);
      },
    }) as Env;
    const request = new Request("https://research.example/api/v1/research/changes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ after_cursor: null, limit: 5, kinds: ["SOURCE_ADMITTED"] }),
    });
    const response = await handleHttp(
      request,
      testEnv,
      {} as ExecutionContext,
      { accessVerifier: verifier() },
    );
    const value = await body<ResearchChangesResult>(response);
    expect(response.status, JSON.stringify(value)).toBe(200);
    expect(value.data.protocol).toBe("eliotr.research-changes.v1");
  });
});
