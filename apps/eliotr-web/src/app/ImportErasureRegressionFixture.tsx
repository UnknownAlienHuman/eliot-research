import { useEffect, useState } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type {
  ErasurePrepareView,
  LibraryPage,
  ProjectSummary,
  RawFileCaptureReceipt,
  RawMarkdownConversionResult,
  RawNormalizedAdmissionResult,
} from "@eliotr/owner-api-client";
import { createWorkspaceQueryClient, protectedQueryKey } from "../query/client";
import { ErasurePanel } from "./ErasurePanel";
import { ImportPanel } from "./ImportPanel";
import { createPrivacyController, type PrivacyController, type SessionContext } from "./privacy";
import { createWorkspaceRuntime, type BoundWorkspaceApis } from "./runtime";

const generation = "issue335-panel-regression";
const stamp = "2026-10-13T12:00:00.000Z";
const sourceId = "source-panel-1";
interface ErasureRef {
  readonly id: string;
  readonly revision: number;
}
const erasureRefs: readonly ErasureRef[] = [
  { id: "erasure-panel-first", revision: 1 },
  { id: "erasure-panel-fresh", revision: 1 },
];

interface ImportMemoryProbe {
  readonly selection?: {
    readonly original_file_name: string;
    readonly content_sha256: string;
    readonly idempotency_key: string;
    readonly bytes: Uint8Array;
  };
  readonly file?: {
    readonly phase?: string;
    readonly uncertain?: string;
    readonly receipt?: RawFileCaptureReceipt;
    readonly conversion?: RawMarkdownConversionResult;
    readonly admission?: RawNormalizedAdmissionResult;
  };
  readonly admissionRejected?: boolean;
  readonly bundle?: unknown;
  readonly attempt?: { dispose(): void };
  readonly review?: unknown;
  readonly identity?: unknown;
  readonly bundleState?: {
    readonly status?: { readonly state?: string };
    readonly uncertain?: boolean;
    readonly interrupted?: boolean;
  };
  readonly submitted?: boolean;
  readonly bundleRejected?: boolean;
  readonly attachment?: { readonly phase?: string };
}

interface ErasureIntentProbe {
  readonly key: string;
  readonly submitted: boolean;
  readonly rejected?: boolean;
}

interface MutableEvidence {
  readonly rawCapturePostKeys: string[];
  readonly rawCaptureReadKeys: string[];
  readonly rawCaptureNames: string[];
  readonly rawConversionKeys: string[];
  readonly rawAdmissionKeys: string[];
  readonly rawAdmissionBodies: string[];
  readonly rawAdmissionStatusPaths: string[];
  readonly projectUpdateBodies: string[];
  readonly projectUpdateKeys: string[];
  projectListReads: number;
  importCommitReports: number;
  readonly importCommitRefs: string[];
  readonly bundlePrepareKeys: string[];
  readonly bundlePartPaths: string[];
  readonly bundleCompletePaths: string[];
  bundleCommitCount: number;
  readonly erasurePrepareKeys: string[];
  readonly erasureExecuteBodies: string[];
  readonly erasureStatusPaths: string[];
  readonly mintedKeys: string[];
  erasureStatusReads: number;
  completionReports: number;
  readonly completionReportRefs: string[];
}

/**
 * What a story may assert on. It is derived from the recorder above, so a request that starts
 * leaving different evidence behind cannot be asserted unless this type changes with it. Every
 * list is already copied when the snapshot is taken, so an assertion recorded before a later step
 * compares against what had actually been sent by then and never against a list that kept growing.
 */
export type PanelRegressionCounts = {
  readonly [Key in keyof MutableEvidence]: MutableEvidence[Key] extends readonly string[]
    ? readonly string[]
    : MutableEvidence[Key];
};

export interface PanelRegressionProbe {
  counts(): PanelRegressionCounts;
  importMemory(): ImportMemoryProbe | undefined;
  erasureMemory(): {
    readonly intent: ErasureIntentProbe | undefined;
    readonly prepared: ErasurePrepareView | undefined;
  };
}

