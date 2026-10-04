import { OrientationError, readOrientationRequest } from "@eliotr/cloudflare-navigation";
import type {
  ApplicationLifecycle,
  AuthenticatedRequestContext,
  QueryRequest,
  RawMarkdownConversionRequest,
  RouteDefinition,
} from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { CapabilityUnavailableError } from "./composition-root.js";
import {
  EvidenceHttpInputError,
  parseEvidenceHandleRef,
  parseEvidenceOpenRange,
  parseVerifyEvidenceRequest,
} from "@eliotr/cloudflare-evidence";
import {
  ArtifactHttpInputError,
  parseArtifactRef,
  parseArtifactSectionRef,
} from "@eliotr/interfaces";
import { readAcceptArtifactRequest, readReviseArtifactSectionRequest } from "./artifact-product-http.js";
import { reviseOwnerArtifactSection } from "./artifact-section-revise.js";
import { readOwnerArtifactCurrentPublication } from "./artifact-product-composition.js";
import { dispatchIngestOperation } from "./ingest-http.js";
import { dispatchRawCaptureOperation } from "@eliotr/cloudflare-raw-ingest";
import { dispatchFederationHttp } from "./federation-http.js";
import { readRawMarkdownConversionRequest } from "@eliotr/cloudflare-markdown";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { parseExhaustiveWorkflowJobsRequest } from "./research-query-http.js";
import { readOwnerErasurePreparation, readOwnerErasureRequest, readOwnerErasureRef } from "./erasure-owner-http.js";
import { readOwnerNamespaceInitialization, readOwnerNamespaceRenewal } from "./source-namespace-owner-http.js";
import { readWorkspaceCandidateRequest, readWorkspaceAdmissionId } from "./workspace-owner-http.js";
import { readNavigationExpansionRequest } from "./navigation-expand-http.js";
import { HttpRequestError } from "./http-errors.js";
import { readOwnerProjectResearchReadiness } from "./research-project-configuration-composition.js";
import { parseWikiProposalFromResearchRunRequest, parseWikiProposalRef } from "./wiki-service.js";
import {
  reopenOwnerArtifactDraft,
  reopenOwnerArtifactSection,
  reopenOwnerArtifactSectionCitations,
} from "./research-artifact-reauthorization-http.js";
import { apiResult, problem, requireNoQuery } from "./http-response.js";
import {
  namespaceIdentifier,
  parseCatalogRequest,
  parseProjectListRequest,
  parseSourceRevisionsRequest,
  projectIdentifier,
  readCreateProjectRequest,
  readUpdateProjectRequest,
  requireEmptyRequestBody,
  singleQueryValue,
} from "./http-route-inputs.js";
export interface HttpRouteMatch {
  readonly route: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}
