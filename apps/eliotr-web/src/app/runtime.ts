import {
  createSessionEpoch, createOwnerApiClient, createLegacyHttpAdapter,
  createHealthApi, createOwnerSessionApi, createProjectsApi, createLibraryApi,
  createReadinessApi, createRevisionApi, createReaderApi, createErasureOperations,
  createClientGrantApi, createProviderKeyApi, createProviderModelUseApi, createGoogleOAuthApi,
  createMcpDiagnosticApi, createResearchModelConfigurationApi, createResearchConfigurationApi,
  createNamespacesApi, createRawFileApi, createBundleInputApi, createBundleWireApi, createBundleImportApi,
  createResearchRunWire, createResearchRunsApi, createRunHistoryApi, createResearchSessionProjectionAdapter,
  createManifestApi, createSectionApi, createCitationAuditHelpers, createCitationApi, createReauthorizationApi, createEvidenceBytesApi,
  createWikiReadApi, createWikiCreateApi, createWikiPublishApi, createArtifactApi,
  type TimerPort, type LegacyErrorDetails,
} from '@eliotr/owner-api-client';
import type { SessionVerification, SessionContext } from './privacy';

/** Only bounded, caller-safe typed errors are available to presentation. */
export class WorkspaceRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | null;
  readonly retryable: boolean;
  constructor(details: LegacyErrorDetails) {
    super(details.message); this.name = 'WorkspaceRequestError';
    this.status = details.status; this.code = details.code;
    this.traceId = details.traceId; this.retryable = details.retryable;
  }
}
export const isWorkspaceRequestError = (value: unknown): value is WorkspaceRequestError => value instanceof WorkspaceRequestError;
const errorFactory = (details: LegacyErrorDetails) => new WorkspaceRequestError(details);
export interface WorkspaceRuntimePorts {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly timers: TimerPort;
  readonly now: () => number;
  readonly sha256: (bytes: Uint8Array) => Promise<string>;
  readonly mint: () => string;
  readonly isCurrent: (context: SessionContext) => boolean;
  readonly onAuthorizationLoss: () => void;
}
export interface BoundWorkspaceApis {
  readonly http: ReturnType<typeof createLegacyHttpAdapter>;
  readonly binary: ReturnType<typeof createOwnerApiClient>;
  readonly health: ReturnType<typeof createHealthApi>;
  readonly session: ReturnType<typeof createOwnerSessionApi>;
  readonly research: {
    readonly runs: ReturnType<typeof createResearchRunsApi>;
    readonly history: ReturnType<typeof createRunHistoryApi>;
    readonly projection: ReturnType<typeof createResearchSessionProjectionAdapter>;
  };
  readonly evidence: {
    readonly manifest: ReturnType<typeof createManifestApi>;
    readonly sections: ReturnType<typeof createSectionApi>;
    readonly citations: ReturnType<typeof createCitationApi>;
    readonly reauthorization: ReturnType<typeof createReauthorizationApi>;
    readonly bytes: ReturnType<typeof createEvidenceBytesApi>;
  };
  readonly studio: {
    readonly read: ReturnType<typeof createWikiReadApi>;
    readonly create: ReturnType<typeof createWikiCreateApi>;
    readonly publish: ReturnType<typeof createWikiPublishApi>;
    readonly artifact: ReturnType<typeof createArtifactApi>;
  };
  readonly connections: {
    readonly grants: ReturnType<typeof createClientGrantApi>;
    readonly providers: ReturnType<typeof createProviderKeyApi>;
    readonly modelUse: ReturnType<typeof createProviderModelUseApi>;
    readonly google: ReturnType<typeof createGoogleOAuthApi>;
    readonly diagnostic: ReturnType<typeof createMcpDiagnosticApi>;
    readonly models: ReturnType<typeof createResearchModelConfigurationApi>;
    readonly configuration: ReturnType<typeof createResearchConfigurationApi>;
  };
  readonly sources: {
    readonly namespaces: ReturnType<typeof createNamespacesApi>;
    readonly imports: {
      readonly raw: ReturnType<typeof createRawFileApi>;
      readonly input: ReturnType<typeof createBundleInputApi>;
      readonly wire: ReturnType<typeof createBundleWireApi>;
      readonly bundle: ReturnType<typeof createBundleImportApi>;
    };
    readonly projects: ReturnType<typeof createProjectsApi>;
    readonly library: ReturnType<typeof createLibraryApi>;
    readonly readiness: ReturnType<typeof createReadinessApi>;
    readonly revisions: ReturnType<typeof createRevisionApi>;
    readonly reader: ReturnType<typeof createReaderApi>;
    readonly erasure: ReturnType<typeof createErasureOperations>;
    /** Mint only on an explicit new owner intent, never on retry or reconciliation. */
    readonly mintIntent: () => string;
  };
  dispose(): void;
}
function createBoundApis(ports: WorkspaceRuntimePorts, epoch: ReturnType<typeof createSessionEpoch>): BoundWorkspaceApis {
  const clientPorts = {
    fetch: ports.fetch, baseUrl: ports.baseUrl, timers: ports.timers, epoch,
    onAuthorizationLoss(observation: { readonly current: boolean }) { if (observation.current) ports.onAuthorizationLoss(); },
  };
  const http = createLegacyHttpAdapter(clientPorts, errorFactory);
  const binary = createOwnerApiClient(clientPorts);
  const models = createResearchModelConfigurationApi(http, errorFactory, epoch);
  const bundleWire = createBundleWireApi(http, binary, errorFactory, epoch, { now: ports.now });
  const researchPorts = { request: http.requestApiWithStatuses, errors: errorFactory, epoch };
  const wire = createResearchRunWire(errorFactory), runs = createResearchRunsApi(researchPorts);
  const manifest = createManifestApi({ http, errors: errorFactory, epoch });
  const audit = createCitationAuditHelpers(errorFactory, wire);
  const citations = createCitationApi(researchPorts, { wire, audit });
  const host = new URL(ports.baseUrl);
  const projection = createResearchSessionProjectionAdapter({ epoch, errors: errorFactory, now: ports.now, isRequestError: isWorkspaceRequestError,
    controls: { transport: 'cf-websocket', host: host.host, protocol: host.protocol === 'https:' ? 'wss' : 'ws' } });
  const collaborators = { digestBytes: ports.sha256, manifest };
  return {
    http, binary,
    health: createHealthApi(http, errorFactory, epoch),
    session: createOwnerSessionApi(http, errorFactory, epoch, { now: ports.now }),
    research: { runs, history: createRunHistoryApi(researchPorts, { wire, decodeStatus: runs.decodeResearchRunStatus }), projection },
    evidence: {
      manifest, sections: createSectionApi({ http, errors: errorFactory, epoch, sha256: ports.sha256 }), citations,
      reauthorization: createReauthorizationApi(researchPorts, { wire, audit, decodeSectionCitations: citations.decodeSectionCitations, readSectionCitations: citations.readSectionCitations }),
      bytes: createEvidenceBytesApi({ request: http, errors: errorFactory, epoch, async digest(algorithm, bytes) {
        if (algorithm !== 'SHA-256') throw new Error('Unsupported evidence digest');
        const hash = await ports.sha256(bytes);
        if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid evidence digest');
        return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16)).buffer;
      } }),
    },
    studio: {
      read: createWikiReadApi({ http, errors: errorFactory, epoch, collaborators }),
      create: createWikiCreateApi({ http, errors: errorFactory, epoch }),
      publish: createWikiPublishApi({ http, errors: errorFactory, epoch }),
      artifact: createArtifactApi({ http, errors: errorFactory, epoch, collaborators }),
    },
    connections: {
      grants: createClientGrantApi(http, errorFactory, epoch, { now: ports.now }, { mint: ports.mint }),
      providers: createProviderKeyApi(http, errorFactory, epoch),
      modelUse: createProviderModelUseApi(http, errorFactory, epoch, models),
      google: createGoogleOAuthApi(http, errorFactory, epoch, { mint: ports.mint }),
      diagnostic: createMcpDiagnosticApi(http, errorFactory, epoch, isWorkspaceRequestError),
      models, configuration: createResearchConfigurationApi(http, errorFactory, epoch),
    },
    sources: {
      namespaces: createNamespacesApi({ request: http.requestApiWithStatuses, errors: errorFactory, epoch }),
      imports: {
        raw: createRawFileApi(binary, http, { digest: ports.sha256 }, errorFactory, epoch, isWorkspaceRequestError),
        input: createBundleInputApi({ digest: ports.sha256, readText(bytes) {
          try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
        } }, errorFactory),
        wire: bundleWire,
        bundle: createBundleImportApi(bundleWire, errorFactory, epoch, { now: ports.now }, isWorkspaceRequestError),
      },
      projects: createProjectsApi(http, errorFactory, epoch),
      library: createLibraryApi(http, errorFactory, epoch),
      readiness: createReadinessApi(http, errorFactory, epoch),
      revisions: createRevisionApi(http, errorFactory, epoch),
      reader: createReaderApi({ http, errors: errorFactory, epoch, sha256: ports.sha256 }),
      erasure: createErasureOperations({ http, epoch, isRequestError: isWorkspaceRequestError,
        fail: details => errorFactory({ ...details, traceId: null, retryable: details.retryable ?? false }) }),
      mintIntent: ports.mint,
    },
    dispose() { projection.dispose(); http.dispose(); binary.dispose(); },
  };
}

