import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ComputerAgentConnection, ComputerAgentConnectionMutationIntent } from "@eliotr/owner-api-client";
import { clearWorkspaceQueries, createWorkspaceQueryClient, protectedQueryKey } from "../query/client";
import {
  computerAgentConnectionMutationActions,
  computerAgentConnectionOperationKey,
  computerAgentQualificationOptions,
  type ComputerAgentConnectionPutInput,
} from "../query/computerAgentConnections";
import { createPrivacyController, type PrivacyController, type SessionContext } from "./privacy";
import { Shell } from "./Shell";
import { createWorkspaceRuntime, type BoundWorkspaceApis } from "./runtime";

const stamp = "2026-10-14T12:00:00.000Z";
const generation = "computer-agent-connections-regression";
const connectionId = "agent.private.01";
const privateName = "Private Research Agent";
const privateIssuer = "https://owner.cloudflareaccess.com";
const privateSubject = "private-research-agent.access";
const foreignConnectionId = "agent.foreign.02";
const foreignPrivateName = "Foreign Private Agent";
const foreignIssuer = "https://foreign-owner.cloudflareaccess.com";
const foreignSubject = "foreign-agent.access";
const traceId = "computer-agent-connections-regression-trace";

type QualificationMode = "expired-ready" | "changed-transport";
interface RequestEvent { readonly method: string; readonly path: string }
interface MutationAttempt { readonly method: string; readonly path: string; readonly body: string; readonly key: string }
interface OperationSnapshot {
  readonly serialized: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly phase: string;
  readonly mintedKeys: number;
  readonly mutationAttempts: number;
  readonly effects: number;
}
interface ComputerAgentRegressionEnvironment {
  readonly client: ReturnType<typeof createWorkspaceQueryClient>;
  readonly privacy: PrivacyController;
  readonly runtime: ReturnType<typeof createWorkspaceRuntime>;
  bindOwnerContext(apis: BoundWorkspaceApis, context: SessionContext): void;
  requestCount(): number;
  requestsSince(index: number): readonly RequestEvent[];
  mutationAttempts(): readonly MutationAttempt[];
  captureOperationSnapshot(): OperationSnapshot;
  assertOperationSnapshot(snapshot: OperationSnapshot): void;
  mintedKeyCount(): number;
  qualificationReadCount(): number;
  effectCount(): number;
  readbackFailureCount(): number;
  setQualificationMode(mode: QualificationMode): void;
  assertForeignOwnerInputsRejected(): void;
  resetCanonicalCommitSentinel(): void;
  assertForeignReceiptNotCommitted(): void;
  preparePostLossIntent(): ComputerAgentConnectionMutationIntent;
  triggerAuthorizationLoss(): Promise<void>;
  assertActionsBlockedAfterAuthorizationLoss(intent: ComputerAgentConnectionMutationIntent): Promise<void>;
  authorizationLossRequestCount(): number;
  assertPreparedOnly(): void;
  assertUnknownReadback(): void;
  assertSameActionRetry(): void;
  assertReceiptReadbackFailure(): void;
  assertConfirmedReadback(): void;
  assertNoRequestAfterAuthorizationLoss(): void;
}

const environments = new WeakMap<HTMLElement, ComputerAgentRegressionEnvironment>();

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data, trace_id: traceId, deployment_generation: generation }), {
    headers: { "content-type": "application/json" },
  });
}

