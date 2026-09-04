import {
  FederationJobStatusSchema,
  type AllowedReferenceManifest,
  type FederationJobStatus,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  FEDERATION_ACTIVE_STATES,
  FEDERATION_MANIFEST_JSON_MAX_BYTES,
  FEDERATION_REQUEST_JSON_MAX_BYTES,
  FEDERATION_STATUS_JSON_MAX_BYTES,
  federationAssertDatabase,
  federationCancellationReceiptRef,
  federationCanonicalJson,
  federationCanonicalJsonWithin,
  federationD1Fail,
  federationDigest,
  federationIdentifier,
  federationMutationApplied,
  federationNow,
  federationVersionedRef,
  normalizeFederationBinding,
  normalizeFederationSubmission,
  parseFederationManifest,
  requireFederationBinding,
  stableFederationJobId,
  validateFederationReason,
  type FederationAuthorityBinding,
  type FederationJobAuthority,
  type FederationManifestStore,
  type FederationSubmission,
  type FederationSubmissionReservation,
} from "./federation-d1-common.js";
import {
  readFederationJob,
  readFederationManifest,
  sameFederationSubmission,
} from "./federation-d1-codec.js";

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKeys(ref: VersionedRef): readonly string[] {
  return [ref.id, `${ref.id}:${ref.revision}`, `${ref.id}@${ref.revision}`];
}

function manifestAuthorizes(
  manifest: AllowedReferenceManifest,
  binding: FederationAuthorityBinding,
  now: number,
): void {
  const revoked = new Set(manifest.stale_or_revoked_entries);
  const revokedAuthority = [
    binding.requester_principal_ref,
    binding.server_principal_ref,
    ...refKeys(manifest.scope_snapshot_ref),
  ].some((key) => revoked.has(key));
  if (
    manifest.client_fence_ref !== binding.client_fence_ref ||
    manifest.provider_and_policy_generations[
      binding.requester_principal_ref
    ] !== binding.requester_credential_generation ||
    manifest.provider_and_policy_generations[
      binding.server_principal_ref
    ] !== binding.server_credential_generation ||
    !manifest.allowed_use.includes("federation.submit") ||
    revokedAuthority ||
    Date.parse(manifest.expires_at) <= now
  ) {
    federationD1Fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "manifest does not authorize this federation binding",
    );
  }
}

async function readManifestAfterMutation(
  database: D1Database,
  ref: VersionedRef,
  mutationError: unknown,
): Promise<AllowedReferenceManifest | null> {
  try {
    return await readFederationManifest(database, ref);
  } catch (cause) {
    federationD1Fail(
      "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
      "manifest mutation lacks authoritative readback",
      true,
      cause ?? mutationError,
    );
  }
}

async function readJobAfterMutation(
  database: D1Database,
  exchangeId: string,
  idempotencyKey: string,
  operation: string,
  mutationError: unknown,
) {
  try {
    return await readFederationJob(database, exchangeId, idempotencyKey);
  } catch (cause) {
    federationD1Fail(
      "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
      `${operation} lacks authoritative readback`,
      true,
      cause ?? mutationError,
    );
  }
}

/**
 * Persists immutable, digest-bound federation manifests in Core D1. A failed
 * mutation is reconciled exactly once through the authoritative row and is
 * never blindly retried.
 */
