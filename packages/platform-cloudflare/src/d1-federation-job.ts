import { FederationJobStatusSchema } from "@eliotr/contracts";
import { canonicalDigest } from "./d1-ingest-validation.js";
import {
  ACTIVE_FEDERATION_TRANSPORT_STATES,
  assertFederationBindingIdentity,
  assertManifestAuthorizesFederationBinding,
  federationCancellationReceiptRef,
  federationClockTimestamp,
  federationIdentifier,
  federationMutationChangedExactlyOne,
  federationSubmissionMatches,
  initialFederationStatus,
  normalizeFederationBinding,
  normalizeFederationRequest,
  readFederationJob,
  readFederationManifest,
  stableFederationJobId,
  validateFederationCancellationReason,
} from "./d1-federation-codec.js";
import type {
  D1FederationAuthorityDependencies,
  D1FederationJobAuthority,
  FederationSubmissionInput,
} from "./d1-federation-types.js";
import {
  FederationD1AuthorityError,
  federationD1Fail,
} from "./d1-federation-types.js";
import { canonicalJson } from "./ingest-validation.js";

export function createD1FederationJobAuthority(
  database: D1Database,
  dependencies: D1FederationAuthorityDependencies = {},
): D1FederationJobAuthority {
  const clock = dependencies.now ?? Date.now;
  return {
    async reserve(rawInput) {
      const binding = normalizeFederationBinding(rawInput.binding);
      const request = normalizeFederationRequest(rawInput.request);
      const requestDigest = rawInput.request_digest;
      if (!/^[a-f0-9]{64}$/u.test(requestDigest)) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "federation request digest is not a SHA-256 digest",
        );
      }
      if (await canonicalDigest(request) !== requestDigest) {
        federationD1Fail(
          "FEDERATION_D1_INPUT_INVALID",
          "federation request digest mismatch",
        );
      }
      if (
        request.requester_principal_ref !== binding.requester_principal_ref ||
        request.bridge_generation !== binding.bridge_generation ||
        request.client_fence_ref !== binding.client_fence_ref
      ) {
        federationD1Fail(
          "FEDERATION_D1_BINDING_MISMATCH",
          "federation request does not match its binding",
        );
      }
      const input: FederationSubmissionInput = {
        binding,
        request,
        request_digest: requestDigest,
      };
      const manifest = await readFederationManifest(
        database,
        binding.allowed_reference_manifest_ref,
      );
      if (manifest === null) {
        federationD1Fail(
          "FEDERATION_D1_BINDING_MISMATCH",
          "federation manifest authority is missing",
        );
      }
      assertManifestAuthorizesFederationBinding(manifest, binding);
      const existing = await readFederationJob(
        database,
        request.exchange_id,
        request.idempotency_key,
      );
      if (existing !== null) {
        return federationSubmissionMatches(existing, input)
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
      const jobId = await stableFederationJobId(binding, request, requestDigest);
      const status = initialFederationStatus(request, jobId);
      const createdAt = federationClockTimestamp(clock).iso;
      try {
        const result = await database.prepare(
          "INSERT INTO federation_job(" +
          "job_id, exchange_id, idempotency_key, request_digest, request_json, " +
          "requester_principal_ref, requester_credential_generation, server_principal_ref, " +
          "server_credential_generation, bridge_generation, client_fence_ref, " +
          "allowed_manifest_id, allowed_manifest_revision, origin_trace_id, attempt, " +
          "transport_state, status_json, observed_completion_disposition, result_json, " +
          "cancellation_reason, cancelled_at, created_at, updated_at) VALUES (" +
          "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,'ACCEPTED'," +
          "?15,NULL,NULL,NULL,NULL,?16,?16)",
        ).bind(
          jobId,
          request.exchange_id,
          request.idempotency_key,
          requestDigest,
          canonicalJson(request),
          binding.requester_principal_ref,
          binding.requester_credential_generation,
          binding.server_principal_ref,
          binding.server_credential_generation,
          binding.bridge_generation,
          binding.client_fence_ref,
          binding.allowed_reference_manifest_ref.id,
          binding.allowed_reference_manifest_ref.revision,
          binding.trace_id,
          canonicalJson(status),
          createdAt,
        ).run();
        if (!federationMutationChangedExactlyOne(result)) {
          federationD1Fail(
            "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
            "federation job reservation did not mutate exactly one row",
            true,
          );
        }
      } catch (cause) {
        const raced = await readFederationJob(
          database,
          request.exchange_id,
          request.idempotency_key,
        );
        if (raced !== null) {
          return federationSubmissionMatches(raced, input)
            ? { outcome: "REPLAY", request_digest: requestDigest, record: raced.record }
            : {
                outcome: "CONFLICT",
                existing_request_digest: raced.record.request_digest,
              };
        }
        if (cause instanceof FederationD1AuthorityError) throw cause;
        federationD1Fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation job reservation failed without authoritative readback",
          true,
          cause,
        );
      }
      const readback = await readFederationJob(
        database,
        request.exchange_id,
        request.idempotency_key,
      );
      if (readback === null || !federationSubmissionMatches(readback, input)) {
        federationD1Fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation job reservation readback mismatch",
          true,
        );
      }
      return {
        outcome: "CREATED",
        request_digest: requestDigest,
        record: readback.record,
      };
    },

    async read(rawBinding, rawExchangeId, rawIdempotencyKey) {
      const binding = normalizeFederationBinding(rawBinding);
      const exchangeId = federationIdentifier(rawExchangeId, "exchange_id");
      const idempotencyKey = federationIdentifier(rawIdempotencyKey, "idempotency_key");
      const existing = await readFederationJob(database, exchangeId, idempotencyKey);
      if (existing === null) return null;
      assertFederationBindingIdentity(existing.binding, binding);
      return existing.record;
    },

    async cancel(rawBinding, rawExchangeId, rawIdempotencyKey, rawReason) {
      const binding = normalizeFederationBinding(rawBinding);
      const exchangeId = federationIdentifier(rawExchangeId, "exchange_id");
      const idempotencyKey = federationIdentifier(rawIdempotencyKey, "idempotency_key");
      const reason = validateFederationCancellationReason(rawReason);
      const existing = await readFederationJob(database, exchangeId, idempotencyKey);
      if (existing === null) return null;
      assertFederationBindingIdentity(existing.binding, binding);
      if (existing.record.status.transport_state === "CANCELLED") {
        if (existing.cancellation_reason !== reason) {
          federationD1Fail(
            "FEDERATION_D1_STATE_CONFLICT",
            "cancelled federation job is bound to another cancellation reason",
          );
        }
        return existing.record;
      }
      if (!ACTIVE_FEDERATION_TRANSPORT_STATES.has(existing.record.status.transport_state)) {
        federationD1Fail(
          "FEDERATION_D1_STATE_CONFLICT",
          "terminal federation job cannot be cancelled",
        );
      }
      const cancelledAt = federationClockTimestamp(clock).iso;
      const receiptRef = await federationCancellationReceiptRef(
        existing.record.status.job_id,
        reason,
      );
      const cancelledStatus = FederationJobStatusSchema.parse({
        ...existing.record.status,
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
        cancellation_receipt_ref: receiptRef,
        terminal_receipt_ref: receiptRef,
      });
      let mutationError: unknown;
      try {
        const result = await database.prepare(
          "UPDATE federation_job SET transport_state = 'CANCELLED', status_json = ?1, " +
          "observed_completion_disposition = 'CANCELLED', cancellation_reason = ?2, " +
          "cancelled_at = ?3, updated_at = ?3 WHERE job_id = ?4 AND transport_state = ?5 " +
          "AND status_json = ?6 AND updated_at = ?7",
        ).bind(
          canonicalJson(cancelledStatus),
          reason,
          cancelledAt,
          existing.record.status.job_id,
          existing.record.status.transport_state,
          canonicalJson(existing.record.status),
          existing.updated_at,
        ).run();
        if (!federationMutationChangedExactlyOne(result)) {
          mutationError = new Error("federation cancellation compare-and-swap changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }
      const readback = await readFederationJob(database, exchangeId, idempotencyKey);
      if (
        readback !== null &&
        readback.record.status.transport_state === "CANCELLED" &&
        readback.cancellation_reason === reason &&
        canonicalJson(readback.record.status) === canonicalJson(cancelledStatus)
      ) {
        assertFederationBindingIdentity(readback.binding, binding);
        return readback.record;
      }
      if (mutationError instanceof FederationD1AuthorityError) throw mutationError;
      federationD1Fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "federation cancellation did not produce exact durable readback",
        true,
        mutationError,
      );
    },
  };
}