function problem(status: number, code: string, retryable = false): Response {
  return new Response(JSON.stringify({
    type: status === 401 ? "urn:eliotr:problem:access-denied" : "urn:eliotr:problem:service-unavailable",
    title: code,
    status,
    code,
    trace_id: traceId,
    retryable,
  }), { status, headers: { "content-type": "application/json" } });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createRegressionEnvironment(): ComputerAgentRegressionEnvironment {
  const client = createWorkspaceQueryClient();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const requestEvents: RequestEvent[] = [];
  const attempts: MutationAttempt[] = [];
  let connection: ComputerAgentConnection | undefined;
  let foreignConnection: ComputerAgentConnection | undefined;
  let mintedKeyCount = 0;
  let qualificationReads = 0;
  let effectCount = 0;
  let listReads = 0;
  let readbackFailureCount = 0;
  let failNextListReadback = false;
  let qualificationMode: QualificationMode = "expired-ready";
  let authorizationLossOnList = false;
  let authorizationLossCount = 0;
  let requestsAtAuthorizationLoss = -1;
  let canonicalCommitSentinelKey: readonly unknown[] | undefined;

  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://fixture.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    requestEvents.push({ method, path: url.pathname });

    if (url.pathname === "/api/v1/system/health" && method === "GET") return json({
      ready: true,
      deployment_generation: generation,
      core_schema_generation: "schema-computer-agent-regression",
      search_schema_generation: "schema-computer-agent-regression",
      blocking_reason_codes: [],
      checked_at: stamp,
    });
    if (url.pathname === "/api/v1/system/session" && method === "GET") return json({
      protocol: "eliotr.owner-session.v1",
      principal_ref: "owner-regression",
      credential_generation: "credential-regression",
      client_class: "owner_pwa",
      expires_at: "2027-01-01T00:00:00.000Z",
    });
    if (url.pathname === "/api/v1/research/projects" && method === "GET") return json({
      protocol: "eliotr.project-owner-list.v1",
      projects: [],
    });
    if (url.pathname === "/api/v1/system/mcp-diagnostics" && method === "GET") {
      return problem(404, "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND");
    }

    if (url.pathname === "/api/v1/system/computer-agents" && method === "GET") {
      listReads++;
      if (authorizationLossOnList) return problem(401, "ACCESS_SESSION_REQUIRED");
      if (failNextListReadback) {
        failNextListReadback = false;
        readbackFailureCount++;
        return problem(503, "COMPUTER_AGENT_CONNECTION_READBACK_UNAVAILABLE", true);
      }
      const connections = [connection, foreignConnection]
        .filter((item): item is ComputerAgentConnection => item !== undefined)
        .sort((left, right) => left.connection_id < right.connection_id ? -1 : left.connection_id > right.connection_id ? 1 : 0);
      return json({
        protocol: "eliotr.computer-agent-connections.v1",
        connections,
      });
    }

    const connectionMatch = /^\/api\/v1\/system\/computer-agents\/([^/]+)$/u.exec(url.pathname);
    if (connectionMatch && method === "PUT") {
      const selectedId = decodeURIComponent(connectionMatch[1] ?? "");
      const body = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      const key = headers.get("idempotency-key") ?? "";
      if ((selectedId !== connectionId && selectedId !== foreignConnectionId) || headers.get("content-type") !== "application/json" ||
          headers.get("x-eliotr-csrf") !== "1" || key.length === 0) {
        throw new Error("Strict SDK PUT lost its logical ID, JSON, CSRF, or idempotency binding");
      }
      attempts.push({ method, path: url.pathname, body, key });
      const request = JSON.parse(body) as {
        readonly expected_revision: number;
        readonly display_name: string;
        readonly contour: ComputerAgentConnection["contour"];
        readonly actor: ComputerAgentConnection["actor"];
        readonly transport_capabilities: ComputerAgentConnection["transport_capabilities"];
        readonly computer_capabilities: ComputerAgentConnection["computer_capabilities"];
        readonly task_kinds: ComputerAgentConnection["task_kinds"];
        readonly owner_principal_ref?: unknown;
      };
      if (request.expected_revision !== 0 || request.owner_principal_ref !== undefined ||
          request.transport_capabilities.length !== 1 || request.transport_capabilities[0] !== "MCP_WRITE" ||
          request.computer_capabilities.length !== 1 || request.computer_capabilities[0] !== "CLOUD_BROWSER" ||
          request.task_kinds.length !== 1 || request.task_kinds[0] !== "RESEARCH_BRANCH_ANALYSIS") {
        throw new Error("Reviewed PUT silently widened owner authority or changed the create revision");
      }
      const attemptsForConnection = attempts.filter(attempt => attempt.path === url.pathname);
      if (selectedId === connectionId && attemptsForConnection.length === 1) {
        connection = {
          protocol: "eliotr.computer-agent-connection.v1",
          connection_id: connectionId,
          revision: 1,
          owner_principal_ref: "owner-regression",
          state: "ENABLED",
          display_name: request.display_name,
          contour: request.contour,
          actor: request.actor,
          transport_capabilities: [...request.transport_capabilities],
          computer_capabilities: [...request.computer_capabilities],
          task_kinds: [...request.task_kinds],
          created_at: stamp,
          updated_at: stamp,
        };
        effectCount++;
        throw new TypeError("Controlled lost mutation acknowledgement");
      }
      if (selectedId === connectionId && attemptsForConnection.length === 2) {
        const first = attemptsForConnection[0];
        if (first?.body !== body || first.key !== key || effectCount !== 1 || connection === undefined) {
          throw new Error("Same-action reconciliation minted or dispatched a different mutation");
        }
        failNextListReadback = true;
        return json(connection);
      }
      if (selectedId === foreignConnectionId && attemptsForConnection.length === 1) {
        foreignConnection = {
          protocol: "eliotr.computer-agent-connection.v1",
          connection_id: foreignConnectionId,
          revision: 1,
          owner_principal_ref: "foreign-owner-regression",
          state: "ENABLED",
          display_name: request.display_name,
          contour: request.contour,
          actor: { ...request.actor },
          transport_capabilities: [...request.transport_capabilities],
          computer_capabilities: [...request.computer_capabilities],
          task_kinds: [...request.task_kinds],
          created_at: stamp,
          updated_at: stamp,
        };
        effectCount++;
        return json(foreignConnection);
      }
      throw new Error(`Unexpected computer-agent mutation attempt for ${selectedId}`);
    }

    const qualificationMatch = /^\/api\/v1\/system\/computer-agents\/([^/]+)\/qualifications\/([^/]+)$/u.exec(url.pathname);
    if (qualificationMatch && method === "GET") {
      qualificationReads++;
      if (!connection) throw new Error("Qualification was read before the canonical connection existed");
      const requestedTransport = qualificationMatch[2] ?? "";
      const returnedTransport = qualificationMode === "changed-transport" ? "WEB_INBOX" : requestedTransport;
      return json({
        protocol: "eliotr.computer-agent-qualification-status.v1",
        status: "READY",
        connection_id: connection.connection_id,
        connection_revision: connection.revision,
        transport: returnedTransport,
        challenge_id: "qualification-challenge-regression",
        issued_at: "2026-10-10T12:00:00.000Z",
        expires_at: "2026-10-15T12:00:00.000Z",
        deployment_generation: generation,
        observation_ref: "qualification-observation-regression",
        observed_at: "2026-10-10T12:00:00.000Z",
        ready_until: qualificationMode === "expired-ready"
          ? "2026-10-11T12:00:00.000Z"
          : "2026-10-15T12:00:00.000Z",
        verified_credential_generation: "credential-regression",
      });
    }

    throw new Error(`Unexpected raw fixture request: ${method} ${url.pathname}`);
  };

  const runtime = createWorkspaceRuntime({
    fetch: fetchFixture,
    baseUrl: "https://fixture.invalid",
    timers,
    now: () => Date.parse(stamp),
    async sha256(bytes) {
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
        .map(value => value.toString(16).padStart(2, "0")).join("");
    },
    mint() {
      mintedKeyCount++;
      return `connection-regression-intent-${mintedKeyCount}`;
    },
    isCurrent: context => privacy.isCurrent(context),
    onAuthorizationLoss() {
      authorizationLossCount++;
      requestsAtAuthorizationLoss = requestEvents.length;
      privacy.close();
    },
  });
  const privacy = createPrivacyController({
    timers,
    now: () => Date.parse(stamp),
    mask() { runtime.close(); },
    reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); },
    verify: signal => runtime.verify(signal),
  });
  let ownerBindings: {
    readonly apis: BoundWorkspaceApis;
    readonly context: SessionContext;
    readonly actions: ReturnType<typeof computerAgentConnectionMutationActions>;
  } | undefined;

  function requireOwnerBindings() {
    const current = ownerBindings;
    assert(current !== undefined, "Strict owner context is not bound to the regression fixture");
    return current;
  }

  function captureOperationSnapshot(): OperationSnapshot {
    const { context } = requireOwnerBindings();
    const key = computerAgentConnectionOperationKey(context);
    const query = client.getQueryCache().find({ queryKey: key, exact: true });
    const operation = client.getQueryData<{
      readonly intent: ComputerAgentConnectionMutationIntent;
      readonly phase: string;
    }>(key);
    if (!query || !operation) throw new Error("Protected operation holder is missing");
    if (query.options.gcTime !== Infinity || query.meta?.protected !== true || !Object.isFrozen(operation.intent)) {
      throw new Error("Protected operation holder lost retention, protection, or its frozen intent");
    }
    const serialized = JSON.stringify(operation);
    if (serialized === undefined) throw new Error("Protected operation holder could not be serialized for comparison");
    return {
      serialized,
      idempotencyKey: operation.intent.idempotencyKey,
      body: operation.intent.body,
      phase: operation.phase,
      mintedKeys: mintedKeyCount,
      mutationAttempts: attempts.length,
      effects: effectCount,
    };
  }

  function assertOperationSnapshot(snapshot: OperationSnapshot): void {
    const current = captureOperationSnapshot();
    assert(current.serialized === snapshot.serialized &&
      current.idempotencyKey === snapshot.idempotencyKey && current.body === snapshot.body &&
      current.phase === snapshot.phase && current.mintedKeys === snapshot.mintedKeys &&
      current.mutationAttempts === snapshot.mutationAttempts && current.effects === snapshot.effects,
    "Route remount must retain the exact frozen operation without minting or dispatching it again");
  }

  function foreignCurrentDto(): ComputerAgentConnection {
    assert(connection !== undefined, "Owned connection fixture must exist before constructing the foreign DTO");
    return {
      ...connection,
      connection_id: foreignConnectionId,
      owner_principal_ref: "foreign-owner-regression",
      display_name: foreignPrivateName,
      actor: { ...connection.actor, issuer: foreignIssuer, subject: foreignSubject },
    };
  }

  return {
    client,
    privacy,
    runtime,
    bindOwnerContext(apis, context) {
      ownerBindings = { apis, context, actions: computerAgentConnectionMutationActions(apis, privacy, context) };
    },
    requestCount: () => requestEvents.length,
    requestsSince(index) { return requestEvents.slice(index); },
    mutationAttempts: () => attempts,
    captureOperationSnapshot,
    assertOperationSnapshot,
    mintedKeyCount: () => mintedKeyCount,
    qualificationReadCount: () => qualificationReads,
    effectCount: () => effectCount,
    readbackFailureCount: () => readbackFailureCount,
    setQualificationMode(mode) { qualificationMode = mode; },
    assertForeignOwnerInputsRejected() {
      const { apis, context, actions: ownerActions } = requireOwnerBindings();
      const foreign = foreignCurrentDto();
      const input: ComputerAgentConnectionPutInput = {
        expected_revision: foreign.revision,
        display_name: foreign.display_name,
        contour: foreign.contour,
        actor: foreign.actor,
        transport_capabilities: [...foreign.transport_capabilities],
        computer_capabilities: [...foreign.computer_capabilities],
        task_kinds: [...foreign.task_kinds],
      };
      const mintBefore = mintedKeyCount;
      const requestsBefore = requestEvents.length;
      let putRejected = false;
      try { ownerActions.preparePut(foreign.connection_id, input, foreign); } catch { putRejected = true; }
      assert(putRejected && mintedKeyCount === mintBefore && requestEvents.length === requestsBefore,
        "Foreign-owner PUT input must be rejected before SDK key mint or request");
      let disableRejected = false;
      try { ownerActions.prepareDisable(foreign); } catch { disableRejected = true; }
      assert(disableRejected && mintedKeyCount === mintBefore && requestEvents.length === requestsBefore,
        "Foreign-owner disable input must be rejected before SDK key mint or request");
      let qualificationRejected = false;
      try { computerAgentQualificationOptions(apis, privacy, context, foreign, "MCP_WRITE"); } catch { qualificationRejected = true; }
      assert(qualificationRejected && mintedKeyCount === mintBefore && requestEvents.length === requestsBefore &&
        qualificationReads === 0,
      "Foreign-owner qualification input must be rejected before query construction or request");
    },
    resetCanonicalCommitSentinel() {
      const { context } = requireOwnerBindings();
      canonicalCommitSentinelKey = protectedQueryKey(context, "computer-agent-qualification");
      client.setQueryDefaults(canonicalCommitSentinelKey, { gcTime: Infinity });
      client.setQueryData(canonicalCommitSentinelKey, { sentinel: "foreign-receipt-must-not-invalidate" });
      const sentinel = client.getQueryCache().find({ queryKey: canonicalCommitSentinelKey, exact: true });
      assert(sentinel !== undefined && !sentinel.state.isInvalidated,
        "Canonical commit invalidation sentinel must start clear before the foreign receipt scenario");
    },
    assertForeignReceiptNotCommitted() {
      const attemptsForForeign = attempts.filter(attempt => attempt.path.endsWith(`/${foreignConnectionId}`));
      const { context } = requireOwnerBindings();
      const reviewedOperation = client.getQueryData<{ readonly intent: ComputerAgentConnectionMutationIntent }>(
        computerAgentConnectionOperationKey(context),
      );
      const foreignServerDataCached = client.getQueryCache().getAll().some(query => {
        const serverSurface = query.queryKey.includes("computer-agents") ||
          query.queryKey.includes("computer-agent-readback") ||
          query.queryKey.includes("computer-agent-qualification");
        return serverSurface && query.state.data !== undefined &&
          JSON.stringify(query.state.data).includes(foreignPrivateName);
      });
      const sentinel = canonicalCommitSentinelKey === undefined
        ? undefined
        : client.getQueryCache().find({ queryKey: canonicalCommitSentinelKey, exact: true });
      assert(foreignConnection?.owner_principal_ref === "foreign-owner-regression" &&
        attemptsForForeign.length === 1 && mintedKeyCount === 2 && effectCount === 2,
      "Foreign create must return one canonical-looking receipt after one actual server effect");
      assert(reviewedOperation !== undefined && reviewedOperation.intent.body.includes(foreignPrivateName),
        "Owner-reviewed intent may retain the exact user-entered name in its private operation holder");
      assert(!foreignServerDataCached,
        "Foreign server receipt or readback must never enter computer-agent server query data");
      assert(sentinel !== undefined && !sentinel.state.isInvalidated,
        "Foreign receipt must not invoke the canonical-commit invalidation callback");
    },
    preparePostLossIntent() {
      const { actions: ownerActions } = requireOwnerBindings();
      assert(connection !== undefined, "Owned connection fixture must exist before preparing the authority-loss probe");
      const input: ComputerAgentConnectionPutInput = {
        expected_revision: 0,
        display_name: "Authority Loss Probe",
        contour: connection.contour,
        actor: connection.actor,
        transport_capabilities: [...connection.transport_capabilities],
        computer_capabilities: [...connection.computer_capabilities],
        task_kinds: [...connection.task_kinds],
      };
      const mintBefore = mintedKeyCount;
      const intent = ownerActions.preparePut("agent.authority-probe", input);
      assert(mintedKeyCount === mintBefore + 1,
        "Authority-loss probe must hold a real prepared intent before the context closes");
      return intent;
    },
    async triggerAuthorizationLoss() {
      const { apis, context } = requireOwnerBindings();
      authorizationLossOnList = true;
      try { await apis.connections.computerAgents.readComputerAgentConnections(context.deploymentGeneration); }
      catch { /* ACCESS_SESSION_REQUIRED is the controlled fixture outcome. */ }
      assert(authorizationLossCount === 1 && requestsAtAuthorizationLoss === requestEvents.length,
        "Strict composed SDK request must report ACCESS_SESSION_REQUIRED and close the captured context");
      assert(client.getQueryCache().getAll().filter(query => query.meta?.protected === true)
        .every(query => query.state.data === undefined),
      "Authorization loss must synchronously clear every protected query, including the reviewed operation holder");
    },
    async assertActionsBlockedAfterAuthorizationLoss(intent) {
      const { actions: ownerActions } = requireOwnerBindings();
      assert(connection !== undefined, "Owned connection fixture must remain available to validate the blocked input");
      const input: ComputerAgentConnectionPutInput = {
        expected_revision: 0,
        display_name: "Must Not Mint After Authority Loss",
        contour: connection.contour,
        actor: connection.actor,
        transport_capabilities: [...connection.transport_capabilities],
        computer_capabilities: [...connection.computer_capabilities],
        task_kinds: [...connection.task_kinds],
      };
      const mintBefore = mintedKeyCount;
      const requestCountBefore = requestEvents.length;
      let prepareRejected = false;
      try { ownerActions.preparePut("agent.after-authority-loss", input); } catch { prepareRejected = true; }
      assert(prepareRejected && mintedKeyCount === mintBefore,
        "Lost authority must reject preparePut before minting a new idempotency key");
      let executeRejected = false;
      try { await ownerActions.execute(intent); } catch { executeRejected = true; }
      assert(executeRejected && requestEvents.length === requestCountBefore &&
        requestCountBefore === requestsAtAuthorizationLoss,
      "Lost authority must reject a retained intent without a late owner request");
    },
    authorizationLossRequestCount: () => requestsAtAuthorizationLoss,
    assertPreparedOnly() {
      assert(mintedKeyCount === 1 && attempts.length === 0 && effectCount === 0,
        "Review must mint one frozen identity but must not dispatch the mutation");
    },
    assertUnknownReadback() {
      assert(mintedKeyCount === 1 && attempts.length === 1 && effectCount === 1 && listReads >= 2,
        "Lost acknowledgement must retain one intent while protected readback observes the committed row");
    },
    assertSameActionRetry() {
      const first = attempts[0];
      const second = attempts[1];
      assert(mintedKeyCount === 1 && attempts.length === 2 && effectCount === 1 &&
        first !== undefined && second !== undefined && first.key === second.key && first.body === second.body,
      "Manual reconciliation must reuse the original key/body without a second server effect");
    },
    assertReceiptReadbackFailure() {
      assert(readbackFailureCount === 1 && attempts.length === 2 && mintedKeyCount === 1 && effectCount === 1,
        "Canonical receipt followed by readback 503 must not dispatch or mint another mutation");
    },
    assertConfirmedReadback() {
      assert(connection !== undefined && attempts.length === 2 && mintedKeyCount === 1 &&
        effectCount === 1 && readbackFailureCount === 1 && listReads >= 4,
      "Final confirmation must come from protected list readback after the controlled 503");
    },
    assertNoRequestAfterAuthorizationLoss() {
      assert(authorizationLossCount === 1 && requestsAtAuthorizationLoss >= 0 &&
        requestEvents.length === requestsAtAuthorizationLoss,
      "No owner request may start after the strict client reports session authority loss");
    },
  };
}

