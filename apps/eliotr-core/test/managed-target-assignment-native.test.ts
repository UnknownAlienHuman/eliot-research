import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import { createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import { AI_SEARCH_PRIMARY_PROJECTION_PROFILE, MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
  aiSearchPhysicalProfileDigest, createD1ManagedTargetAssignmentPort, projectionDigest,
  type ManagedTargetIdentity } from "@eliotr/cloudflare-projection";
import type { ApplicationLifecycle, AuthenticatedRequestContext } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import {
  db,
  insert,
  observeDatabase,
  principal,
  runtime,
  seedSource,
  setupOrientationDatabase,
} from "./orientation-fixture.js";

const readyApplication = {
  async readiness() { return { ready: true }; },
} as unknown as ApplicationLifecycle;

beforeEach(async () => {
  await reset();
  await setupOrientationDatabase();
});

function ownerContext(who = principal): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/projects", { method: "POST" }),
    principal_ref: who,
    client_class: "owner_pwa",
    credential_generation: "credential-v1",
    trace_id: "assignment-project-create",
  };
}

async function createProject(): Promise<string> {
  const projects = createProjectOwnerService({
    database: db,
    deployment_generation: runtime.DEPLOYMENT_GENERATION,
  });
  const result = await projects.create(ownerContext(), {
    idempotency_key: `assignment-project-${crypto.randomUUID()}`,
    title: "Managed target assignment test",
    source_ids: [],
  });
  return result.project_ref.id;
}

async function seedAssignableSource(sourceId: string): Promise<void> {
  await seedSource(sourceId);
  await insert("source_admission_policy", {
    source_namespace_id: `ns-${sourceId}`,
    revision: 1,
    authorized_principal_refs_json: JSON.stringify([principal]),
    allowed_ownership_modes_json: '["immutable_import"]',
    source_class: "document",
    assurance_ceiling: "QUALIFIED",
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    allowed_use_json: '["research"]',
    disclosure_ceiling: "private",
    license_policy_ref: "license-1",
    default_storage_policy: "NORMALIZED_CLOUD_ONLY",
    default_residency_profile_id: "residency-1",
    default_retention_policy_id: "retention-1",
    minimum_quality_state: "standard",
    created_at: new Date().toISOString(),
  });
}

function verifier(
  who = principal,
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(),
  credentialGeneration = "credential-v1",
): AccessVerifier {
  return {
    async verify() {
      return {
        principal_ref: who,
        credential_generation: credentialGeneration,
        authentication_method: "cloudflare_access",
        issuer: "https://access.example",
        expires_at: expiresAt,
      };
    },
  };
}

function request(
  projectId: string,
  method: "GET" | "PUT" | "POST",
  body?: unknown,
  origin = "https://research.example",
  signal?: AbortSignal,
): Request {
  const suffix = method === "POST" ? "/retire" : "";
  const headers = new Headers({
    origin,
    "sec-fetch-site": origin === "https://research.example" ? "same-origin" : "cross-site",
  });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("x-eliotr-csrf", "1");
  }
  return new Request(
    `https://research.example/api/v1/research/projects/${encodeURIComponent(projectId)}/managed-target-assignment${suffix}`,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

async function call(
  req: Request,
  auth = verifier(),
  env: typeof runtime = runtime,
): Promise<Response> {
  return handleHttp(req, env, {} as ExecutionContext, {
    accessVerifier: auth,
    applicationFactory: () => readyApplication,
  });
}

interface JsonObject {
  readonly [key: string]: unknown;
}

async function json(response: Response): Promise<JsonObject> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object response");
  }
  return value as JsonObject;
}

async function configuredTarget(projectId: string): Promise<ManagedTargetIdentity> {
  const response = await call(request(projectId, "GET"));
  expect(response.status).toBe(200);
  const envelope = await json(response);
  return (envelope.data as JsonObject).configured_target as ManagedTargetIdentity;
}

function assignmentBody(target: ManagedTargetIdentity, expected_event_revision: number) {
  return {
    protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
    expected_event_revision,
    target,
  };
}

async function eventCount(projectId: string): Promise<number> {
  return await db.prepare(
    "SELECT COUNT(*) AS n FROM managed_target_assignment_event WHERE project_id=?1",
  ).bind(projectId).first<number>("n") ?? 0;
}

