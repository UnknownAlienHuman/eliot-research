import type { AllowedReferenceManifest } from "@eliotr/contracts";
import {
  assertSameFederationManifest,
  federationClockTimestamp,
  federationMutationChangedExactlyOne,
  federationVersionedRef,
  parseFederationManifest,
  readFederationManifest,
} from "./d1-federation-codec.js";
import type {
  D1FederationAuthorityDependencies,
  D1FederationReferenceManifestAuthority,
} from "./d1-federation-types.js";
import {
  FederationD1AuthorityError,
  federationD1Fail,
} from "./d1-federation-types.js";
import { canonicalJson } from "./ingest-validation.js";

export function createD1FederationReferenceManifestAuthority(
  database: D1Database,
  dependencies: D1FederationAuthorityDependencies = {},
): D1FederationReferenceManifestAuthority {
  const clock = dependencies.now ?? Date.now;
  return {
    async get(rawRef) {
      return readFederationManifest(
        database,
        federationVersionedRef(rawRef, "federation manifest ref"),
      );
    },

    async put(rawManifest) {
      const manifest = await parseFederationManifest(rawManifest, "federation manifest");
      const prior = await readFederationManifest(database, manifest.manifest_ref);
      if (prior !== null) {
        assertSameFederationManifest(prior, manifest);
        return { disposition: "EXISTING", manifest: prior };
      }
      const created = federationClockTimestamp(clock);
      if (Date.parse(manifest.expires_at) <= created.epoch) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "cannot persist a newly expired federation manifest",
        );
      }
      const manifestJson = canonicalJson(manifest);
      try {
        const result = await database.prepare(
          "INSERT INTO federation_reference_manifest(" +
          "manifest_id, revision, manifest_json, manifest_digest, scope_snapshot_id, " +
          "scope_snapshot_revision, client_fence_ref, expires_at, created_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        ).bind(
          manifest.manifest_ref.id,
          manifest.manifest_ref.revision,
          manifestJson,
          manifest.manifest_digest,
          manifest.scope_snapshot_ref.id,
          manifest.scope_snapshot_ref.revision,
          manifest.client_fence_ref ?? null,
          manifest.expires_at,
          created.iso,
        ).run();
        if (!federationMutationChangedExactlyOne(result)) {
          federationD1Fail(
            "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
            "federation manifest insert did not mutate exactly one row",
            true,
          );
        }
      } catch (cause) {
        const raced = await readFederationManifest(database, manifest.manifest_ref);
        if (raced !== null) {
          assertSameFederationManifest(raced, manifest);
          return { disposition: "EXISTING", manifest: raced };
        }
        if (cause instanceof FederationD1AuthorityError) throw cause;
        federationD1Fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation manifest insertion failed without authoritative readback",
          true,
          cause,
        );
      }
      const readback = await readFederationManifest(database, manifest.manifest_ref);
      if (readback === null) {
        federationD1Fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation manifest insertion readback is missing",
          true,
        );
      }
      assertSameFederationManifest(readback, manifest);
      return { disposition: "CREATED", manifest: readback };
    },
  };
}

export type { AllowedReferenceManifest };