function ComputerAgentConnectionsPanelRegressionPreview() {
  const [environment] = useState(createRegressionEnvironment);
  const [bound, setBound] = useState<{ readonly context: SessionContext; readonly apis: BoundWorkspaceApis }>();

  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => {
      const snapshot = environment.privacy.getSnapshot();
      if (snapshot.phase === "available") {
        environment.runtime.bind(snapshot.context);
        const apis = environment.runtime.read(snapshot.context);
        if (apis) {
          environment.bindOwnerContext(apis, snapshot.context);
          setBound({ context: snapshot.context, apis });
        }
      }
    });
    void environment.privacy.refresh();
    return () => {
      unsubscribe();
      environment.privacy.dispose();
      environment.runtime.dispose();
      environment.client.clear();
    };
  }, [environment]);

  return <div data-computer-agent-connections-regression="" ref={node => {
    if (node) environments.set(node, environment);
  }}>
    <QueryClientProvider client={environment.client}>
      {bound
        ? <MemoryRouter initialEntries={["/connections"]}>
          <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} />
        </MemoryRouter>
        : <p role="status">Verifying owner session.</p>}
    </QueryClientProvider>
  </div>;
}

async function playComputerAgentConnectionsPanelRegression({ canvas, canvasElement, userEvent }: {
  readonly canvas: {
    findByRole(role: string, options: { readonly name: string | RegExp; readonly exact?: boolean }): Promise<HTMLElement>;
    getByRole(role: string, options: { readonly name: string | RegExp; readonly exact?: boolean }): HTMLElement;
    findByText(text: string | RegExp): Promise<HTMLElement>;
    queryByText(text: string | RegExp): HTMLElement | null;
    queryByRole(role: string, options: { readonly name: string | RegExp; readonly exact?: boolean }): HTMLElement | null;
  };
  readonly canvasElement: HTMLElement;
  readonly userEvent: {
    click(element: HTMLElement): Promise<void>;
    type(element: HTMLElement, text: string): Promise<void>;
    selectOptions(element: HTMLElement, value: string): Promise<void>;
  };
}) {
  const storyRoot = canvasElement.querySelector<HTMLElement>("[data-computer-agent-connections-regression]");
  if (!storyRoot) throw new Error("Computer-agent regression story root is missing");
  const environment = environments.get(storyRoot);
  if (!environment) throw new Error("Composed runtime/strict API fixture is missing");

  async function navigateAwayAndBack(root: HTMLElement): Promise<void> {
    const away = root.querySelector<HTMLAnchorElement>('.er-shell-nav a[data-destination="inbox"]');
    if (!away) throw new Error("Workspace Inbox route link is missing");
    await userEvent.click(away);
    await canvas.findByRole("heading", { name: "Inbox" });
    const back = root.querySelector<HTMLAnchorElement>('.er-shell-nav a[data-destination="connections"]');
    if (!back) throw new Error("Workspace Connections route link is missing");
    await userEvent.click(back);
    await canvas.findByRole("heading", { name: "Computer-agent connections" });
  }

  await canvas.findByRole("heading", { name: "Computer-agent connections" });
  await userEvent.type(canvas.getByRole("textbox", { name: "Logical connection ID" }), connectionId);
  await userEvent.type(canvas.getByRole("textbox", { name: "Display name" }), privateName);
  await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Provider contour" }), "OTHER");
  await userEvent.type(canvas.getByRole("textbox", { name: "Service actor issuer" }), privateIssuer);
  await userEvent.type(canvas.getByRole("textbox", { name: "Service actor subject" }), privateSubject);
  await userEvent.click(canvas.getByRole("checkbox", { name: "Write through MCP" }));
  await userEvent.click(canvas.getByRole("checkbox", { name: "Cloud browser" }));
  await userEvent.click(canvas.getByRole("checkbox", { name: "Research branch analysis" }));
  await userEvent.click(canvas.getByRole("checkbox", { name: "I understand that saving will create or enable this connection." }));
  await userEvent.click(canvas.getByRole("button", { name: "Review and prepare save" }));
  await canvas.findByRole("heading", { name: "Review this exact change" });
  environment.assertPreparedOnly();

  await userEvent.click(canvas.getByRole("button", { name: "Confirm and save enabled configuration" }));
  await canvas.findByText(/protected readback matches the requested result, but a canonical receipt is still required/i);
  environment.assertUnknownReadback();
  const unknownOperation = environment.captureOperationSnapshot();
  await navigateAwayAndBack(storyRoot);
  environment.assertOperationSnapshot(unknownOperation);
  await canvas.findByText(/protected readback matches the requested result, but a canonical receipt is still required/i);
  await userEvent.click(canvas.getByRole("button", { name: "Retry the same reviewed action" }));
  await canvas.findByText(/server returned a receipt for revision 1/i);
  environment.assertSameActionRetry();
  environment.assertReceiptReadbackFailure();
  const receiptOperation = environment.captureOperationSnapshot();
  await navigateAwayAndBack(storyRoot);
  environment.assertOperationSnapshot(receiptOperation);
  await canvas.findByText(/server returned a receipt for revision 1/i);
  if (canvas.queryByRole("button", { name: "Retry the same reviewed action", exact: true })) {
    throw new Error("Receipt/readback lag exposed a mutation retry");
  }

  const beforeReadback = environment.requestCount();
  await userEvent.click(canvas.getByRole("button", { name: "Read the protected configuration again" }));
  await canvas.findByText(/confirmed by receipt and protected readback at revision 1/i);
  const reconciliationEvents = environment.requestsSince(beforeReadback);
  if (reconciliationEvents.length !== 1 || reconciliationEvents[0]?.method !== "GET" ||
      reconciliationEvents[0]?.path !== "/api/v1/system/computer-agents") {
    throw new Error("Receipt reconciliation must issue only one explicit protected GET");
  }
  environment.assertConfirmedReadback();
  environment.assertForeignOwnerInputsRejected();

  await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Transport qualification" }), "MCP_WRITE");
  await userEvent.click(canvas.getByRole("button", { name: "Read qualification" }));
  await canvas.findByText(/server did not provide a current qualification for this transport and owner session/i);
  if (canvas.queryByText(/^Online$/i) || canvas.queryByText(/^Connected$/i) ||
      canvas.queryByText(/server qualification is current/i)) {
    throw new Error("Expired READY qualification was presented as current or online");
  }

  environment.setQualificationMode("changed-transport");
  await userEvent.click(canvas.getByRole("button", { name: "Read qualification" }));
  await canvas.findByText(/qualification could not be read for this connection revision and transport/i);
  if (canvas.queryByText(/^Online$/i) || canvas.queryByText(/^Connected$/i) ||
      canvas.queryByText(/server qualification is current/i)) {
    throw new Error("A qualification response for another transport was presented as current or online");
  }

  environment.resetCanonicalCommitSentinel();
  await userEvent.click(canvas.getByRole("button", { name: "New connection" }));
  await userEvent.type(canvas.getByRole("textbox", { name: "Logical connection ID" }), foreignConnectionId);
  await userEvent.type(canvas.getByRole("textbox", { name: "Display name" }), foreignPrivateName);
  await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Provider contour" }), "OTHER");
  await userEvent.type(canvas.getByRole("textbox", { name: "Service actor issuer" }), foreignIssuer);
  await userEvent.type(canvas.getByRole("textbox", { name: "Service actor subject" }), foreignSubject);
  await userEvent.click(canvas.getByRole("checkbox", { name: "Write through MCP" }));
  await userEvent.click(canvas.getByRole("checkbox", { name: "Cloud browser" }));
  await userEvent.click(canvas.getByRole("checkbox", { name: "Research branch analysis" }));
  await userEvent.click(canvas.getByRole("checkbox", { name: "I understand that saving will create or enable this connection." }));
  await userEvent.click(canvas.getByRole("button", { name: "Review and prepare save" }));
  await canvas.findByRole("heading", { name: "Review this exact change" });
  await userEvent.click(canvas.getByRole("button", { name: "Confirm and save enabled configuration" }));
  await canvas.findByText(/The outcome is unknown/i);
  await canvas.findByText(/Protected readback failed/i);
  environment.assertForeignReceiptNotCommitted();
  if (canvas.queryByRole("button", { name: "Retry the same reviewed action", exact: true })) {
    throw new Error("Foreign-owner readback failure exposed a same-action mutation retry");
  }

  const beforeForeignReconciliation = environment.requestCount();
  await userEvent.click(canvas.getByRole("button", { name: "Read the protected configuration again" }));
  await canvas.findByText(/Protected readback failed/i);
  const foreignReconciliationEvents = environment.requestsSince(beforeForeignReconciliation);
  if (foreignReconciliationEvents.length !== 1 || foreignReconciliationEvents[0]?.method !== "GET" ||
      foreignReconciliationEvents[0]?.path !== "/api/v1/system/computer-agents") {
    throw new Error("Foreign-owner reconciliation must remain a protected read only");
  }
  if (canvas.queryByRole("button", { name: "Retry the same reviewed action", exact: true })) {
    throw new Error("Rejected foreign-owner readback exposed a same-action mutation retry");
  }
  environment.assertForeignReceiptNotCommitted();

  const postLossIntent = environment.preparePostLossIntent();
  await environment.triggerAuthorizationLoss();
  for (let frame = 0; frame < 120 && environment.privacy.getSnapshot().phase === "available"; frame++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  if (environment.privacy.getSnapshot().phase === "available") {
    throw new Error("ACCESS_SESSION_REQUIRED did not close the composed owner session");
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await environment.assertActionsBlockedAfterAuthorizationLoss(postLossIntent);
  const privateValues = [privateName, privateIssuer, privateSubject, foreignPrivateName, foreignIssuer, foreignSubject,
    "Cloud browser", "Write through MCP", "Research branch analysis"];
  const visibleText = storyRoot.textContent ?? "";
  const inputValues = [...storyRoot.querySelectorAll<HTMLInputElement>("input")].map(input => input.value);
  const codeValues = [...storyRoot.querySelectorAll<HTMLElement>("code")].map(node => node.textContent ?? "");
  if (privateValues.some(value => visibleText.includes(value) || inputValues.includes(value) || codeValues.some(code => code.includes(value)))) {
    throw new Error("Authority loss left a private connection name, actor, or capability visible");
  }
  const protectedData = environment.client.getQueryCache().getAll().filter(query => query.meta?.protected === true);
  if (protectedData.some(query => query.state.data !== undefined)) {
    throw new Error("Authority loss left data in the protected query cache, including the operation holder");
  }
  environment.assertNoRequestAfterAuthorizationLoss();
  const root = storyRoot.closest<HTMLElement>(".er-shell") ?? storyRoot;
  root.setAttribute("data-play-ready", "ready");
}

export default {
  title: "Workspace/Computer-agent connections regression",
  component: ComputerAgentConnectionsPanelRegressionPreview,
  parameters: { layout: "fullscreen" },
};

export const ComputerAgentConnectionsPanelRegression = {
  name: "Computer Agent Connections Panel Regression",
  render: () => <ComputerAgentConnectionsPanelRegressionPreview />,
  play: playComputerAgentConnectionsPanelRegression,
};
