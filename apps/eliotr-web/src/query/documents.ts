import { queryOptions } from "@tanstack/react-query";
import type { createReaderApi, LibraryPage, SourceRevisionPage } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

export interface DocumentQueryCurrentPages {
  readonly library: () => LibraryPage | undefined;
  readonly revisions: () => SourceRevisionPage | undefined;
}

/** Only a revision explicitly present in the current Query authority can admit a reader result. */
export function documentQueryOptions(
  reader: ReturnType<typeof createReaderApi>, privacy: PrivacyController, context: SessionContext,
  current: DocumentQueryCurrentPages, library: LibraryPage, revisions: SourceRevisionPage,
  sourceId: string, sourceRevisionRef: string,
) {
  const assertCurrent = () => {
    if (current.library() !== library || library.generation !== context.deploymentGeneration ||
        !library.sources.some(source => source.id === sourceId) || current.revisions() !== revisions ||
        revisions.generation !== context.deploymentGeneration || revisions.source_id !== sourceId) {
      throw new Error("Document selection is no longer in the current source page");
    }
    const revision = revisions.revisions.find(row => row.source_revision_ref === sourceRevisionRef);
    if (!revision) throw new Error("Document revision is not in the current revision page");
    return revision;
  };
  return queryOptions({
    queryKey: [...protectedQueryKey(context, "sources"), "document", sourceId, sourceRevisionRef],
    queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
      assertCurrent();
      const document = await reader.readAdmittedDocument(sourceRevisionRef, context.deploymentGeneration, readSignal);
      const revision = assertCurrent();
      if (document.sourceRevisionRef !== sourceRevisionRef || document.deploymentGeneration !== context.deploymentGeneration ||
          document.contentSha256 !== revision.content_sha256) {
        throw new Error("Document bytes do not match the selected admitted revision");
      }
      return document;
    }),
  });
}
