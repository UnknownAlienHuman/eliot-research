/**
 * U3-P New Project mutation controller: causal tests through the actual owner client.
 *
 * Every case drives the real createProjectsApi over the real createLegacyHttpAdapter seam and the
 * real privacy controller, so the fences under test are the ones production uses. Wire payloads
 * satisfy the strict decoder in sources/projects-library/projects.ts unchanged.
 *
 * The central property is that an acknowledgement is not a commit. Only a canonical page carrying
 * the same project identity, revision, title and source set under the current deployment generation
 * confirms a project, and it notifies the selected catalog root exactly once.
 */

import { describe, expect, it, vi } from "vitest";
import type { LegacyErrorDetails, ProjectSummary } from "@eliotr/owner-api-client";
import { createWorkspaceRuntime } from "../app/runtime";
import { createPrivacyController, type SessionContext } from "../app/privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "./client";
import {
  PROJECT_MAX_SOURCE_IDS,
  PROJECT_MAX_TITLE_BYTES,
  createProjectCreationController,
} from "./projectCreation";

const generation = "dep-gen-1", foreignGeneration = "dep-gen-2";
const stamp = "2026-10-13T12:00:00.000Z";
const principal = "owner-1";
const title = "Scope and evidence";
const sourceIds = ["source:a", "source:b"] as const;
const projectsPath = "/api/v1/research/projects";

/** A wire project row that passes every strict decoder rule in projects.ts. */
function projectRow(id: string, rowTitle: string, sources: readonly string[], revision = 1) {
  return {
    protocol: "eliotr.project-owner.v1",
    project_ref: { id, revision },
    title: rowTitle,
    revision,
    owner_principal_ref: principal,
    deployment_generation: generation,
    source_ids: sources,
    created_at: stamp,
  };
}

const createdRow = projectRow("project-new", title, sourceIds);
const earlierRow = projectRow("project-existing", "Earlier work", []);

const wire = (data: unknown, trace: string, withGeneration = generation) => JSON.stringify({
  data, trace_id: trace, deployment_generation: withGeneration,
});

const createdWire = (row: object, withGeneration = generation) =>
  wire({ ...row, deployment_generation: withGeneration }, "trace-mutation", withGeneration);

const listWire = (rows: readonly unknown[], withGeneration = generation) =>
  wire({ protocol: "eliotr.project-owner-list.v1", projects: rows }, "trace-list", withGeneration);

const json = (body: string) => new Response(body, { headers: { "content-type": "application/json" } });
const signal = () => new AbortController().signal;

/** The exact error shape the runtime factory raises for a typed problem. */
class TypedProblem extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | null;
  readonly retryable: boolean;
  public constructor(details: LegacyErrorDetails) {
    super(details.message);
    this.name = "WorkspaceRequestError";
    this.code = details.code;
    this.status = details.status;
    this.traceId = details.traceId;
    this.retryable = details.retryable;
  }
}
const problem = (details: LegacyErrorDetails) => new TypedProblem(details);

/** The canonical page a row belongs to, as a panel would hold it after its own protected read. */
function pageFor(rows: readonly ReturnType<typeof projectRow>[]) {
  return {
    protocol: "eliotr.project-owner-list.v1" as const,
    deployment_generation: generation,
    projects: rows.map(row => ({ project_id: row.project_ref.id, title: row.title,
      revision: row.revision, source_ids: row.source_ids, created_at: row.created_at })),
  };
}

interface Fixture {
  readonly client: ReturnType<typeof createWorkspaceQueryClient>;
  readonly privacy: ReturnType<typeof createPrivacyController>;
  readonly runtime: ReturnType<typeof createWorkspaceRuntime>;
  readonly context: SessionContext;
  readonly fetcher: ReturnType<typeof vi.fn>;
  readonly mint: ReturnType<typeof vi.fn>;
  readonly controller: ReturnType<typeof createProjectCreationController>;
  readonly committed: readonly ProjectSummary[];
  /** Replaces the server selector: one body for the POST, one for the canonical list read. */
  reply(create: string | (() => never), list: string): void;
  /** Overrides the whole fetch handler, for the interrupted cases. */
  behave(handler: (path: string, init: RequestInit | undefined) => Promise<Response> | Response): void;
  bodies(): readonly unknown[];
  dispose(): void;
}