interface PanelEnvironment {
  readonly client: QueryClient;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly apis: BoundWorkspaceApis;
  readonly page: LibraryPage;
  readonly project?: ProjectSummary;
  readonly evidence: MutableEvidence;
  readonly probe: PanelRegressionProbe;
  dispose(): void;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({
    data,
    trace_id: "panel-regression-trace",
    deployment_generation: generation,
  }), { headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({
    type: "urn:eliotr:problem:panel-regression",
    title: message,
    code,
    status,
    trace_id: "panel-regression-trace",
    retryable: false,
  }), { status, headers: { "content-type": "application/json" } });
}

function erasurePreview(ref: ErasureRef, permissionId: string) {
  return {
    protocol: "eliotr.owner-erasure-preview.v1",
    source_id: sourceId,
    source_title: "Panel regression source",
    revision_targets: ["source-panel-revision-1"],
    request: {
      protocol: "eliotr.owner-erasure.v1",
      permission_ref: { id: permissionId, revision: 1 },
      request: {
        protocol: "erc.privacy.erasure.v1",
        erasure_ref: ref,
        requested_by_principal_ref: "panel-owner",
        exact_subject_refs: ["subject-panel-1"],
        required_locations: ["CanonicalPayload"],
        legal_basis_ref: "panel-basis-1",
        admitted_at: stamp,
        deadline: "2026-11-09T12:00:00.000Z",
      },
    },
  };
}

function erasureReceipt(ref: ErasureRef) {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: ref,
    state: "COMPLETE",
    requested_locations: ["CanonicalPayload"],
    completed_locations: ["CanonicalPayload"],
    blocked_locations: [],
    purge_ledger_entry_ref: "panel-ledger-" + ref.id,
    issued_at: stamp,
  };
}

function requestBytes(body: RequestInit["body"] | undefined): Uint8Array | undefined {
  return body instanceof Uint8Array ? new Uint8Array(body) : undefined;
}

function rawAdmissionResult(
  captureId: string,
  conversionOperationId: string,
  state: "UNKNOWN" | "COMMITTED",
): RawNormalizedAdmissionResult {
  const admissionOperationId = "a".repeat(64);
  const sourceRevisionRef = "source-panel-revision-1";
  const expiresAt = "2026-10-13T13:00:00.000Z";
  const admissionReceipt = state === "COMMITTED" ? {
    operation_id: admissionOperationId,
    manifest_sha256: "b".repeat(64),
    source_revision_ref: sourceRevisionRef,
    normalized_artifact_ref: "artifact-panel-1",
    object_residency_key_digest: "c".repeat(64),
    decision: "ADMITTED" as const,
    reason_codes: [],
    readback_sha256: "d".repeat(64),
    committed_at: stamp,
  } : undefined;
  return {
    protocol: "eliotr.raw-normalized-admission.v1",
    admission_operation_id: admissionOperationId,
    capture_id: captureId,
    conversion_operation_id: conversionOperationId,
    candidate_ref: "raw-normalized-candidate:" + "e".repeat(64),
    state,
    source_revision_ref: sourceRevisionRef,
    source_view_ref: "snapshot-view:v1:" + "f".repeat(64),
    conversion_state: "COMPLETE",
    ...(admissionReceipt ? {
      status: {
        operation_id: admissionOperationId,
        state: "COMMITTED" as const,
        source_revision_ref: sourceRevisionRef,
        receipt: admissionReceipt,
        expires_at: expiresAt,
        updated_at: stamp,
      },
      admission_receipt: admissionReceipt,
    } : {}),
    reason_codes: [],
    expires_at: expiresAt,
    updated_at: stamp,
  };
}

