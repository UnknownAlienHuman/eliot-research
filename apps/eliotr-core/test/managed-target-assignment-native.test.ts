import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import { createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import { MANAGED_TARGET_ASSIGNMENT_PROTOCOL, type ManagedTargetIdentity } from "@eliotr/cloudflare-projection";
import type { ApplicationLifecycle, AuthenticatedRequestContext } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import {
  db,
  observeDatabase,
  principal,
  runtime,
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
