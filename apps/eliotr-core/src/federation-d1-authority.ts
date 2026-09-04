import {
  FederationJobStatusSchema,
  type AllowedReferenceManifest,
  type FederationJobStatus,
} from "@eliotr/contracts";
import type {
  FederationJobAuthority,
  FederationSubmission,
  FederationSubmissionReservation,
} from "./federation-service.js";
import {
  FEDERATION_ACTIVE_STATES,
  FederationD1AuthorityError,
  federationCancellationReceiptRef,
  federationCanonicalJson,
  federationD1Fail,
  federationDigest,
  federationIdentifier,
  federationMutationApplied,
  federationNow,
  federationVersionedRef,
  normalizeFederationBinding,
  normalizeFederationRequest,
  parseFederationManifest,
  readFederationJob,
  readFederationManifest,
  requireFederationBinding,
  sameFederationSubmission,
  stableFederationJobId,
  validateFederationReason,
  type FederationManifestStore,
} from "./federation-d1-codec.js";

function sameManifest(
  left: AllowedReferenceManifest,
  right: AllowedReferenceManifest,
): boolean {
  return federationCanonicalJson(left) === federationCanonicalJson(right);
}

export function createD1FederationManifestStore(
  database: D1Database,
  clock: () => number = Date.now,
): FederationManifestStore {
  return {
    async get(rawRef) {
      return readFederationManifest(
        database,
        federationVersionedRef(rawRef, "manifest ref"),
      );
    },

    async put(rawManifest) {
      const manifest = await parseFederationManifest(rawManifest);
      const existing = await readFederationManifest(
        database,
        manifest.manifest_ref,
      );
      if (existing !== null) {
        if (!sameManifest(existing, manifest)) {
          federationD1Fail(
            "FEDERATION_D1_MANIFEST_CONFLICT",
            "manifest revision already has different bytes",
          );
        }
        return { disposition: "EXISTING", manifest: existing };
      }

      const created = federationNow(clock);
      if (Date.parse(manifest.expires_at) <= created.epoch) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "cannot persist an expired manifest",
        );
      }
      let mutationError: unknown;
      try {
        const result = await database.prepare(
          "INSERT INTO federation_reference_manifest(" +
          "manifest_id,revision,manifest_json,manifest_digest,scope_snapshot_id," +
          "scope_snapshot_revision,client_fence_ref,expires_at,created_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        ).bind(
          manifest.manifest_ref.id,
          manifest.manifest_ref.revision,
          federationCanonicalJson(manifest),
          manifest.manifest_digest,
          manifest.scope_snapshot_ref.id,
          manifest.scope_snapshot_ref.revision,
          manifest.client_fence_ref ?? null,
          manifest.expires_at,
          created.iso,
        ).run();
        if (!federationMutationApplied(result)) {
          mutationError = new Error("manifest insert changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }

      const readback = await readFederationManifest(
        database,
        manifest.manifest_ref,
      );
      if (readback !== null) {
        if (!sameManifest(readback, manifest)) {
          federationD1Fail(
            "FEDERATION_D1_MANIFEST_CONFLICT",
            "manifest revision raced with different bytes",
          );
        }
        return {
          disposition: mutationError === undefined ? "CREATED" : "EXISTING",
          manifest: readback,
        };
      }
      federationD1Fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "manifest mutation lacks exact durable readback",
        true,
        mutationError,
      );
    },
  };
}

function initialStatus(
  request: FederationSubmission["request"],
  jobId: string,
): FederationJobStatus {
  return FederationJobStatusSchema.parse({
    exchange_id: request.exchange_id,
    idempotency_key: request.idempotency_key,
    job_id: jobId,
    attempt: 1,
    transport_state: "ACCEPTED",
    completion_disposition: null,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
  });
}

function manifestAuthorizes(
  manifest: AllowedReferenceManifest,
  binding: FederationSubmission["binding"],
  observedNow: number,
): void {
  if (
    manifest.client_fence_ref !== binding.client_fence_ref ||
    manifest.provider_and_policy_generations[binding.requester_principal_ref] !==
      binding.requester_credential_generation ||
    manifest.provider_and_policy_generations[binding.server_principal_ref] !==
      binding.server_credential_generation ||
    Date.parse(manifest.expires_at) <= observedNow
  ) {
    federationD1Fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "manifest does not authorize this federation binding",
    );
  }
}