async function fixture(): Promise<Fixture> {
  const client = createWorkspaceQueryClient();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const committed: ProjectSummary[] = [];
  let create: string | (() => never) = createdWire(createdRow);
  let list = listWire([earlierRow, createdRow]);
  const healthBody = json(wire({ ready: true, deployment_generation: generation, core_schema_generation: "s1",
    search_schema_generation: "s1", blocking_reason_codes: [], checked_at: stamp }, "t"));
  const sessionBody = json(wire({ protocol: "eliotr.owner-session.v1", principal_ref: principal,
    credential_generation: "credentials-1", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" }, "t"));
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/system/health") return healthBody;
    if (path === "/api/v1/system/session") return sessionBody;
    const request = init as RequestInit | undefined;
    if (path === projectsPath && request?.method === "POST") {
      return typeof create === "string" ? json(create) : create();
    }
    return json(list);
  });
  const mint = vi.fn(() => "b4f0d0c4-0a1e-4f61-9f5f-9f7d1c1a2b3c");
  const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: "https://owner.example", timers,
    now: () => Date.parse(stamp), mint, sha256: async () => "a".repeat(64),
    isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
  const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); }, verify: readSignal => runtime.verify(readSignal) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Actual bootstrap failed");
  runtime.bind(snapshot.context);
  const apis = runtime.read(snapshot.context);
  if (!apis) throw new Error("Actual binding failed");
  const controller = createProjectCreationController(apis.sources, privacy, snapshot.context, {
    onProjectCommitted: project => { committed.push(project); },
  });
  fetcher.mockClear();
  return {
    client, privacy, runtime, context: snapshot.context, fetcher, mint, controller, committed,
    reply(nextCreate, nextList) { create = nextCreate; list = nextList; },
    behave(handler) {
      fetcher.mockImplementation(async (input, init) => {
        const path = String(input);
        if (path === "/api/v1/system/health") return healthBody;
        if (path === "/api/v1/system/session") return sessionBody;
        return handler(path, init as RequestInit | undefined);
      });
    },
    bodies() {
      return fetcher.mock.calls
        .filter(call => (call[1] as RequestInit | undefined)?.method === "POST")
        .map(call => (call[1] as RequestInit | undefined)?.body);
    },
    dispose() { privacy.dispose(); runtime.dispose(); client.clear(); },
  };
}

