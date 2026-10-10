/**
 * U4 report and evidence query options, app/query scope.
 *
 * Services come from BoundWorkspaceApis.evidence, which runtime.ts already composes: manifest,
 * sections, citations, reauthorization and bytes. No factory is constructed here, no endpoint or
 * decoder is invented, and every return type is the decoded type the accepted client returns.
 *
 * Access modes are separate. Author reads use the author builders. Reauthorized reads use the
 * reauthorized builders and only ever run for a captured reauthorization view, which the root
 * obtains explicitly on a typed 404 ARTIFACT_DRAFT_READ_NOT_FOUND. There is no automatic
 * fallback, so a non-author never silently reaches author-only surface.
 *
 * Reads only. No mutation, no export sink, no direct HTTP, no cache invalidation.
 */

import type { QueryFunction } from "@tanstack/react-query";
import type {
  ArtifactRevision,
  CitedEvidence,
  DeclaredSection,
  EvidenceBytesApi,
  ManifestApi,
  ReauthorizationApi,
  ReauthorizedCitedEvidence,
  ResearchArtifactDraftReauthorizationView,
  SectionApi,
  VersionedRef,
} from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import type { BoundWorkspaceApis } from "../app/runtime";
import { protectedQueryKey, runProtectedRead } from "./client";

type ManifestRead = ManifestApi["readResearchArtifact"];
type SectionRead = SectionApi["readResearchArtifactSection"];
type CitationsRead = BoundWorkspaceApis["evidence"]["citations"]["readSectionCitations"];
type ManifestView = Awaited<ReturnType<ManifestRead>>;
type SectionResponse = Awaited<ReturnType<SectionRead>>;
type SectionCitationsView = Awaited<ReturnType<CitationsRead>>;
type ReauthorizationRead = ReauthorizationApi["readReauthorizedSectionCitations"];
type ReauthorizedCitations = Awaited<ReturnType<ReauthorizationRead>>;

interface ReadQuery<T> {
  readonly queryKey: readonly (string | number)[];
  readonly queryFn: QueryFunction<T, readonly (string | number)[]>;
  readonly refetchOnMount: false;
}

const refKey = (ref: VersionedRef): string => `${ref.id}:${ref.revision}`;

const sameRef = (left: VersionedRef, right: VersionedRef): boolean =>
  left.id === right.id && left.revision === right.revision;

const sameSection = (declared: DeclaredSection, artifact: ArtifactRevision): boolean => {
  const row = artifact.sections.find(section => sameRef(section.section_ref, declared.section_ref));
  return row !== undefined && row.body_object_ref === declared.body_object_ref && row.body_sha256 === declared.body_sha256;
};