async function requireApplicationReady(
  request: Request,
  application: ApplicationLifecycle,
): Promise<Response | null> {
  const readiness = await application.readiness();
  if (readiness.ready) return null;
  return problem(
    request,
    503,
    "SCHEMA_NOT_READY",
    "Required D1 migrations are not applied",
    true,
  );
}
export async function dispatchHttpApiRoute(
  request: Request,
  env: Env,
  application: ApplicationLifecycle,
  context: AuthenticatedRequestContext,
  match: HttpRouteMatch,
  url: URL,
): Promise<Response> {
  const requiresReadiness = match.route.operation !== "system.health" &&
    match.route.operation !== "system.capabilities" &&
    match.route.operation !== "system.research.configuration";
  if (requiresReadiness) {
    const blocked = await requireApplicationReady(request, application);
    if (blocked !== null) return blocked;
  }
  switch (match.route.operation) {
    case "system.health":
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.systemHealth(context));
    case "system.capabilities":
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.systemCapabilities(context));
    case "system.research.configuration": {
      for (const key of url.searchParams.keys()) {
        if (key !== "project_id") throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400,
          "Research configuration query contains an unknown parameter");
      }
      return apiResult(request, env, await readOwnerProjectResearchReadiness(env, context,
        singleQueryValue(url, "project_id")));
    }
    case "library.source.content": {
      for (const key of url.searchParams.keys()) {
        if (key !== "source_revision_ref") {
          throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "Document query contains an unknown parameter");
        }
      }
      const revision = singleQueryValue(url, "source_revision_ref");
      if (revision === undefined) throw new HttpRequestError("DOCUMENT_INPUT_INVALID", 400, "A source revision is required");
      return application.services.owner.sourceContent(context, revision);
    }
    case "library.source.revisions": {
      return apiResult(request, env, await application.services.owner.sourceRevisions(context, parseSourceRevisionsRequest(url)));
    }
    case "library.namespaces.list": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.sourceNamespaces(context));
    }
    case "library.namespaces.initialize": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.initializeSourceNamespace(context,
        await readOwnerNamespaceInitialization(request, match.route.maximum_request_bytes)));
    }
    case "library.namespaces.renew": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.renewSourceNamespace(
        context,
        namespaceIdentifier(match.params.namespace_id),
        await readOwnerNamespaceRenewal(request, match.route.maximum_request_bytes),
      ));
    }
    case "library.erasure.prepare": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.prepareErasure(context,
        await readOwnerErasurePreparation(request, match.route.maximum_request_bytes)));
    }
    case "library.erasure.execute": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.erase(context,
        await readOwnerErasureRequest(request, match.route.maximum_request_bytes)));
    }
    case "workspace.admission": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.admitWorkspaceCandidate(context,
        await readWorkspaceCandidateRequest(request, match.route.maximum_request_bytes)));
    }
    case "workspace.admission.status": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.workspaceCandidateStatus(context,
        readWorkspaceAdmissionId(match.params.capture_id), readWorkspaceAdmissionId(match.params.admission_operation_id)));
    }
    case "library.erasure.status": {
      requireNoQuery(url);
      const status = await application.services.owner.erasureStatus(context, readOwnerErasureRef(match.params));
      if (status === null) throw new HttpRequestError("ERASURE_NOT_FOUND", 404, "Erasure operation is not available");
      return apiResult(request, env, status);
    }
    case "library.active.readiness": {
      const sourceId = singleQueryValue(url, "source_id");
      if (sourceId === undefined || [...url.searchParams.keys()].some((key) => key !== "source_id")) {
        throw new HttpRequestError("LIBRARY_READINESS_INPUT_INVALID", 400, "exactly one source_id is required");
      }
      return apiResult(request, env, await application.services.owner.libraryReadiness(context, { source_id: sourceId }));
    }
    case "research.catalog": {
      return apiResult(
        request,
        env,
        await application.services.semantic.catalog(context, parseCatalogRequest(url)),
      );
    }
    case "research.projects.list": {
      await requireEmptyRequestBody(request, "Project listing does not accept a request body");
      return apiResult(request, env, await application.services.owner.listProjects(context, parseProjectListRequest(url)));
    }
    case "research.projects.create": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.createProject(
        context,
        await readCreateProjectRequest(request, match.route.maximum_request_bytes),
      ), 201);
    }
    case "research.projects.update": {
      requireNoQuery(url);
      const projectId = match.params.project_id;
      if (projectId === undefined) throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "project id is missing");
      return apiResult(request, env, await application.services.owner.updateProject(
        context,
        projectIdentifier(projectId, "project id"),
        await readUpdateProjectRequest(request, match.route.maximum_request_bytes),
      ));
    }
    case "research.orient": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.semantic.orient(context,
        await readOrientationRequest(request, match.route.maximum_request_bytes)));
    }
    case "research.navigation.expand": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.semantic.expandNavigation(context,
        await readNavigationExpansionRequest(request, match.route.maximum_request_bytes)));
    }
    case "research.trace": {
      requireNoQuery(url);
      const ref = match.params.ref;
      if (ref === undefined) throw new OrientationError("ORIENTATION_TRACE_INVALID", 400);
      return apiResult(request, env, await application.services.semantic.trace(context, { id: ref, revision: 1 }));
    }
    case "research.artifact.reauthorize":
    case "research.artifact.section.reauthorize": {
      requireNoQuery(url);
      await requireEmptyRequestBody(request, "Report reauthorization does not accept a request body");
      const ref = match.params.ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      const artifactRef = parseArtifactRef(ref);
      if (match.route.operation === "research.artifact.section.reauthorize") {
        const sectionRef = match.params.section_ref;
        if (sectionRef === undefined) throw new ArtifactHttpInputError("section reference path parameter is missing");
        return reopenOwnerArtifactSection(env, context, artifactRef, parseArtifactSectionRef(sectionRef));
      }
      return apiResult(request, env, await reopenOwnerArtifactDraft(env, context, artifactRef));
    }
    case "research.artifact.section.citations.reauthorize": {
      requireNoQuery(url);
      await requireEmptyRequestBody(request, "Citation reauthorization does not accept a request body");
      const ref = match.params.ref;
      const sectionRef = match.params.section_ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      if (sectionRef === undefined) throw new ArtifactHttpInputError("section reference path parameter is missing");
      return apiResult(request, env, await reopenOwnerArtifactSectionCitations(
        env, context, parseArtifactRef(ref), parseArtifactSectionRef(sectionRef),
      ));
    }
    case "research.artifact": {
      requireNoQuery(url);
      const ref = match.params.ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      return apiResult(request, env, await application.services.semantic.artifact(context, parseArtifactRef(ref)));
    }
    case "research.artifact.section.revise": {
      requireNoQuery(url);
      const ref = match.params.ref;
      const sectionId = match.params.section_id;
      if (ref === undefined || sectionId === undefined) throw new ArtifactHttpInputError("artifact or section identity is missing");
      const result = await reviseOwnerArtifactSection(env, context,
        await readReviseArtifactSectionRequest(request, ref, sectionId, match.route.maximum_request_bytes));
      return apiResult(request, env, result, result.disposition === "CREATED" ? 201 : 200);
    }
    case "research.artifact.accept": {
      requireNoQuery(url);
      const ref = match.params.ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      const result = await application.services.semantic.acceptArtifact(
        context,
        await readAcceptArtifactRequest(request, ref, match.route.maximum_request_bytes),
      );
      return apiResult(request, env, result, result.disposition === "CREATED" ? 201 : 200);
    }
    case "research.artifact.publication.current": {
      requireNoQuery(url);
      await requireEmptyRequestBody(request, "Artifact publication read does not accept a request body");
      const ref = match.params.ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      return apiResult(request, env, await readOwnerArtifactCurrentPublication(env, context, parseArtifactRef(ref)));
    }
    case "research.artifact.publication": {
      requireNoQuery(url);
      await requireEmptyRequestBody(request, "Artifact publication read does not accept a request body");
      const ref = match.params.ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      return apiResult(request, env, await application.services.semantic.artifactPublication(context, parseArtifactRef(ref)));
    }
    case "research.artifact.section":
    case "research.artifact.section.citations": {
      requireNoQuery(url);
      const ref = match.params.ref;
      const sectionRef = match.params.section_ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      if (sectionRef === undefined) throw new ArtifactHttpInputError("section reference path parameter is missing");
      if (match.route.operation === "research.artifact.section.citations") {
        return apiResult(request, env, await application.services.semantic.artifactSectionCitations(
          context, parseArtifactRef(ref), parseArtifactSectionRef(sectionRef)));
      }
      return application.services.semantic.artifactSection(context, parseArtifactRef(ref), parseArtifactSectionRef(sectionRef));
    }
    case "research.wiki.propose": {
      requireNoQuery(url);
      return apiResult(
        request,
        env,
        await application.services.semantic.proposeWiki(
          context,
          await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes),
        ),
      );
    }
    case "research.wiki.propose.from-run": {
      requireNoQuery(url);
      const operationId = parseWikiProposalFromResearchRunRequest(
        await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes),
      );
      return apiResult(
        request,
        env,
        await application.services.semantic.proposeWikiFromResearchRun(context, operationId),
      );
    }
    case "research.wiki.propose.from-edit": {
      requireNoQuery(url);
      return apiResult(
        request,
        env,
        await application.services.semantic.proposeWikiFromOwnerEdit(
          context,
          await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes),
        ),
      );
    }
    case "research.wiki.publish": {
      requireNoQuery(url);
      return apiResult(
        request,
        env,
        await application.services.semantic.publishWiki(
          context,
          await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes),
        ),
      );
    }
    case "research.wiki.proposal.list": {
      requireNoQuery(url);
      await requireEmptyRequestBody(request, "Wiki proposal listing does not accept a request body");
      return apiResult(request, env, await application.services.semantic.listWikiProposals(context));
    }
    case "research.wiki.proposal.read": {
      requireNoQuery(url);
      await requireEmptyRequestBody(request, "Wiki proposal reading does not accept a request body");
      const ref = match.params.ref;
      if (ref === undefined) throw new HttpRequestError("WIKI_INPUT_INVALID", 400, "Wiki proposal reference is missing");
      return apiResult(request, env, await application.services.semantic.readWikiProposal(context, parseWikiProposalRef(ref)));
    }
    case "research.wiki.proposal.body": {
      requireNoQuery(url);
      await requireEmptyRequestBody(request, "Wiki proposal body reading does not accept a request body");
      const ref = match.params.ref;
      if (ref === undefined) throw new HttpRequestError("WIKI_INPUT_INVALID", 400, "Wiki proposal reference is missing");
      const response = await application.services.semantic.readWikiProposalBody(context, parseWikiProposalRef(ref));
      response.headers.set("x-eliotr-deployment-generation", env.DEPLOYMENT_GENERATION);
      return response;
    }
    case "research.verify": {
      return apiResult(
        request,
        env,
        await application.services.semantic.verify(
          context,
          await parseVerifyEvidenceRequest(request, match.route.maximum_request_bytes),
        ),
      );
    }
    case "research.open": {
      const ref = match.params.ref;
      if (ref === undefined) throw new EvidenceHttpInputError(
        "EVIDENCE_HANDLE_REF_INVALID",
        400,
        "evidence handle path parameter is missing",
      );
      return application.services.semantic.open(
        context,
        parseEvidenceHandleRef(ref),
        parseEvidenceOpenRange(url),
      );
    }
    default:
      if (match.route.operation === "ingest.raw.markdown") {
        const captureId = match.params.capture_id;
        if (captureId === undefined) throw new HttpRequestError("RAW_MARKDOWN_INPUT_INVALID", 400, "capture id is missing");
        requireNoQuery(url); const parsed = await readRawMarkdownConversionRequest(request, match.route.maximum_request_bytes); if (parsed === null) throw new HttpRequestError("RAW_MARKDOWN_INPUT_INVALID", 400, "conversion request is invalid");
        return apiResult(request, env, await application.services.owner.convertRawFileToMarkdown(context, captureId, parsed as unknown as RawMarkdownConversionRequest));
      }
      if (match.route.operation === "ingest.raw.capture" || match.route.operation === "ingest.raw.read") return apiResult(request, env, await dispatchRawCaptureOperation(match.route.operation, request, url, match.params.capture_id, match.route.maximum_request_bytes, context, application.services.owner));
      if (match.route.operation.startsWith("ingest.")) {
        return apiResult(
          request,
          env,
          await dispatchIngestOperation(
            match.route.operation,
            request,
            url,
            match.params,
            match.route.maximum_request_bytes,
            context,
            application.services.owner,
          ),
        );
      }
      {
        const federation = await dispatchFederationHttp(
          request,
          env,
          context,
          {
            operation: match.route.operation,
            maximum_request_bytes: match.route.maximum_request_bytes,
            params: match.params,
          },
          url,
          application.services.federation,
        );
        if (federation !== null) {
          return federation.kind === "response"
            ? federation.response
            : apiResult(request, env, federation.body, federation.status);
        }
        if (match.route.operation === "research.query") {
          if (match.route.path === "/api/v1/research/query/jobs") {
            return apiResult(request, env, await application.services.semantic.queryJobs(
              context,
              parseExhaustiveWorkflowJobsRequest(url),
            ));
          }
          requireNoQuery(url);
          const workflowId = match.params.workflow_id;
          if (workflowId !== undefined && match.route.method === "GET") {
            return apiResult(request, env, await application.services.semantic.queryStatus(context, workflowId));
          }
          if (workflowId !== undefined && match.route.method === "DELETE") {
            return apiResult(request, env, await application.services.semantic.queryCancel(context, workflowId));
          }
          const data = await application.services.semantic.query(context, await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes) as QueryRequest);
          return apiResult(request, env, data, data && typeof data === "object" &&
            "workflow_instance_id" in data && !Object.hasOwn(data, "job") ? 202 : 200);
        }
        if (match.route.operation === "research.run.cancel" || match.route.operation === "research.run.recover") {
          requireNoQuery(url);
          const workflowId = match.params.workflow_id;
          if (workflowId === undefined) throw new HttpRequestError("RESEARCH_RUN_ID_INVALID", 400, "workflow id is missing");
          const body = await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes);
          return apiResult(request, env, match.route.operation === "research.run.cancel"
            ? await application.services.semantic.runCancel(context, workflowId, body)
            : await application.services.semantic.runRecover(context, workflowId, body));
        }
        if (match.route.operation === "research.run") {
          requireNoQuery(url);
          if (request.method === "GET") {
            const workflowId = match.params.workflow_id;
            if (workflowId === undefined) throw new HttpRequestError("RESEARCH_RUN_ID_INVALID", 400, "workflow id is missing");
            return apiResult(request, env, await application.services.semantic.runStatus(context, workflowId));
          }
          return apiResult(request, env, await application.services.semantic.run(context, await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes) as QueryRequest));
        }
        throw new CapabilityUnavailableError(match.route.operation);
      }
  }
}