describe("New Project mutation controller", () => {
  it("creates with the frozen title, source ids and key, then confirms the canonical row once", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-1");
    const confirmed = await test.controller.submit(signal());
    expect(confirmed.phase).toBe("confirmed");
    expect(confirmed.project).toMatchObject({ project_id: "project-new", revision: 1, title, source_ids: [...sourceIds] });
    expect(test.committed).toHaveLength(1);
    const dispatched = test.fetcher.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === "POST");
    expect(String(dispatched?.[0])).toBe(projectsPath);
    expect(new Headers((dispatched?.[1] as RequestInit | undefined)?.headers).get("idempotency-key")).toBe("intent-1");
    expect(new Headers((dispatched?.[1] as RequestInit | undefined)?.headers).get("x-eliotr-csrf")).toBe("1");
    expect(JSON.parse(String((dispatched?.[1] as RequestInit | undefined)?.body)))
      .toEqual({ title, source_ids: [...sourceIds] });
    expect(test.mint).not.toHaveBeenCalled();
    test.dispose();
  });

  it("refuses an invalid local intent before any request and keeps the editable input", async () => {
    const test = await fixture();
    test.controller.setTitle("  ");
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-2");
    const blank = await test.controller.submit(signal());
    expect(blank.phase).toBe("refused");
    expect(blank.invalid).toBe("title is invalid");
    expect(blank.editable).toBe(true);
    expect(test.bodies()).toHaveLength(0);

    test.controller.setTitle(title);
    test.controller.setSourceIds(["source:b", "source:a"]);
    expect((await test.controller.submit(signal())).invalid).toBe("source_ids is not canonical");

    test.controller.setSourceIds([...sourceIds, "source:a"]);
    expect((await test.controller.submit(signal())).invalid).toBe("source_ids contains duplicates");

    test.controller.setSourceIds(sourceIds);
    test.controller.setTitle("x".repeat(PROJECT_MAX_TITLE_BYTES + 1));
    expect((await test.controller.submit(signal())).invalid).toBe("title is invalid");

    test.controller.setTitle(title);
    test.controller.setSourceIds(Array.from({ length: PROJECT_MAX_SOURCE_IDS + 1 },
      (_unused, index) => `source:${index}`));
    expect((await test.controller.submit(signal())).invalid).toBe("source_ids is invalid");

    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("not a key");
    const badKey = await test.controller.submit(signal());
    expect(badKey.invalid).toBe("idempotency key is invalid");
    // Every refusal kept the owner's own words, ids and key on screen.
    expect(badKey.title).toBe(title);
    expect(badKey.sourceIds).toEqual([...sourceIds]);
    expect(badKey.key).toBe("not a key");
    expect(test.bodies()).toHaveLength(0);
    test.dispose();
  });

  it("requires an explicitly minted key and never mints one itself", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    const missing = await test.controller.submit(signal());
    expect(missing.phase).toBe("refused");
    expect(missing.invalid).toBe("idempotency key is invalid");
    expect(test.bodies()).toHaveLength(0);

    test.controller.mintKey();
    expect(test.mint).toHaveBeenCalledTimes(1);
    const minted = await test.controller.submit(signal());
    expect(minted.phase).toBe("confirmed");
    expect(minted.key).toBe("b4f0d0c4-0a1e-4f61-9f5f-9f7d1c1a2b3c");
    test.dispose();
  });

  it("keeps the exact title, source ids and key when the acknowledgement is lost", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-lost");
    // The seam reached the transport and the deadline elapsed before any acknowledgement arrived.
    test.reply(() => { throw problem({ code: "API_REQUEST_DEADLINE", status: 503,
      message: "Request deadline elapsed", traceId: null, retryable: false }); }, listWire([earlierRow]));
    const lost = await test.controller.submit(signal());
    expect(lost.phase).toBe("unconfirmed");
    expect(lost.title).toBe(title);
    expect(lost.sourceIds).toEqual([...sourceIds]);
    // Same key: no replacement was minted, so the same request can be reconciled.
    expect(lost.key).toBe("intent-lost");
    expect(lost.receipt).toBeUndefined();
    expect(test.mint).not.toHaveBeenCalled();
    expect(lost.outcome).toMatchObject({ outcome: "OUTCOME_UNKNOWN", preservesIdentity: true, action: "READBACK_STATUS" });
    // A canonical page without the new row does not confirm anything.
    test.reply(createdWire(createdRow), listWire([earlierRow]));
    const withoutRow = await test.controller.readStatus(signal());
    expect(withoutRow.phase).toBe("unconfirmed");
    expect(withoutRow.key).toBe("intent-lost");
    expect(test.committed).toHaveLength(0);
    test.dispose();
  });

  it("rejects a canonical readback from a foreign deployment generation", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-generation");
    // The acknowledgement arrives in the current generation, the readback belongs to another one.
    test.reply(createdWire(createdRow), listWire([createdRow], foreignGeneration));
    const stale = await test.controller.submit(signal());
    expect(stale.phase).toBe("unconfirmed");
    expect(stale.project).toBeUndefined();
    expect(stale.key).toBe("intent-generation");
    expect(test.committed).toHaveLength(0);
    // A read in the current generation confirms it.
    test.reply(createdWire(createdRow), listWire([createdRow]));
    expect((await test.controller.readStatus(signal())).phase).toBe("confirmed");
    test.dispose();
  });

  it("rejects a foreign project row, a different title, revision or source scope", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-row");
    // The acknowledgement is for this project, but the canonical page answers with another
    // owner's project. A row that is not the acknowledged identity is never a commit.
    test.reply(createdWire(createdRow), listWire([projectRow("project-someone-else", title, sourceIds)]));
    expect((await test.controller.submit(signal())).phase).toBe("unconfirmed");

    // Same project, a different revision: the canonical row has moved on.
    const movedRevision = projectRow("project-new", title, sourceIds, 3);
    test.reply(createdWire(movedRevision), listWire([movedRevision]));
    expect((await test.controller.submit(signal())).phase).toBe("unconfirmed");

    // Same project and revision, a different title: the server renamed it.
    test.reply(createdWire(projectRow("project-new", "Renamed", sourceIds)),
      listWire([projectRow("project-new", "Renamed", sourceIds)]));
    expect((await test.controller.submit(signal())).phase).toBe("unconfirmed");

    // Same project and revision, a different source scope.
    test.reply(createdWire(projectRow("project-new", title, ["source:a"])),
      listWire([projectRow("project-new", title, ["source:a"])]));
    const resheeted = await test.controller.submit(signal());
    expect(resheeted.phase).toBe("unconfirmed");
    expect(resheeted.key).toBe("intent-row");
    expect(resheeted.title).toBe(title);
    expect(test.committed).toHaveLength(0);
    test.dispose();
  });

  it("discards a canonical readback that arrives after the owner session is lost", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-session");
    const release = Promise.withResolvers<string>();
    test.behave((path, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") {
        return Promise.resolve(json(createdWire(createdRow)));
      }
      return release.promise.then(body => json(body));
    });
    const pending = test.controller.submit(signal());
    await Promise.resolve();
    // The owner session ends while the canonical read is in flight, and the read is not made
    // observable to a controller whose session is already gone.
    test.privacy.close();
    release.resolve(listWire([createdRow]));
    const dropped = await pending;
    // A lost session is reported as an authorization loss, never as an unknown effect, because
    // the privacy controller observed the loss and no protected state may be cleared from it.
    expect(dropped.phase).toBe("authorization-lost");
    expect(dropped.project).toBeUndefined();
    expect(dropped.key).toBe("intent-session");
    expect(test.committed).toHaveLength(0);
    // A controller bound to the lost session dispatches nothing further.
    expect((await test.controller.readStatus(signal())).phase).toBe("authorization-lost");
    expect(test.bodies()).toHaveLength(1);
    test.dispose();
  });

  it("notifies the selected catalog root exactly once for the same canonical row", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-once");
    test.reply(createdWire(createdRow), listWire([earlierRow, createdRow]));
    expect((await test.controller.submit(signal())).phase).toBe("confirmed");
    expect(test.committed).toHaveLength(1);
    // A reconciliation read of the same row adds nothing.
    expect((await test.controller.readStatus(signal())).phase).toBe("confirmed");
    expect(test.committed).toHaveLength(1);
    // A confirmation of a page the caller already read adds nothing either.
    test.controller.confirmReadback(pageFor([earlierRow, createdRow]));
    expect(test.committed).toHaveLength(1);
    test.dispose();
  });

  it("keeps an unresolved attempt blocked until an explicit new owner intent, without a replay", async () => {
    const test = await fixture();
    test.controller.setTitle(title);
    test.controller.setSourceIds(sourceIds);
    test.controller.setKey("intent-blocked");
    test.reply(() => { throw problem({ code: "API_UNREACHABLE", status: 503,
      message: "Owner request could not reach a response", traceId: null, retryable: false }); }, listWire([earlierRow]));
    const blocked = await test.controller.submit(signal());
    expect(blocked.phase).toBe("unconfirmed");
    expect(blocked.editable).toBe(false);
    expect(test.bodies()).toHaveLength(1);
    // A retry of the same in-flight identity never writes a second request.
    expect(await test.controller.submit(signal())).toMatchObject({ phase: "unconfirmed", key: "intent-blocked" });
    expect(test.bodies()).toHaveLength(1);
    // A dismissal of an unresolved attempt is refused, because its outcome is still unknown.
    const dismissed = test.controller.dismiss();
    expect(dismissed.phase).toBe("unconfirmed");
    expect(dismissed.key).toBe("intent-blocked");
    test.dispose();
  });

  it("exposes a protected projects status key that includes the session and deployment epochs", async () => {
    const test = await fixture();
    expect(test.controller.projectsStatusQueryKey()).toEqual(["owner", test.context.cacheEpoch, test.context.principal,
      test.context.credentialGeneration, test.context.deploymentGeneration, "projects", null]);
    expect(test.controller.projectsStatusQueryKey("cursor-1")).toContain("cursor-1");
    test.dispose();
  });
});