async function buildEnvironment(projectSelected = false): Promise<PanelEnvironment> {
  const client = createWorkspaceQueryClient();
  const evidence: MutableEvidence = {
    rawCapturePostKeys: [],
    rawCaptureReadKeys: [],
    rawCaptureNames: [],
    rawConversionKeys: [],
    rawAdmissionKeys: [],
    rawAdmissionBodies: [],
    rawAdmissionStatusPaths: [],
    projectUpdateBodies: [],
    projectUpdateKeys: [],
    projectListReads: 0,
    importCommitReports: 0,
    importCommitRefs: [],
    bundlePrepareKeys: [],
    bundlePartPaths: [],
    bundleCompletePaths: [],
    bundleCommitCount: 0,
    erasurePrepareKeys: [],
    erasureExecuteBodies: [],
    erasureStatusPaths: [],
    mintedKeys: [],
    erasureStatusReads: 0,
    completionReports: 0,
    completionReportRefs: [],
  };
  const captures = new Map<string, {
    readonly protocol: "eliotr.raw-file-capture.v1";
    readonly disposition: "CAPTURED";
    readonly capture_id: string;
    readonly idempotency_key: string;
    readonly original_file_name: string;
    readonly content_sha256: string;
    readonly size_bytes: number;
    readonly content_type: string;
    readonly captured_at: string;
  }>();
  let activeErasureRef: ErasureRef | undefined;
  let projectRevision = 1;
  let projectSourceIds: readonly string[] = [];
  const projectId = "project-panel-target";
  const projectTitle = "Panel import target";
  const projectWire = () => ({
    protocol: "eliotr.project-owner.v1",
    project_ref: { id: projectId, revision: projectRevision },
    title: projectTitle,
    revision: projectRevision,
    owner_principal_ref: "panel-owner",
    deployment_generation: generation,
    source_ids: projectSourceIds,
    created_at: stamp,
  });
  const selectedProject: ProjectSummary | undefined = projectSelected ? {
    project_id: projectId, title: projectTitle, revision: projectRevision, source_ids: projectSourceIds, created_at: stamp,
  } : undefined;
  let admissionSnapshot: {
    readonly captureId: string;
    readonly conversionOperationId: string;
    readonly operationId: string;
  } | undefined;
  let mintIndex = 0;

  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const runtimeHolder: { current?: ReturnType<typeof createWorkspaceRuntime> } = {};
  const privacy = createPrivacyController({
    mask() { runtimeHolder.current?.close(); },
    reveal() {},
    cancelReads() { void client.cancelQueries(); },
    clearProtected() { client.clear(); },
    verify: signal => {
      const runtime = runtimeHolder.current;
      return runtime ? runtime.verify(signal) : Promise.resolve(undefined);
    },
    now: () => Date.parse(stamp),
    timers,
  });

  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://panel-regression.invalid");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/v1/system/health") {
      return json({
        ready: true,
        deployment_generation: generation,
        core_schema_generation: "panel-schema-1",
        search_schema_generation: "panel-schema-1",
        blocking_reason_codes: [],
        checked_at: stamp,
      });
    }
    if (url.pathname === "/api/v1/system/session") {
      return json({
        protocol: "eliotr.owner-session.v1",
        principal_ref: "panel-owner",
        credential_generation: "panel-credential",
        client_class: "owner_pwa",
        expires_at: "2027-01-01T00:00:00.000Z",
      });
    }
    if (url.pathname === "/api/v1/research/projects" && method === "GET") {
      evidence.projectListReads += 1;
      return json({ protocol: "eliotr.project-owner-list.v1", projects: projectSelected ? [projectWire()] : [] });
    }
    if (url.pathname === `/api/v1/research/projects/${projectId}` && method === "PUT") {
      if (!projectSelected) throw new Error("Project membership was updated without a selected project");
      const request = JSON.parse(String(init?.body)) as { readonly title?: unknown; readonly source_ids?: unknown; readonly expected_revision?: unknown };
      if (request.title !== projectTitle || request.expected_revision !== projectRevision || !Array.isArray(request.source_ids)) {
        throw new Error("Project membership did not use the selected project snapshot");
      }
      evidence.projectUpdateBodies.push(String(init?.body));
      evidence.projectUpdateKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      projectSourceIds = [...request.source_ids as string[]].sort();
      projectRevision += 1;
      return json(projectWire());
    }
    if (url.pathname === "/api/v1/library/namespaces") {
      return json({
        protocol: "eliotr.owner-namespaces.v1",
        profiles: [],
        namespaces: [{
          source_namespace_id: "workspace-panel-1", title: "Panel imports",
          read_policy_generation: 1, read_expires_at: "2027-01-01T00:00:00.000Z", read_access: "ACTIVE",
          minimum_quality_state: "degraded",
        }],
      });
    }

    if (url.pathname === "/api/v1/ingest/raw" && method === "POST") {
      const headers = new Headers(init?.headers);
      const bodyBytes = requestBytes(init?.body);
      if (!bodyBytes) throw new Error("Raw capture did not carry the selected bytes");
      if (headers.get("x-eliotr-source-namespace-id") !== "workspace-panel-1" ||
          headers.get("x-eliotr-csrf") !== "1") {
        throw new Error("Raw capture lost its workspace or CSRF binding");
      }
      const key = headers.get("idempotency-key") ?? "";
      const name = decodeURIComponent(headers.get("x-eliotr-original-file-name") ?? "");
      evidence.rawCapturePostKeys.push(key);
      evidence.rawCaptureNames.push(name);
      const suffix = evidence.rawCapturePostKeys.length.toString(16).padStart(48, "0");
      const receipt = {
        protocol: "eliotr.raw-file-capture.v1" as const,
        disposition: "CAPTURED" as const,
        capture_id: "raw-capture-" + suffix,
        idempotency_key: key,
        original_file_name: name,
        content_sha256: headers.get("x-eliotr-content-sha256") ?? "",
        size_bytes: bodyBytes.byteLength,
        content_type: headers.get("content-type") ?? "",
        captured_at: stamp,
      };
      captures.set(key, receipt);
      if (evidence.rawCapturePostKeys.length === 2) {
        throw new TypeError("Synthetic lost acknowledgement after capture");
      }
      return json(receipt);
    }

    if (url.pathname === "/api/v1/ingest/raw" && method === "GET") {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      evidence.rawCaptureReadKeys.push(key);
      const receipt = captures.get(key);
      if (!receipt) return problem(404, "RAW_CAPTURE_NOT_FOUND", "No capture matches this identity");
      return json(receipt);
    }

    if (url.pathname.startsWith("/api/v1/ingest/raw/") && url.pathname.endsWith("/markdown") && method === "POST") {
      const captureId = decodeURIComponent(url.pathname.split("/")[5] ?? "");
      const receipt = [...captures.values()].find(item => item.capture_id === captureId);
      if (!receipt) throw new Error("Conversion did not reference a captured file");
      const request = JSON.parse(String(init?.body)) as { readonly idempotency_key?: unknown };
      if (typeof request.idempotency_key !== "string") throw new Error("Conversion request omitted its chosen identity");
      evidence.rawConversionKeys.push(request.idempotency_key);
      return json({
        protocol: "eliotr.raw-markdown-conversion.v1",
        state: "COMPLETE",
        operation_id: "e".repeat(64),
        capture_id: receipt.capture_id,
        content_sha256: receipt.content_sha256,
        output_sha256: "c".repeat(64),
        output_bytes: 24,
        detected_mime: "text/markdown",
        format: "markdown",
        tokens: 4,
      });
    }

    if (url.pathname.startsWith("/api/v1/ingest/raw/") && url.pathname.endsWith("/admission") && method === "POST") {
      const request: unknown = JSON.parse(String(init?.body));
      const captureId = decodeURIComponent(url.pathname.split("/")[5] ?? "");
      const capture = [...captures.values()].find(item => item.capture_id === captureId);
      if (!capture || typeof request !== "object" || request === null ||
          !("idempotency_key" in request) || !("conversion_operation_id" in request) ||
          typeof request.idempotency_key !== "string" ||
          !/^raw-admission-[a-f0-9]{64}$/u.test(request.idempotency_key) ||
          typeof request.conversion_operation_id !== "string" ||
          request.conversion_operation_id !== "e".repeat(64) ||
          (evidence.rawAdmissionKeys.length !== 0 && admissionSnapshot?.captureId === captureId)) {
        throw new Error("Raw admission did not preserve its original request identity");
      }
      evidence.rawAdmissionKeys.push(request.idempotency_key);
      evidence.rawAdmissionBodies.push(String(init?.body));
      const unknown = rawAdmissionResult(captureId, request.conversion_operation_id, "UNKNOWN");
      admissionSnapshot = {
        captureId,
        conversionOperationId: request.conversion_operation_id,
        operationId: unknown.admission_operation_id,
      };
      return json(unknown);
    }

    if (url.pathname.startsWith("/api/v1/ingest/raw/") && url.pathname.endsWith("/source-identity") && method === "GET") {
      const segments = url.pathname.split("/");
      const saved = admissionSnapshot;
      const captureId = decodeURIComponent(segments[5] ?? "");
      const operationId = decodeURIComponent(segments[7] ?? "");
      if (segments.length !== 9 || segments[6] !== "admission" || !saved || saved.captureId !== captureId || saved.operationId !== operationId) {
        throw new Error("Source identity read did not use the committed admission");
      }
      return json({ protocol: "eliotr.raw-source-identity.v1", admission_operation_id: operationId,
        capture_id: captureId, source_revision_ref: "source-panel-revision-1", source_id: sourceId });
    }
    if (url.pathname.startsWith("/api/v1/ingest/raw/") && url.pathname.includes("/admission/") && method === "GET") {
      const segments = url.pathname.split("/");
      const captureId = decodeURIComponent(segments[5] ?? "");
      const operationId = decodeURIComponent(segments[7] ?? "");
      const saved = admissionSnapshot;
      if (segments.length !== 8 || segments[6] !== "admission" || !saved ||
          saved.captureId !== captureId || saved.operationId !== operationId) {
        throw new Error("Raw admission status did not use the saved operation identity");
      }
      evidence.rawAdmissionStatusPaths.push(url.pathname);
      return json(rawAdmissionResult(saved.captureId, saved.conversionOperationId, "COMMITTED"));
    }

    if (url.pathname === "/api/v1/library/erasure/prepare" && method === "POST") {
      const request = JSON.parse(String(init?.body)) as { readonly idempotency_key?: unknown };
      evidence.erasurePrepareKeys.push(String(request.idempotency_key ?? ""));
      const ref = erasureRefs[Math.min(evidence.erasurePrepareKeys.length - 1, erasureRefs.length - 1)];
      if (!ref) throw new Error("Erasure prepare did not select a configured review identity");
      activeErasureRef = ref;
      return json(erasurePreview(ref, "permission-" + ref.id));
    }

    if (url.pathname === "/api/v1/library/erasure" && method === "POST") {
      evidence.erasureExecuteBodies.push(String(init?.body));
      if (evidence.erasureExecuteBodies.length === 1) {
        return problem(409, "ERASURE_PERMISSION_CONFLICT", "The review is no longer current");
      }
      if (evidence.erasureExecuteBodies.length === 2) {
        throw new TypeError("Synthetic lost erasure acknowledgement");
      }
      throw new Error("The panel issued an unexpected repeated erasure");
    }

    if (url.pathname.startsWith("/api/v1/library/erasure/") && method === "GET") {
      evidence.erasureStatusReads += 1;
      evidence.erasureStatusPaths.push(url.pathname);
      if (!activeErasureRef) throw new Error("Erasure status was read before a review existed");
      if (evidence.erasureStatusReads === 1) {
        return json({
          protocol: "eliotr.owner-erasure-status.v1",
          erasure_ref: activeErasureRef,
          state: "UNKNOWN",
        });
      }
      if (evidence.erasureStatusReads === 2) {
        const foreignRef = { id: "erasure-foreign-receipt", revision: 1 };
        return json({
          protocol: "eliotr.owner-erasure-status.v1",
          erasure_ref: foreignRef,
          state: "COMPLETE",
          receipt: erasureReceipt(foreignRef),
        });
      }
      return json({
        protocol: "eliotr.owner-erasure-status.v1",
        erasure_ref: activeErasureRef,
        state: "COMPLETE",
        receipt: erasureReceipt(activeErasureRef),
      });
    }

    throw new Error("Unexpected panel regression request: " + method + " " + url.pathname);
  };

  const runtime = createWorkspaceRuntime({
    fetch: fetchFixture,
    baseUrl: "https://panel-regression.invalid",
    timers,
    now: () => Date.parse(stamp),
    async sha256(bytes) {
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
        value => value.toString(16).padStart(2, "0")).join("");
    },
    mint() {
      const suffix = (mintIndex++).toString().padStart(12, "0");
      const key = "33333333-3333-4333-8333-" + suffix;
      evidence.mintedKeys.push(key);
      return key;
    },
    isCurrent: context => privacy.isCurrent(context),
    onAuthorizationLoss() { privacy.close(); },
  });
  runtimeHolder.current = runtime;

  await privacy.refresh();
  const verified = privacy.getSnapshot();
  if (verified.phase !== "available") throw new Error("Panel fixture owner authority did not verify");
  runtime.bind(verified.context);
  const apis = runtime.read(verified.context);
  if (!apis) throw new Error("Panel fixture runtime did not bind");

  const page: LibraryPage = {
    projects: [{ id: "project-panel-1", title: "Panel regression", generation }],
    sources: [{ id: sourceId, title: "Panel regression source", readiness_ref: "readiness-panel-1" }],
    generation,
    trace: "panel-regression-trace",
  };

  const probe: PanelRegressionProbe = {
    counts() {
      // Each list is copied so a snapshot can never alias the live recorder, and the copy walks the
      // same keys the counts type names, so neither can silently drop a recorded identity.
      const counts = {} as Record<string, unknown>;
      for (const [key, value] of Object.entries(evidence)) {
        counts[key] = Array.isArray(value) ? [...value] : value;
      }
      return counts as PanelRegressionCounts;
    },
    importMemory() {
      return client.getQueryData<ImportMemoryProbe>([
        ...protectedQueryKey(verified.context, "imports"),
        "local-intent",
      ]);
    },
    erasureMemory() {
      const key = protectedQueryKey(verified.context, "erasure");
      const intent = client.getQueryData<ErasureIntentProbe>([...key, "intent", sourceId]);
      const prepared = intent
        ? client.getQueryData<ErasurePrepareView>([...key, "prepared", sourceId, intent.key])
        : undefined;
      return { intent, prepared };
    },
  };

  return {
    client,
    privacy,
    context: verified.context,
    apis,
    page,
    ...(selectedProject ? { project: selectedProject } : {}),
    evidence,
    probe,
    dispose() {
      runtime.dispose();
      privacy.dispose();
      client.clear();
    },
  };
}