/** One root owns transport lifetime. Query is the only remote-data store. */
export function createWorkspaceRuntime(ports: WorkspaceRuntimePorts) {
  const epoch = createSessionEpoch();
  epoch.close();
  let current: { context: SessionContext; apis: BoundWorkspaceApis } | undefined;
  let disposed = false;
  return {
    async verify(signal: AbortSignal): Promise<SessionVerification | undefined> {
      if (disposed || signal.aborted) return undefined;
      // Bootstrap denial must not recursively invalidate privacy's verification attempt.
      const probeEpoch = createSessionEpoch();
      const probeHttp = createLegacyHttpAdapter({ fetch: ports.fetch, baseUrl: ports.baseUrl, timers: ports.timers, epoch: probeEpoch }, errorFactory);
      try {
        const health = await createHealthApi(probeHttp, errorFactory, probeEpoch).getSystemHealth(signal);
        if (disposed || signal.aborted) return undefined;
        const sessions = createOwnerSessionApi(probeHttp, errorFactory, probeEpoch, { now: ports.now });
        const session = await sessions.readOwnerSession(health.deployment_generation, signal);
        if (disposed || signal.aborted || session.client_class !== 'owner_pwa' || !sessions.isOwnerSessionUnexpired(session)) return undefined;
        return {
          principal: session.principal_ref, credentialGeneration: session.credential_generation,
          deploymentGeneration: health.deployment_generation, expiresAt: session.expires_at,
        };
      } catch { return undefined; }
      finally { probeEpoch.dispose(); probeHttp.dispose(); }
    },
    bind(context: SessionContext) {
      if (disposed || !ports.isCurrent(context)) return;
      if (current?.context === context) return;
      epoch.close(); current?.apis.dispose(); epoch.advance();
      current = { context, apis: createBoundApis(ports, epoch) };
    },
    read(context: SessionContext): BoundWorkspaceApis | undefined {
      return !disposed && ports.isCurrent(context) && current?.context === context ? current.apis : undefined;
    },
    close() { epoch.close(); current?.apis.dispose(); current = undefined; },
    dispose() { disposed = true; epoch.dispose(); current?.apis.dispose(); current = undefined; },
  };
}
export type WorkspaceRuntime = ReturnType<typeof createWorkspaceRuntime>;