describe("Core managed target assignment on native D1", () => {
  it("produces the physical profile digest used by the generation registry", async () => {
    const target = await configuredTarget(await createProject());
    expect(target.target_profile_identity_sha256).toBe(
      await aiSearchPhysicalProfileDigest(AI_SEARCH_PRIMARY_PROJECTION_PROFILE));
    const legacyProfile = { ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      index_method: { ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method },
      metadata_fields: [...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.metadata_fields].sort() };
    expect(target.target_profile_identity_sha256).not.toBe(await projectionDigest(legacyProfile));
  });

  it("preserves exact legacy assignment replay but refuses a new legacy append", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const legacyTarget = { ...target, target_profile_identity_sha256: await projectionDigest({
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      index_method: { ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method },
      metadata_fields: [...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.metadata_fields].sort(),
    }) };
    const port = createD1ManagedTargetAssignmentPort(db, async () => undefined);
    const original = await port.append({ event_kind: "ASSIGN", project_id: projectId,
      project_generation: 1, project_owner_principal_ref: principal, expected_event_revision: 0,
      actor: { kind: "OWNER", principal_ref: principal, authorization_receipt_ref: "legacy-test-receipt" },
      created_at: new Date().toISOString(), target: legacyTarget });
    const before = (await json(await call(request(projectId, "GET")))).data as JsonObject;
    expect(before.head_event).toEqual(original);
    expect(before.current_assignment).toEqual({ event_revision: 1, target: legacyTarget });
    const replay = await call(request(projectId, "PUT", assignmentBody(legacyTarget, 0)));
    expect(replay.status).toBe(200);
    expect(((await json(replay)).data as JsonObject).event).toEqual(original);
    expect(await eventCount(projectId)).toBe(1);
    const otherProject = await createProject();
    const refused = await call(request(otherProject, "PUT", assignmentBody(legacyTarget, 0)));
    expect(refused.status).toBe(409);
    expect(await eventCount(otherProject)).toBe(0);
  });

  it("assigns only for the authenticated owner and returns the exact head for recovery", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const response = await call(request(projectId, "PUT", assignmentBody(target, 0)));
    const result = await json(response);
    const data = result.data as JsonObject;
    const event = data.event as JsonObject;

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
      event: {
        event_kind: "ASSIGN",
        expected_event_revision: 0,
        event_revision: 1,
        project_id: projectId,
        project_generation: 1,
        project_owner_principal_ref: principal,
        target,
        actor: {
          kind: "OWNER",
          principal_ref: principal,
          authorization_receipt_ref: expect.stringMatching(/^owner-access-[a-f0-9]{64}$/u),
        },
      },
    });
    expect(event.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
    expect(await eventCount(projectId)).toBe(1);

    const readback = await call(request(projectId, "GET"));
    expect((await json(readback)).data).toMatchObject({
      project_id: projectId,
      project_generation: 1,
      project_owner_principal_ref: principal,
      event_head_revision: 1,
      head_event: event,
      current_assignment: { event_revision: 1, target },
    });

    const retired = await call(request(projectId, "POST", {
      protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
      expected_event_revision: 1,
    }));
    const retiredData = (await json(retired)).data as JsonObject;
    const retiredEvent = retiredData.event as JsonObject;
    expect(retired.status).toBe(200);
    expect(retiredEvent).toMatchObject({
      event_kind: "RETIRE",
      expected_event_revision: 1,
      event_revision: 2,
      previous_assignment_revision: 1,
      project_id: projectId,
      project_generation: 1,
      project_owner_principal_ref: principal,
    });
    expect(retiredEvent).not.toHaveProperty("target");
    expect(await eventCount(projectId)).toBe(2);

    const retiredReadback = await call(request(projectId, "GET"));
    expect((await json(retiredReadback)).data).toMatchObject({
      event_head_revision: 2,
      head_event: retiredEvent,
      current_assignment: null,
    });
  });

  it("keeps the active assignment across a same-owner metadata revision", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const assigned = await call(request(projectId, "PUT", assignmentBody(target, 0)));
    expect(assigned.status).toBe(200);
    const assignedEvent = ((await json(assigned)).data as JsonObject).event as JsonObject;

    await createProjectOwnerService({
      database: db,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
    }).update(ownerContext(), projectId, {
      idempotency_key: `assignment-stale-generation-${crypto.randomUUID()}`,
      expected_revision: 1,
      title: "Project generation advanced",
      source_ids: [],
    });

    const staleRead = await call(request(projectId, "GET"));
    const staleData = (await json(staleRead)).data as JsonObject;
    expect(staleRead.status).toBe(200);
    expect(staleData).toMatchObject({
      project_generation: 2,
      event_head_revision: 1,
      head_event: assignedEvent,
      current_assignment: { event_revision: 1, target },
    });

    const wrongRevision = await call(request(projectId, "POST", {
      protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
      expected_event_revision: 2,
    }));
    expect(wrongRevision.status).toBe(409);
    expect((await json(wrongRevision)).code).toBe("MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT");

    const foreignOwner = await call(
      request(projectId, "POST", {
        protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
        expected_event_revision: 1,
      }),
      verifier("foreign-owner"),
    );
    expect(foreignOwner.status).toBe(404);
    expect(await eventCount(projectId)).toBe(1);

    const retired = await call(request(projectId, "POST", {
      protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
      expected_event_revision: 1,
    }));
    expect(retired.status).toBe(200);
    expect(((await json(retired)).data as JsonObject).event).toMatchObject({
      event_kind: "RETIRE",
      expected_event_revision: 1,
      event_revision: 2,
      project_generation: 2,
      project_owner_principal_ref: principal,
      previous_assignment_revision: 1,
    });
    expect(await eventCount(projectId)).toBe(2);

    const reassigned = await call(request(projectId, "PUT", assignmentBody(target, 2)));
    expect(reassigned.status).toBe(200);
    expect(((await json(reassigned)).data as JsonObject).event).toMatchObject({
      event_kind: "ASSIGN",
      expected_event_revision: 2,
      event_revision: 3,
      project_generation: 2,
      project_owner_principal_ref: principal,
      target,
    });
    expect(await eventCount(projectId)).toBe(3);
  });

  it("keeps the same assignment active when the current membership set changes", async () => {
    const sourceId = "assignment-membership-change";
    await seedAssignableSource(sourceId);
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const assigned = await call(request(projectId, "PUT", assignmentBody(target, 0)));
    expect(assigned.status).toBe(200);

    const updated = await createProjectOwnerService({
      database: db,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
    }).update(ownerContext(), projectId, {
      idempotency_key: "assignment-membership-change",
      expected_revision: 1,
      title: "Managed target assignment test",
      source_ids: [sourceId],
    });

    expect(updated).toMatchObject({ revision: 2, source_ids: [sourceId] });
    await expect(db.prepare("SELECT generation,membership_generation FROM project WHERE project_id=?1")
      .bind(projectId).first()).resolves.toEqual({ generation: 2, membership_generation: 2 });
    await expect(db.prepare("SELECT membership_generation,valid_to FROM project_source_membership WHERE project_id=?1")
      .bind(projectId).first()).resolves.toEqual({ membership_generation: 2, valid_to: null });
    const readback = await call(request(projectId, "GET"));
    expect((await json(readback)).data).toMatchObject({
      project_generation: 2,
      event_head_revision: 1,
      current_assignment: { event_revision: 1, target },
    });
    expect(await eventCount(projectId)).toBe(1);
  });

  it("reassigns after retirement when the same owner advances the project generation", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const assigned = await call(request(projectId, "PUT", assignmentBody(target, 0)));
    expect(assigned.status).toBe(200);

    const retired = await call(request(projectId, "POST", {
      protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
      expected_event_revision: 1,
    }));
    expect(retired.status).toBe(200);
    const retiredEvent = ((await json(retired)).data as JsonObject).event as JsonObject;
    expect(retiredEvent).toMatchObject({
      event_kind: "RETIRE",
      expected_event_revision: 1,
      event_revision: 2,
      project_generation: 1,
      project_owner_principal_ref: principal,
      previous_assignment_revision: 1,
    });
    expect(await eventCount(projectId)).toBe(2);

    await createProjectOwnerService({
      database: db,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
    }).update(ownerContext(), projectId, {
      idempotency_key: `assignment-update-after-retire-${crypto.randomUUID()}`,
      expected_revision: 1,
      title: "Project updated after target retirement",
      source_ids: [],
    });

    const updatedRead = await call(request(projectId, "GET"));
    const updatedData = (await json(updatedRead)).data as JsonObject;
    expect(updatedRead.status).toBe(200);
    expect(updatedData).toMatchObject({
      project_generation: 2,
      event_head_revision: 2,
      head_event: retiredEvent,
      current_assignment: null,
    });

    const wrongHead = await call(request(projectId, "PUT", assignmentBody(target, 1)));
    expect(wrongHead.status).toBe(409);
    expect((await json(wrongHead)).code).toBe("MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT");
    expect(await eventCount(projectId)).toBe(2);

    const foreignOwner = await call(
      request(projectId, "PUT", assignmentBody(target, 2)),
      verifier("foreign-owner"),
    );
    expect(foreignOwner.status).toBe(404);
    expect((await json(foreignOwner)).code).toBe("MANAGED_TARGET_ASSIGNMENT_PROJECT_NOT_FOUND");
    expect(await eventCount(projectId)).toBe(2);

    const reassigned = await call(request(projectId, "PUT", assignmentBody(target, 2)));
    expect(reassigned.status).toBe(200);
    expect(((await json(reassigned)).data as JsonObject).event).toMatchObject({
      event_kind: "ASSIGN",
      expected_event_revision: 2,
      event_revision: 3,
      project_generation: 2,
      project_owner_principal_ref: principal,
      target,
    });
    expect(await eventCount(projectId)).toBe(3);
  });

  it("denies foreign and expired owners and rejects cross-origin writes", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);

    const foreign = await call(request(projectId, "GET"), verifier("foreign-owner"));
    expect(foreign.status).toBe(404);
    expect((await json(foreign)).code).toBe("MANAGED_TARGET_ASSIGNMENT_PROJECT_NOT_FOUND");

    const expired = await call(
      request(projectId, "GET"),
      verifier(principal, new Date(Date.now() - 60_000).toISOString()),
    );
    expect(expired.status).toBe(401);
    expect((await json(expired)).code).toBe("MANAGED_TARGET_ASSIGNMENT_OWNER_AUTH_EXPIRED");

    const crossOrigin = await call(
      request(projectId, "PUT", assignmentBody(target, 0), "https://attacker.example"),
    );
    expect(crossOrigin.status).toBe(403);
    expect((await json(crossOrigin)).code).toBe("MANAGED_TARGET_ASSIGNMENT_CSRF_DENIED");
    expect(await eventCount(projectId)).toBe(0);
  });

  it("rejects forged receipt fields, mismatched profiles, and stale event revisions", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const forged = await call(request(projectId, "PUT", {
      ...assignmentBody(target, 0),
      actor: { kind: "OWNER", principal_ref: principal },
      authorization_receipt_ref: "unverified",
    }));
    expect(forged.status).toBe(400);
    expect(await eventCount(projectId)).toBe(0);

    const changedDigest = target.target_profile_identity_sha256.startsWith("a") ? "b" : "a";
    const mismatch = await call(request(projectId, "PUT", assignmentBody({
      ...target,
      target_profile_identity_sha256: changedDigest + target.target_profile_identity_sha256.slice(1),
    }, 0)));
    expect(mismatch.status).toBe(409);
    expect((await json(mismatch)).code).toBe("MANAGED_TARGET_ASSIGNMENT_PROFILE_MISMATCH");
    expect(await eventCount(projectId)).toBe(0);

    const assigned = await call(request(projectId, "PUT", assignmentBody(target, 0)));
    expect(assigned.status).toBe(200);
    const stale = await call(request(projectId, "POST", {
      protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
      expected_event_revision: 2,
    }));
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe("MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT");
    expect(await eventCount(projectId)).toBe(1);
  });

  it("keeps the D1 project-generation fence if ownership changes after authorization", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    let changed = false;
    const observedDb = observeDatabase(async (sql, phase) => {
      if (!changed && phase === "before" &&
          sql.startsWith("INSERT INTO managed_target_assignment_event")) {
        changed = true;
        await createProjectOwnerService({
          database: db,
          deployment_generation: runtime.DEPLOYMENT_GENERATION,
        }).update(ownerContext(), projectId, {
          idempotency_key: `assignment-generation-${crypto.randomUUID()}`,
          expected_revision: 1,
          title: "Generation advanced during assignment",
          source_ids: [],
        });
      }
    });
    const env = { ...runtime, CORE_DB: observedDb } as typeof runtime;
    const response = await call(request(projectId, "PUT", assignmentBody(target, 0)), verifier(), env);

    expect(changed).toBe(true);
    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe("MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE");
    expect(await eventCount(projectId)).toBe(0);
  });

  it("checks the trusted Access expiry in the atomic D1 append", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const expiresAt = new Date(Date.now() + 4_000).toISOString();
    let insertReached = false;
    const observedDb = observeDatabase(async (sql, phase) => {
      if (!insertReached && phase === "before" &&
          sql.startsWith("INSERT INTO managed_target_assignment_event")) {
        insertReached = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 4_200));
      }
    });
    const env = { ...runtime, CORE_DB: observedDb } as typeof runtime;
    const response = await call(
      request(projectId, "PUT", assignmentBody(target, 0)),
      verifier(principal, expiresAt),
      env,
    );

    expect(insertReached).toBe(true);
    expect(response.status).toBe(403);
    expect((await json(response)).code).toBe("MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED");
    expect(await eventCount(projectId)).toBe(0);
  }, 12_000);

  it("reconciles a lost D1 append acknowledgement by reading the exact command head", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    let lost = false;
    const observedDb = observeDatabase(async (sql, phase) => {
      if (!lost && phase === "after" &&
          sql.startsWith("INSERT INTO managed_target_assignment_event")) {
        lost = true;
        throw new Error("simulated acknowledgement loss after D1 commit");
      }
    });
    const env = { ...runtime, CORE_DB: observedDb } as typeof runtime;
    const response = await call(request(projectId, "PUT", assignmentBody(target, 0)), verifier(), env);
    const result = await json(response);
    const data = result.data as JsonObject;
    const event = data.event as JsonObject;

    expect(lost).toBe(true);
    expect(response.status).toBe(200);
    expect(event.event_revision).toBe(1);
    expect(await eventCount(projectId)).toBe(1);

    const readback = await call(request(projectId, "GET"), verifier(), env);
    const readbackData = (await json(readback)).data as JsonObject;
    expect(readbackData.head_event).toEqual(event);
    expect(readbackData.event_head_revision).toBe(1);
    expect(await eventCount(projectId)).toBe(1);
  });

  it("reads back a lost command after Access credential renewal without duplicating the event", async () => {
    const projectId = await createProject();
    const target = await configuredTarget(projectId);
    const controller = new AbortController();
    let lost = false;
    const observedDb = observeDatabase(async (sql, phase) => {
      if (!lost && phase === "after" &&
          sql.startsWith("INSERT INTO managed_target_assignment_event")) {
        lost = true;
        controller.abort();
        throw new Error("simulated acknowledgement loss after D1 commit");
      }
    });
    const env = { ...runtime, CORE_DB: observedDb } as typeof runtime;
    const intent = assignmentBody(target, 0);
    const uncertain = await call(
      request(projectId, "PUT", intent, "https://research.example", controller.signal),
      verifier(principal, new Date(Date.now() + 60_000).toISOString(), "credential-v1"),
      env,
    );
    expect(lost).toBe(true);
    expect(uncertain.status).toBe(503);
    expect(await eventCount(projectId)).toBe(1);

    const renewedAuth = verifier(
      principal,
      new Date(Date.now() + 120_000).toISOString(),
      "credential-v2",
    );
    const readback = await call(request(projectId, "GET"), renewedAuth, env);
    const readbackData = (await json(readback)).data as JsonObject;
    const storedEvent = readbackData.head_event as JsonObject;
    expect(readback.status).toBe(200);
    expect(readbackData.event_head_revision).toBe(1);

    const replay = await call(request(projectId, "PUT", intent), renewedAuth, env);
    const replayData = (await json(replay)).data as JsonObject;
    expect(replay.status).toBe(200);
    expect(replayData.event).toEqual(storedEvent);
    expect(await eventCount(projectId)).toBe(1);
  });
});