export function createD1FederationManifestStore(
  database: D1Database,
  clock: () => number = Date.now,
): FederationManifestStore {
  federationAssertDatabase(database);
  return Object.freeze({
    async get(rawRef: VersionedRef) {
      const ref = federationVersionedRef(rawRef, "manifest ref");
      return readFederationManifest(database, ref);
    },

    async put(rawManifest: AllowedReferenceManifest) {
      const manifest = await parseFederationManifest(rawManifest);
      const manifestJson = federationCanonicalJsonWithin(
        manifest,
        FEDERATION_MANIFEST_JSON_MAX_BYTES,
        "federation manifest",
      );
      const prior = await readFederationManifest(
        database,
        manifest.manifest_ref,
      );
      if (prior !== null) {
        if (federationCanonicalJson(prior) !== manifestJson) {
          federationD1Fail(
            "FEDERATION_D1_MANIFEST_CONFLICT",
            "manifest revision has different canonical bytes",
          );
        }
        return Object.freeze({
          disposition: "EXISTING" as const,
          manifest: prior,
        });
      }

      const created = federationNow(clock);
      if (Date.parse(manifest.expires_at) <= created.epoch) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "cannot persist an expired federation manifest",
        );
      }

      let mutationError: unknown;
      try {
        const mutation = await database.prepare(
          "INSERT INTO federation_reference_manifest(" +
            "manifest_id,revision,manifest_json,manifest_digest,scope_snapshot_id," +
            "scope_snapshot_revision,client_fence_ref,expires_at,created_at)" +
            " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
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
        if (!federationMutationApplied(mutation)) {
          mutationError = new Error("manifest insert changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }

      const stored = await readManifestAfterMutation(
        database,
        manifest.manifest_ref,
        mutationError,
      );
      if (stored !== null) {
        if (federationCanonicalJson(stored) !== manifestJson) {
          federationD1Fail(
            "FEDERATION_D1_MANIFEST_CONFLICT",
            "manifest revision raced with different canonical bytes",
          );
        }
        return Object.freeze({
          disposition: mutationError === undefined
            ? "CREATED" as const
            : "EXISTING" as const,
          manifest: stored,
        });
      }
      federationD1Fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "manifest mutation lacks exact durable readback",
        true,
        mutationError,
      );
    },
  });
}

function acceptedStatus(
  submission: FederationSubmission,
  jobId: string,
): FederationJobStatus {
  return FederationJobStatusSchema.parse({
    exchange_id: submission.request.exchange_id,
    idempotency_key: submission.request.idempotency_key,
    job_id: jobId,
    attempt: 1,
    transport_state: "ACCEPTED",
    completion_disposition: null,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
  });
}

/**
 * Reserves and cancels federation jobs under one immutable idempotency identity.
 * Completion execution is intentionally outside this storage adapter.
 */
export function createD1FederationJobAuthority(
  database: D1Database,
  clock: () => number = Date.now,
): FederationJobAuthority {
  federationAssertDatabase(database);
  return Object.freeze({
    async reserve(
      rawSubmission: FederationSubmission,
    ): Promise<FederationSubmissionReservation> {
      const submission = normalizeFederationSubmission(rawSubmission);
      if (
        await federationDigest(submission.request) !==
          submission.request_digest
      ) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "federation request digest mismatch",
        );
      }
      if (
        submission.request.requester_principal_ref !==
          submission.binding.requester_principal_ref ||
        submission.request.bridge_generation !==
          submission.binding.bridge_generation ||
        submission.request.client_fence_ref !==
          submission.binding.client_fence_ref
      ) {
        federationD1Fail(
          "FEDERATION_D1_BINDING_MISMATCH",
          "federation request does not match its authority binding",
        );
      }

      const observed = federationNow(clock);
      const manifest = await readFederationManifest(
        database,
        submission.binding.allowed_reference_manifest_ref,
      );
      if (manifest === null) {
        federationD1Fail(
          "FEDERATION_D1_BINDING_MISMATCH",
          "federation manifest authority is missing",
        );
      }
      manifestAuthorizes(manifest, submission.binding, observed.epoch);

      const prior = await readFederationJob(
        database,
        submission.request.exchange_id,
        submission.request.idempotency_key,
      );
      if (prior !== null) {
        requireFederationBinding(prior.binding, submission.binding);
        return sameFederationSubmission(prior, submission)
          ? Object.freeze({
              outcome: "REPLAY" as const,
              request_digest: submission.request_digest,
              record: prior.record,
            })
          : Object.freeze({
              outcome: "CONFLICT" as const,
              existing_request_digest: prior.record.request_digest,
            });
      }

      const jobId = await stableFederationJobId(
        submission.binding,
        submission.request,
        submission.request_digest,
      );
      const status = acceptedStatus(submission, jobId);
      const requestJson = federationCanonicalJsonWithin(
        submission.request,
        FEDERATION_REQUEST_JSON_MAX_BYTES,
        "federation request",
      );
      const statusJson = federationCanonicalJsonWithin(
        status,
        FEDERATION_STATUS_JSON_MAX_BYTES,
        "federation status",
      );
      let mutationError: unknown;
      try {
        const mutation = await database.prepare(
          "INSERT INTO federation_job(" +
            "job_id,exchange_id,idempotency_key,request_digest,request_json," +
            "requester_principal_ref,requester_credential_generation," +
            "server_principal_ref,server_credential_generation,bridge_generation," +
            "client_fence_ref,allowed_manifest_id,allowed_manifest_revision," +
            "origin_trace_id,attempt,transport_state,status_json," +
            "observed_completion_disposition,result_json,cancellation_reason," +
            "cancelled_at,created_at,updated_at) VALUES (" +
            "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14," +
            "1,'ACCEPTED',?15,NULL,NULL,NULL,NULL,?16,?16)",
        ).bind(
          jobId,
          submission.request.exchange_id,
          submission.request.idempotency_key,
          submission.request_digest,
          requestJson,
          submission.binding.requester_principal_ref,
          submission.binding.requester_credential_generation,
          submission.binding.server_principal_ref,
          submission.binding.server_credential_generation,
          submission.binding.bridge_generation,
          submission.binding.client_fence_ref,
          submission.binding.allowed_reference_manifest_ref.id,
          submission.binding.allowed_reference_manifest_ref.revision,
          submission.binding.trace_id,
          statusJson,
          observed.iso,
        ).run();
        if (!federationMutationApplied(mutation)) {
          mutationError = new Error("federation reservation changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }

      const stored = await readJobAfterMutation(
        database,
        submission.request.exchange_id,
        submission.request.idempotency_key,
        "federation reservation",
        mutationError,
      );
      if (stored !== null) {
        requireFederationBinding(stored.binding, submission.binding);
        if (sameFederationSubmission(stored, submission)) {
          return Object.freeze({
            outcome: mutationError === undefined
              ? "CREATED" as const
              : "REPLAY" as const,
            request_digest: submission.request_digest,
            record: stored.record,
          });
        }
        if (mutationError !== undefined) {
          return Object.freeze({
            outcome: "CONFLICT" as const,
            existing_request_digest: stored.record.request_digest,
          });
        }
        federationD1Fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "reservation read back another valid request",
          true,
        );
      }
      federationD1Fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "reservation mutation lacks exact durable readback",
        true,
        mutationError,
      );
    },

    async read(rawBinding, rawExchangeId, rawIdempotencyKey) {
      const binding = normalizeFederationBinding(rawBinding);
      const stored = await readFederationJob(
        database,
        federationIdentifier(rawExchangeId, "exchange id"),
        federationIdentifier(rawIdempotencyKey, "idempotency key"),
      );
      if (stored === null) return null;
      requireFederationBinding(stored.binding, binding);
      return stored.record;
    },

    async cancel(
      rawBinding,
      rawExchangeId,
      rawIdempotencyKey,
      rawReason,
    ) {
      const binding = normalizeFederationBinding(rawBinding);
      const exchangeId = federationIdentifier(rawExchangeId, "exchange id");
      const idempotencyKey = federationIdentifier(
        rawIdempotencyKey,
        "idempotency key",
      );
      const reason = validateFederationReason(rawReason);
      const prior = await readFederationJob(
        database,
        exchangeId,
        idempotencyKey,
      );
      if (prior === null) return null;
      requireFederationBinding(prior.binding, binding);
      if (prior.record.status.transport_state === "CANCELLED") {
        if (prior.cancellationReason !== reason) {
          federationD1Fail(
            "FEDERATION_D1_STATE_CONFLICT",
            "federation job was cancelled for another reason",
          );
        }
        return prior.record;
      }
      if (!FEDERATION_ACTIVE_STATES.has(
        prior.record.status.transport_state as
          "ACCEPTED" | "RUNNING" | "PARTIAL" | "BLOCKED",
      )) {
        federationD1Fail(
          "FEDERATION_D1_STATE_CONFLICT",
          "terminal federation job cannot be cancelled",
        );
      }

      const cancelled = federationNow(clock);
      if (Date.parse(prior.updatedAt) > cancelled.epoch) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "federation clock regressed before cancellation",
        );
      }
      const receipt = await federationCancellationReceiptRef(
        prior.record.status.job_id,
        reason,
      );
      const status = FederationJobStatusSchema.parse({
        ...prior.record.status,
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
        cancellation_receipt_ref: receipt,
        terminal_receipt_ref: receipt,
      });
      const statusJson = federationCanonicalJsonWithin(
        status,
        FEDERATION_STATUS_JSON_MAX_BYTES,
        "cancelled federation status",
      );
      const priorStatusJson = federationCanonicalJsonWithin(
        prior.record.status,
        FEDERATION_STATUS_JSON_MAX_BYTES,
        "prior federation status",
      );
      let mutationError: unknown;
      try {
        const mutation = await database.prepare(
          "UPDATE federation_job SET transport_state='CANCELLED',status_json=?1," +
            "observed_completion_disposition='CANCELLED',cancellation_reason=?2," +
            "cancelled_at=?3,updated_at=?3 WHERE job_id=?4 AND transport_state=?5 " +
            "AND status_json=?6 AND updated_at=?7",
        ).bind(
          statusJson,
          reason,
          cancelled.iso,
          prior.record.status.job_id,
          prior.record.status.transport_state,
          priorStatusJson,
          prior.updatedAt,
        ).run();
        if (!federationMutationApplied(mutation)) {
          mutationError = new Error("federation cancellation changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }

      const stored = await readJobAfterMutation(
        database,
        exchangeId,
        idempotencyKey,
        "federation cancellation",
        mutationError,
      );
      if (
        stored !== null &&
        stored.record.status.transport_state === "CANCELLED" &&
        stored.cancellationReason === reason &&
        federationCanonicalJson(stored.record.status) === statusJson
      ) {
        requireFederationBinding(stored.binding, binding);
        return stored.record;
      }
      if (stored !== null && mutationError !== undefined) {
        federationD1Fail(
          "FEDERATION_D1_STATE_CONFLICT",
          "federation job changed during cancellation",
          true,
          mutationError,
        );
      }
      federationD1Fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "cancellation mutation lacks exact durable readback",
        true,
        mutationError,
      );
    },
  });
}