export function ImportErasureRegressionFixture({ panel, onProbe, projectSelected = false }: {
  readonly panel: "import" | "erasure";
  readonly onProbe?: (probe: PanelRegressionProbe) => void;
  readonly projectSelected?: boolean;
}) {
  const [environment, setEnvironment] = useState<PanelEnvironment>();
  const [mounted, setMounted] = useState(true);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let live = true;
    let owned: PanelEnvironment | undefined;
    void buildEnvironment(projectSelected).then(next => {
      owned = next;
      if (live) setEnvironment(next);
      else next.dispose();
    }).catch(error => {
      if (live) setFailure(error instanceof Error ? error.message : "Panel fixture failed");
    });
    return () => {
      live = false;
      owned?.dispose();
    };
  }, []);
  useEffect(() => {
    if (environment) onProbe?.(environment.probe);
  }, [environment, onProbe]);

  if (failure) return <p role="alert">{failure}</p>;
  if (!environment) return <p role="status">Preparing composed panel fixture</p>;

  return <QueryClientProvider client={environment.client}>
    <button type="button" onClick={() => setMounted(value => !value)}>
      {mounted ? "Unmount panel" : "Mount panel"}
    </button>
    {mounted && (panel === "import"
      ? <ImportPanel
          apis={environment.apis}
          privacy={environment.privacy}
          context={environment.context}
          locale="en"
          {...(environment.project ? { project: environment.project } : {})}
          projectSelected={projectSelected}
          onImportCommitted={source => {
            environment.evidence.importCommitReports += 1;
            if (source) environment.evidence.importCommitRefs.push(`${source.sourceId}:${source.sourceRevisionRef}:${source.generation}`);
          }}
        />
      : <ErasurePanel
          apis={environment.apis}
          privacy={environment.privacy}
          context={environment.context}
          locale="en"
          selectedSourceId={sourceId}
          page={environment.page}
          currentLibrary={() => environment.page}
          onErasureComplete={(completedSourceId, status) => {
            environment.evidence.completionReports += 1;
            environment.evidence.completionReportRefs.push(
              `${completedSourceId}:${status.erasure_ref.id}:${status.erasure_ref.revision}`,
            );
          }}
        />)}
  </QueryClientProvider>;
}