export function createD1FederationJobAuthority(
  database: D1Database,
  clock: () => number = Date.now,
): FederationJobAuthority {
  return {
    async reserve(rawSubmission): Promise<FederationSubmissionReservation> {
      const binding = normalizeFederationBinding(rawSubmission.binding);
      const request = normalizeFederationRequest(rawSubmission.request);
      const requestDigest = rawSubmission.request_digest;
      if (!/^[a-f0-9]{64}$/u.test(requestDigest)) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "request digest is invalid",
        );
      }
      if (await federationDigest(request) !== requestDigest) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "request digest mismatch",
        );
      }
      if (
        request.requester_principal_ref !== binding.requester_principal_ref ||
        request.bridge_generation !== binding.bridge_generation ||
        request.client_fence_ref !== binding.client_fence_ref
      ) {
        federationD1Fail(
          "FEDERATION_D1_BINDING_MISMATCH",
          "request does not match its binding",
        );
      }
      const submission: FederationSubmission = {
        binding,
        request,
        request_digest: requestDigest,
      };
      const observedNow = federationNow(clock);
      const manifest = await readFederationManifest(
        database,
        binding.allowed_reference_manifest_ref,
      );
      if (manifest === null) {
        federationD1Fail(
          "FEDERATION_D1_BINDING_MISMATCH",
          "manifest authority is missing",
        );
      }
      manifestAuthorizes(manifest, binding, observedNow.epoch);

      const existing = await readFederationJob(
        database,
        request.exchange_id,
        request.idempotency_key,
      );
      if (existing !== null) {
        return sameFederationSubmission(existing, submission)
          ? {
              outcome: "REPLAY",
              request_digest: requestDigest,
              record: existing.record,
            }
          : {
              outcome: "CONFLICT",
              existing_request_digest: existing.record.request_digest,
            };
      }

      const jobId = await stableFederationJobId(
        binding,
        request,
        requestDigest,
      );
      const status = initialStatus(request, jobId);
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
          "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1," +
          "'ACCEPTED',?15,NULL,NULL,NULL,NULL,?16,?16)",
        ).bind(
          jobId,
          request.exchange_id,
          request.idempotency_key,
          requestDigest,
          federationCanonicalJson(request),
          binding.requester_principal_ref,
          binding.requester_credential_generation,
          binding.server_principal_ref,
          binding.server_credential_generation,
          binding.bridge_generation,
          binding.client_fence_ref,
          binding.allowed_reference_manifest_ref.id,
          binding.allowed_reference_manifest_ref.revision,
          binding.trace_id,
          federationCanonicalJson(status),
          observedNow.iso,
        ).run();
        if (!federationMutationApplied(mutation)) {
          mutationError = new Error("reservation changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }

      const readback = await readFederationJob(
        database,
        request.exchange_id,
        request.idempotency_key,
      );
      if (readback !== null) {
        if (sameFederationSubmission(readback, submission)) {
          return {
            outcome: mutationError === undefined ? "CREATED" : "REPLAY",
            request_digest: requestDigest,
            record: readback.record,
          };
        }
        if (mutationError !== undefined) {
          return {
            outcome: "CONFLICT",
            existing_request_digest: readback.record.request_digest,
          };
        }
        federationD1Fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "successful reservation read back other bytes",
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
      const exchangeId = federationIdentifier(rawExchangeId, "exchange id");
      const idempotencyKey = federationIdentifier(
        rawIdempotencyKey,
        "idempotency key",
      );
      const existing = await readFederationJob(
        database,
        exchangeId,
        idempotencyKey,
      );
      if (existing === null) return null;
      requireFederationBinding(existing.binding, binding);
      return existing.record;
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
      const existing = await readFederationJob(
        database,
        exchangeId,
        idempotencyKey,
      );
      if (existing === null) return null;
      requireFederationBinding(existing.binding, binding);

      if (existing.record.status.transport_state === "CANCELLED") {
        if (existing.cancellationReason !== reason) {
          federationD1Fail(
            "FEDERATION_D1_STATE_CONFLICT",
            "job was cancelled for another reason",
          );
        }
        return existing.record;
      }
      if (!FEDERATION_ACTIVE_STATES.has(
        existing.record.status.transport_state,
      )) {
        federationD1Fail(
          "FEDERATION_D1_STATE_CONFLICT",
          "terminal job cannot be cancelled",
        );
      }

      const cancelledAt = federationNow(clock).iso;
      const receiptRef = await federationCancellationReceiptRef(
        existing.record.status.job_id,
        reason,
      );
      const status = FederationJobStatusSchema.parse({
        ...existing.record.status,
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
        cancellation_receipt_ref: receiptRef,
        terminal_receipt_ref: receiptRef,
      });
      let mutationError: unknown;
      try {
        const mutation = await database.prepare(
          "UPDATE federation_job SET transport_state='CANCELLED'," +
          "status_json=?1,observed_completion_disposition='CANCELLED'," +
          "cancellation_reason=?2,cancelled_at=?3,updated_at=?3 " +
          "WHERE job_id=?4 AND transport_state=?5 AND status_json=?6 " +
          "AND updated_at=?7",
        ).bind(
          federationCanonicalJson(status),
          reason,
          cancelledAt,
          existing.record.status.job_id,
          existing.record.status.transport_state,
          federationCanonicalJson(existing.record.status),
          existing.updatedAt,
        ).run();
        if (!federationMutationApplied(mutation)) {
          mutationError = new Error("cancellation CAS changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }

      const readback = await readFederationJob(
        database,
        exchangeId,
        idempotencyKey,
      );
      if (
        readback !== null &&
        readback.record.status.transport_state === "CANCELLED" &&
        readback.cancellationReason === reason &&
        federationCanonicalJson(readback.record.status) ===
          federationCanonicalJson(status)
      ) {
        requireFederationBinding(readback.binding, binding);
        return readback.record;
      }
      if (readback !== null && mutationError !== undefined) {
        federationD1Fail(
          "FEDERATION_D1_STATE_CONFLICT",
          "job changed during cancellation",
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
  };
}

export { FederationD1AuthorityError };
