import {
  createD1ScopeService,
  createOwnerScopeAuthority,
  createNavigationService,
} from "@eliotr/cloudflare-navigation";
import {
  createD1NavigationStore,
  readAdmittedNormalizedManifest,
  readAdmittedNormalizedMarkdown,
  type D1NavigationStore,
} from "@eliotr/cloudflare-evidence";
import type {
  AuthenticatedRequestContext,
  NavigationExpansionApi,
  NavigationExpansionRequest,
  NavigationExpansionResult,
} from "@eliotr/interfaces";
import {
  materializeStructuralNavigation,
  parseDocumentMapArtifact,
  parseNavigationScopeSnapshot,
  type NavigationStore,
} from "@eliotr/retrieval";
import { CatalogInputError } from "./catalog-service.js";

export interface NavigationExpandEnvironment {
  readonly CORE_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") {
    throw new CatalogInputError(
      "NAVIGATION_OWNER_REQUIRED",
      "Corpus Lens expansion requires an owner session",
      403,
    );
  }
}

const STRUCTURAL_GENERATION = "structural-navigation-v1";

/**
 * Read structural navigation from the already admitted normalized object when
 * the durable orientation row is metadata-only. The D1 store remains the
 * currentness and owner-authority gate; this adapter only supplies the
 * immutable map read that NavigationService.expand consumes.
 */
function createStructuralReadStore(
  persisted: D1NavigationStore,
  authority: ReturnType<typeof createOwnerScopeAuthority>,
  scope: Parameters<D1NavigationStore["requireCurrentScopeSnapshot"]>[0],
  evidenceBucket: R2Bucket,
): NavigationStore {
  async function derive(sourceRevisionRef: string) {
    await persisted.requireCurrentScopeSnapshot(scope);
    const [source] = await authority.sources([sourceRevisionRef]);
    if (source === undefined) {
      throw new CatalogInputError("NAVIGATION_SOURCE_NOT_FOUND", "navigation source is unavailable", 404);
    }
    const manifest = await readAdmittedNormalizedManifest(evidenceBucket, source.authority);
    const content = await readAdmittedNormalizedMarkdown(evidenceBucket, source.authority);
    if (manifest.content_size !== content.size_bytes) {
      throw new CatalogInputError(
        "NAVIGATION_SOURCE_MISMATCH",
        "admitted normalized manifest and content sizes disagree",
        409,
      );
    }
    const result = await materializeStructuralNavigation({
      source_revision: source.revision,
      scope_snapshot: scope,
      normalized_markdown: content.markdown,
      source_kind: source.kind,
      generator_generation: STRUCTURAL_GENERATION,
      created_at: scope.created_at,
    });
    await persisted.requireCurrentScopeSnapshot(scope);
    return result.documentMap;
  }

  return {
    ...persisted,
    async getDocumentMaps(sourceRevisionRefs) {
      // Read the durable slot first so its owner/scope/source checks remain in
      // force, then derive from the exact admitted bytes rather than trusting
      // a metadata-only map body.
      const stored = await persisted.getDocumentMaps(sourceRevisionRefs);
      const mapsBySource = new Map<string, ReturnType<typeof parseDocumentMapArtifact>>();
      for (const raw of stored) {
        const map = parseDocumentMapArtifact(raw);
        if (mapsBySource.has(map.source_revision_ref)) {
          throw new CatalogInputError("NAVIGATION_ARTIFACT_INVALID", "navigation returned duplicate document maps", 409);
        }
        mapsBySource.set(map.source_revision_ref, map);
      }
      return Promise.all(sourceRevisionRefs.map(async (ref) => {
        const map = mapsBySource.get(ref);
        // A persisted structural map is authoritative. Only the metadata-only
        // slot (or a missing slot) needs a read-time structural derivation.
        return map !== undefined && map.section_hierarchy.length > 0 ? map : derive(ref);
      }));
    },
  };
}

/**
 * App-layer bridge for the existing D1-backed NavigationService. It performs
 * no writes and derives all currentness checks from the authenticated owner
 * and the persisted scope authority.
 */
export function createNavigationExpandService(
  env: NavigationExpandEnvironment,
  now: () => number = Date.now,
): NavigationExpansionApi {
  return {
    async expand(
      context: AuthenticatedRequestContext,
      request: NavigationExpansionRequest,
    ): Promise<NavigationExpansionResult> {
      requireOwner(context);
      const scope = parseNavigationScopeSnapshot(request.scope_snapshot);
      const authority = createOwnerScopeAuthority(env.CORE_DB, context, now);
      const scopes = createD1ScopeService(env.CORE_DB, authority, { now });
      const persisted = createD1NavigationStore({
        database: env.CORE_DB,
        scope_snapshot: scope,
        access: {
          principal_ref: context.principal_ref,
          client_class: context.client_class,
          credential_generation: context.credential_generation,
        },
        require_current: (requested) => scopes.requireCurrent(requested),
        now,
      });
      const navigation = createNavigationService(
        createStructuralReadStore(persisted, authority, scope, env.EVIDENCE_BUCKET),
      );
      return navigation.expand({ ...request, scope_snapshot: scope });
    },
  };
}