export function reportQueryOptions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  currentManifest: () => ArtifactRevision | undefined,
) {
  const { manifest: manifestApi, sections: sectionApi, citations: citationApi, reauthorization, bytes } = apis.evidence;
  const generation = context.deploymentGeneration;
  const key = protectedQueryKey(context, "reports");

  /** Reference equality, not value equality, so a refetched twin is refused as stale. */
  const current = (artifact: ArtifactRevision): void => {
    if (currentManifest() !== artifact) throw new Error("Artifact manifest is no longer the current manifest");
  };

  function readWith<T>(parts: readonly (string | number)[], read: (signal: AbortSignal) => Promise<T>): ReadQuery<T> {
    return {
      queryKey: [...key, ...parts],
      refetchOnMount: false,
      queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, read),
    };
  }

  function artifactScoped<T>(
    mode: string,
    artifact: ArtifactRevision,
    parts: readonly (string | number)[],
    read: (signal: AbortSignal) => Promise<T>,
  ): ReadQuery<T> {
    return {
      queryKey: [...key, mode, refKey(artifact.artifact_ref), ...parts],
      refetchOnMount: false,
      queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
        current(artifact);
        const result = await read(readSignal);
        current(artifact);
        return result;
      }),
    };
  }

  return {
    manifest(artifactRef: VersionedRef): ReadQuery<ManifestView> {
      return readWith(["author", "manifest", refKey(artifactRef)], signal =>
        manifestApi.readResearchArtifact(artifactRef, { expectedDeploymentGeneration: generation, signal }));
    },

    reauthorizedManifest(artifactRef: VersionedRef): ReadQuery<Awaited<ReturnType<ManifestApi["readReauthorizedResearchArtifact"]>>> {
      return readWith(["reauthorized", "manifest", refKey(artifactRef)], signal =>
        manifestApi.readReauthorizedResearchArtifact(artifactRef, { expectedDeploymentGeneration: generation, signal }));
    },

    section(artifact: ArtifactRevision, declared: DeclaredSection): ReadQuery<SectionResponse> {
      if (!sameSection(declared, artifact)) throw new Error("Declared section is not part of this artifact");
      return artifactScoped("author", artifact, [
        "section", refKey(declared.section_ref), declared.body_object_ref, declared.body_sha256,
      ], signal => sectionApi.readResearchArtifactSection(artifact.artifact_ref, declared, {
        expectedDeploymentGeneration: generation, signal,
      }));
    },

    citations(artifact: ArtifactRevision, declared: DeclaredSection): ReadQuery<SectionCitationsView> {
      if (!sameSection(declared, artifact)) throw new Error("Declared section is not part of this artifact");
      return artifactScoped("author", artifact, [
        "citations", refKey(declared.section_ref), declared.body_object_ref, declared.body_sha256,
      ], signal => citationApi.readSectionCitations(
        artifact.artifact_ref, declared.section_ref, generation, signal,
        artifact.sections.find(section => sameRef(section.section_ref, declared.section_ref))?.verification_receipt_ref,
      ));
    },

    /**
     * Reauthorized section bytes. The captured view names the original saved scope and the
     * authorization scope it was captured under, so both ride the key as a namespace.
     *
     * The server refreshes authorization on its own for this call, so the response may name
     * a different authorization scope than the captured view. That is expected and is not
     * asserted here. The decoded body is returned as served.
     */
    reauthorizedSection(
      view: ResearchArtifactDraftReauthorizationView,
      declared: DeclaredSection,
    ): ReadQuery<SectionResponse> {
      const artifact = view.artifact;
      if (!sameSection(declared, artifact)) throw new Error("Declared section is not part of this artifact");
      return artifactScoped("reauthorized", artifact, [
        "section", refKey(declared.section_ref), declared.body_object_ref, declared.body_sha256,
        refKey(view.original_scope_snapshot_ref), refKey(view.authorization_scope_snapshot_ref),
        view.authorization.authorization_receipt_ref, view.authorization.expires_at,
      ], signal => sectionApi.readReauthorizedResearchArtifactSection(view.artifact_ref, declared, {
        expectedDeploymentGeneration: generation, signal,
      }));
    },

    /**
     * Reauthorized citations for a captured reauthorization view.
     *
     * The server reauthorizes independently for every request, so a valid response may carry a
     * different authorization scope, receipt and expiry than the captured view. Only the stable
     * identity is asserted here: artifact, section, verification receipt and the original saved
     * scope. The response keeps its own authorization fields, and the root uses those fresh values
     * for any evidence read. Nothing is merged or inferred across the two grants.
     */
    reauthorizedCitations(
      view: ResearchArtifactDraftReauthorizationView,
      declared: DeclaredSection,
    ): ReadQuery<ReauthorizedCitations> {
      const artifact = view.artifact;
      if (!sameSection(declared, artifact)) throw new Error("Declared section is not part of this artifact");
      const receipt = artifact.sections.find(section => sameRef(section.section_ref, declared.section_ref))
        ?.verification_receipt_ref;
      return artifactScoped("reauthorized", artifact, [
        "citations", refKey(declared.section_ref), declared.body_object_ref, declared.body_sha256,
        refKey(view.original_scope_snapshot_ref), refKey(view.authorization_scope_snapshot_ref),
        view.authorization.authorization_receipt_ref, view.authorization.expires_at,
      ], async signal => {
        const result = await reauthorization.readReauthorizedSectionCitations(
          view.artifact_ref, declared.section_ref, generation, signal, receipt,
        );
        if (!sameRef(result.artifact_ref, view.artifact_ref)) {
          throw new Error("Reauthorized citations describe a different artifact");
        }
        if (!sameRef(result.section_ref, declared.section_ref)) {
          throw new Error("Reauthorized citations describe a different section");
        }
        if (!sameRef(result.original_scope_snapshot_ref, view.original_scope_snapshot_ref)) {
          throw new Error("Reauthorized citations changed the original saved scope");
        }
        if (result.deployment_generation !== generation) {
          throw new Error("Reauthorized citations belong to a different deployment generation");
        }
        return result;
      });
    },

    /**
     * Evidence read. The scope snapshot is whatever the caller holds, which for a non-author is
     * the authorization scope snapshot of the captured view. The returned excerpt digest must equal
     * the cited digest, otherwise the value is refused rather than cached as proof.
     */
    evidence(scopeSnapshotRef: VersionedRef, citation: CitedEvidence | ReauthorizedCitedEvidence): ReadQuery<Awaited<ReturnType<EvidenceBytesApi["verifyAndOpenEvidence"]>>> {
      const handleRef = citation.handle_ref;
      return {
        queryKey: [...key, "evidence", refKey(scopeSnapshotRef), refKey(handleRef), citation.excerpt_sha256],
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
          const result = await bytes.verifyAndOpenEvidence(scopeSnapshotRef, handleRef, readSignal);
          if (result.excerptSha256 !== citation.excerpt_sha256) {
            throw new Error("Opened evidence digest differs from the cited excerpt digest");
          }
          if (!sameRef(result.handleRef, handleRef)) {
            throw new Error("Opened evidence handle differs from the cited handle");
          }
          return result;
        }),
      };
    },
  };
}

export type ReportQueryOptions = ReturnType<typeof reportQueryOptions>;
