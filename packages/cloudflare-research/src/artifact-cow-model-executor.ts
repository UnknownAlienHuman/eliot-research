import type { ModelCallReceipt, ModelRoutePort } from "@eliotr/research";
import { digest, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type { ResidencyDomainProfile } from "./research-model-output-store.js";
import type {
  ModelAttemptAuthority,
  ModelAttemptReservation,
  ModelAttemptReservationInput,
  ModelAttemptStore,
  ModelOutputBinding,
} from "./model-attempt-types.js";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

export interface ArtifactCowModelCallContext {
  readonly request: {
    readonly protocol: "eliotr.artifact.section.revise.v1";
    readonly operation_id: string;
    readonly report_intent_ref: { readonly id: string; readonly revision: number };
    readonly artifact_ref: { readonly id: string; readonly revision: number };
    readonly section_id: string;
    readonly spec_digest: string;
    readonly evidence_freeze_ref: { readonly id: string; readonly revision: number };
    readonly scope_snapshot_ref: { readonly id: string; readonly revision: number };
    readonly idempotency_key: string;
    readonly handler_generation: string;
  };
  readonly workflow_attempt: {
    readonly request: ArtifactCowModelCallContext["request"];
    readonly request_json: string;
    readonly request_sha256: string;
    readonly authority: {
      readonly principal_ref: string;
      readonly credential_generation: string;
      readonly deployment_generation: string;
      readonly policy_generation: string;
      readonly policy_authority_ref: string;
      readonly authorization_receipt_ref: string;
      readonly purge_revision: number;
    };
    readonly budget: { readonly receipt_ref: string; readonly expires_at_ms: number };
    readonly attempt_ref: string;
    readonly state: "STARTED" | "OUTPUT_RECORDED";
  };
  readonly principal: WorkflowPrincipal;
  readonly authority: ModelAttemptAuthority;
  readonly call_slot: "SYNTHESIZE" | "INDEPENDENT_VERIFY";
  /** Bounded, server-assembled content for this call; never the raw HTTP body. */
  readonly input_bytes: Uint8Array;
  readonly output_residency_domains: ResidencyDomainProfile;
}

export interface ArtifactCowModelExecutorDependencies {
  readonly attempts: ModelAttemptStore;
  readonly workflow: {
    markEffectUnknown(input: { readonly operation_id: string; readonly attempt_ref: string; readonly request_sha256: string; readonly created_at: string }): Promise<unknown>;
  };
  readonly route: ModelRoutePort;
  /** Builds the trusted model call, REPORT intent, quote, authority, and exact W3 admission. */
  readonly prepare: (input: ArtifactCowModelCallContext & {
    readonly model_operation_id: string;
    readonly model_idempotency_key: string;
    readonly model_output_object_ref: string;
  }) => Promise<ModelAttemptReservationInput>;
  /** Revalidates persisted W2, current owner/report authority, quote, W3 admission, and deployment. */
  readonly revalidate: (input: ArtifactCowModelCallContext, prepared: ModelAttemptReservationInput) => Promise<void>;
  /** Revalidates a previously successful durable W3 row without minting a new quote or approval. */
  readonly revalidateExisting: (input: ArtifactCowModelCallContext, existing: NonNullable<Awaited<ReturnType<ModelAttemptStore["readByIdempotency"]>>>) => Promise<void>;
  readonly prepareOutputBinding: (input: {
    readonly context: ArtifactCowModelCallContext;
    readonly reservation: ModelAttemptReservation;
    readonly attempt_id: string;
    readonly started_at: string;
    readonly residency_domains: Readonly<Record<string, unknown>>;
  }) => Promise<void>;
  readonly readOutput: (binding: Pick<ModelOutputBinding, "output_object_ref" | "output_sha256">) => Promise<Uint8Array>;
  readonly now?: () => number;
};

export interface ArtifactCowModelOutput {
  readonly call_slot: ArtifactCowModelCallContext["call_slot"];
  readonly bytes: Uint8Array;
  readonly output: ModelOutputBinding;
  readonly receipt: ModelCallReceipt;
  readonly model_attempt_id: string;
}

export class ArtifactCowModelExecutionError extends Error {
  public readonly code:
    | "ARTIFACT_COW_MODEL_INPUT_INVALID"
    | "ARTIFACT_COW_MODEL_AUTHORITY_STALE"
    | "ARTIFACT_COW_MODEL_EFFECT_UNKNOWN"
    | "ARTIFACT_COW_MODEL_OUTPUT_CORRUPT";

  public constructor(code: ArtifactCowModelExecutionError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactCowModelExecutionError";
    this.code = code;
  }
}

function fail(code: ArtifactCowModelExecutionError["code"], message: string, cause?: unknown): never {
  throw new ArtifactCowModelExecutionError(code, message, cause);
}

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

async function identityDigest(context: ArtifactCowModelCallContext): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    protocol: context.request.protocol,
    operation_id: context.request.operation_id,
    attempt_ref: context.workflow_attempt.attempt_ref,
    request_sha256: context.workflow_attempt.request_sha256,
    call_slot: context.call_slot,
    principal_ref: context.principal.principal_ref,
    credential_generation: context.principal.credential_generation,
    deployment_generation: context.principal.deployment_generation,
  }));
  return digest(bytes);
}

function outputRef(identity: string, attemptRef: string): string {
  return `artifact-cow/model-output/${identity}/${attemptRef}`;
}

function assertContext(context: ArtifactCowModelCallContext): void {
  if ((context.workflow_attempt.state !== "STARTED" && context.workflow_attempt.state !== "OUTPUT_RECORDED") ||
      context.workflow_attempt.request_sha256.length !== 64 ||
      context.workflow_attempt.request.operation_id !== context.request.operation_id ||
      context.workflow_attempt.request_json.length === 0 ||
      !sameRef(context.workflow_attempt.request.artifact_ref, context.request.artifact_ref) ||
      context.workflow_attempt.request.section_id !== context.request.section_id ||
      context.principal.principal_ref !== context.workflow_attempt.authority.principal_ref ||
      context.principal.credential_generation !== context.workflow_attempt.authority.credential_generation ||
      context.principal.deployment_generation !== context.workflow_attempt.authority.deployment_generation ||
      context.input_bytes.byteLength < 1 || context.input_bytes.byteLength > 256 * 1024 ||
      context.call_slot !== "SYNTHESIZE" && context.call_slot !== "INDEPENDENT_VERIFY") {
    fail("ARTIFACT_COW_MODEL_INPUT_INVALID", "model call is not bound to an admitted exact COW attempt");
  }
}

function validatePrepared(
  context: ArtifactCowModelCallContext,
  prepared: ModelAttemptReservationInput,
  identity: string,
  expectedOutputRef: string,
): void {
  const cow = prepared.artifact_cow_binding;
    if (cow === undefined || prepared.intent.operation_kind !== "REPORT" || prepared.quote.operation_kind !== "REPORT" ||
      prepared.intent.principal_ref !== context.principal.principal_ref ||
      prepared.intent.idempotency_key !== `artifact-cow-model-${identity}` || prepared.idempotency_key !== prepared.intent.idempotency_key ||
      prepared.intent.intent_ref.id !== `artifact-cow-operation-${identity}` ||
      prepared.intent.budget_reservation_ref !== prepared.quote.reservation_id ||
      prepared.call.budget_reservation_ref !== prepared.quote.reservation_id ||
      prepared.call.output_object_ref !== expectedOutputRef ||
      prepared.stage_attempt_ref !== context.workflow_attempt.attempt_ref ||
      prepared.stage_request_sha256 !== context.workflow_attempt.request_sha256 ||
      prepared.workflow_budget_receipt_ref !== context.workflow_attempt.budget.receipt_ref ||
      cow?.protocol !== context.request.protocol || cow.call_slot !== context.call_slot ||
      cow.operation_id !== context.request.operation_id || cow.attempt_ref !== context.workflow_attempt.attempt_ref ||
      !sameRef(cow.scope_snapshot_ref, prepared.authority.scope_snapshot_ref) ||
      cow.policy_authority_ref !== context.workflow_attempt.authority.policy_authority_ref ||
      cow.authorization_receipt_ref !== context.workflow_attempt.authority.authorization_receipt_ref ||
      cow.purge_revision !== context.workflow_attempt.authority.purge_revision) {
    fail("ARTIFACT_COW_MODEL_AUTHORITY_STALE", "prepared model request does not bind the exact COW W2 and W3 authority");
  }
}

function assertReadback(
  context: ArtifactCowModelCallContext,
  readback: Awaited<ReturnType<ModelAttemptStore["readByAttempt"]>>,
  identity: string,
  expectedOutputRef: string,
): asserts readback is NonNullable<Awaited<ReturnType<ModelAttemptStore["readByAttempt"]>>> {
  if (readback === null || readback.intent.operation_kind !== "REPORT" ||
      readback.intent.intent_ref.id !== `artifact-cow-operation-${identity}` ||
      readback.intent.idempotency_key !== `artifact-cow-model-${identity}` ||
      readback.stage_attempt_ref !== context.workflow_attempt.attempt_ref ||
      readback.stage_request_sha256 !== context.workflow_attempt.request_sha256 ||
      readback.workflow_budget_receipt_ref !== context.workflow_attempt.budget.receipt_ref ||
      readback.authority.principal_ref !== context.principal.principal_ref ||
      readback.authority.credential_generation !== context.principal.credential_generation ||
      readback.authority.deployment_generation !== context.principal.deployment_generation ||
      readback.artifact_cow_binding?.call_slot !== context.call_slot ||
      readback.artifact_cow_binding?.operation_id !== context.request.operation_id ||
      readback.output?.output_object_ref !== expectedOutputRef ||
      readback.receipt?.output_object_ref !== expectedOutputRef) {
    fail("ARTIFACT_COW_MODEL_OUTPUT_CORRUPT", "W3 model readback does not match the exact COW call slot");
  }
}

export function createArtifactCowModelExecutor(dependencies: ArtifactCowModelExecutorDependencies) {
  return Object.freeze({
    async execute(context: ArtifactCowModelCallContext): Promise<ArtifactCowModelOutput> {
      assertContext(context);
      if (context.principal.signal?.aborted) fail("ARTIFACT_COW_MODEL_AUTHORITY_STALE", "COW model call was cancelled before admission");
      const identity = await identityDigest(context);
      const attemptRef = context.workflow_attempt.attempt_ref;
      const expectedOutputRef = outputRef(identity, attemptRef);
      const idempotencyKey = `artifact-cow-model-${identity}`;
      const operationId = `artifact-cow-operation-${identity}`;
      if (!IDENTIFIER.test(idempotencyKey) || !IDENTIFIER.test(operationId) || !IDENTIFIER.test(expectedOutputRef)) {
        fail("ARTIFACT_COW_MODEL_INPUT_INVALID", "derived W3 identity is outside its identifier bound");
      }
      const existing = await dependencies.attempts.readByIdempotency({ principal_ref: context.principal.principal_ref,
        operation_kind: "REPORT", idempotency_key: idempotencyKey });
      if (existing !== null) {
        assertReadback(context, existing, identity, expectedOutputRef);
        if (existing.state !== "SUCCEEDED" || existing.output === null || existing.receipt === null) {
          fail("ARTIFACT_COW_MODEL_EFFECT_UNKNOWN", "existing provider outcome is not durably successful; automatic retry is forbidden");
        }
        await dependencies.revalidateExisting(context, existing);
        const bytes = await dependencies.readOutput(existing.output);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== existing.output.output_size_bytes ||
            bytes.byteLength > MAX_OUTPUT_BYTES || await digest(bytes) !== existing.output.output_sha256 ||
            existing.output.readback_sha256 !== existing.output.output_sha256) {
          fail("ARTIFACT_COW_MODEL_OUTPUT_CORRUPT", "persisted model output failed exact byte readback");
        }
        return Object.freeze({ call_slot: context.call_slot, bytes: new Uint8Array(bytes), output: existing.output,
          receipt: existing.receipt, model_attempt_id: existing.attempt_id });
      }

      if (context.workflow_attempt.state !== "STARTED") {
        fail("ARTIFACT_COW_MODEL_EFFECT_UNKNOWN", "W2 already recorded output but this W3 slot has no durable successful readback");
      }

      const prepared = await dependencies.prepare({ ...context, model_operation_id: operationId,
        model_idempotency_key: idempotencyKey, model_output_object_ref: expectedOutputRef });
      validatePrepared(context, prepared, identity, expectedOutputRef);

      if (Date.parse(prepared.quote.expires_at) <= (dependencies.now?.() ?? Date.now()) ||
          Date.parse(prepared.authority.expires_at) <= (dependencies.now?.() ?? Date.now())) {
        fail("ARTIFACT_COW_MODEL_AUTHORITY_STALE", "model quote or authority expired before W3 reservation");
      }
      await dependencies.revalidate(context, prepared);
      const reservation = await dependencies.attempts.reserve(prepared);
      if (reservation.intent.intent_ref.id !== operationId ||
          reservation.stage_attempt_ref !== attemptRef || reservation.stage_request_sha256 !== context.workflow_attempt.request_sha256 ||
          reservation.output_object_ref !== expectedOutputRef) {
        fail("ARTIFACT_COW_MODEL_AUTHORITY_STALE", "W3 reservation readback changed its COW call identity");
      }
      const started = await dependencies.attempts.beginAttempt(reservation);
      if (!started.should_invoke || started.attempt === null || started.state !== "STARTED") {
        if (started.attempt !== null) {
          const readback = await dependencies.attempts.readByAttempt(started.attempt.attempt_id);
          assertReadback(context, readback, identity, expectedOutputRef);
          if (readback.state === "SUCCEEDED" && readback.output !== null && readback.receipt !== null) {
            const bytes = await dependencies.readOutput(readback.output);
            if (await digest(bytes) !== readback.output.output_sha256) fail("ARTIFACT_COW_MODEL_OUTPUT_CORRUPT", "recovered model output digest changed");
            return Object.freeze({ call_slot: context.call_slot, bytes, output: readback.output,
              receipt: readback.receipt, model_attempt_id: readback.attempt_id });
          }
        }
        fail("ARTIFACT_COW_MODEL_EFFECT_UNKNOWN", "W3 attempt was already started or is not invokable; no second provider call will be issued");
      }
      try {
        if (context.principal.signal?.aborted || Date.parse(prepared.quote.expires_at) <= (dependencies.now?.() ?? Date.now()) ||
            Date.parse(prepared.authority.expires_at) <= (dependencies.now?.() ?? Date.now())) {
          await dependencies.attempts.settleAttempt({ attempt_id: started.attempt.attempt_id, state: "CANCELLED", error_code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
          fail("ARTIFACT_COW_MODEL_AUTHORITY_STALE", "model authority expired before provider execution");
        }
        await dependencies.revalidate(context, prepared);
        await dependencies.prepareOutputBinding({ context, reservation, attempt_id: started.attempt.attempt_id,
          started_at: started.attempt.started_at, residency_domains: context.output_residency_domains });
        await dependencies.revalidate(context, prepared);
      } catch (cause) {
        const state = await dependencies.attempts.readByAttempt(started.attempt.attempt_id);
        if (state?.persisted_state === "STARTED") {
          await dependencies.attempts.settleAttempt({ attempt_id: started.attempt.attempt_id,
            state: "CANCELLED", error_code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
        }
        throw cause;
      }
      let receipt: ModelCallReceipt;
      try { receipt = await dependencies.route.execute(prepared.call); }
      catch (cause) {
        await dependencies.workflow.markEffectUnknown({ operation_id: context.request.operation_id,
          attempt_ref: context.workflow_attempt.attempt_ref, request_sha256: context.workflow_attempt.request_sha256,
          created_at: new Date(dependencies.now?.() ?? Date.now()).toISOString() }).catch(() => undefined);
        fail("ARTIFACT_COW_MODEL_EFFECT_UNKNOWN", "provider outcome is unknown; this W2 attempt cannot be retried", cause);
      }
      if (receipt.output_object_ref !== expectedOutputRef) fail("ARTIFACT_COW_MODEL_OUTPUT_CORRUPT", "model receipt points to another output object");
      const raw = await dependencies.readOutput({ output_object_ref: expectedOutputRef, output_sha256: receipt.output_sha256 });
      if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_OUTPUT_BYTES || await digest(raw) !== receipt.output_sha256) {
        fail("ARTIFACT_COW_MODEL_OUTPUT_CORRUPT", "provider output object failed durable readback");
      }
      const output: ModelOutputBinding = { output_object_ref: expectedOutputRef, output_sha256: receipt.output_sha256,
        output_size_bytes: raw.byteLength, readback_sha256: await digest(raw) };
      await dependencies.revalidate(context, prepared);
      const settled = await dependencies.attempts.settleAttempt({ attempt_id: started.attempt.attempt_id,
        state: "SUCCEEDED", receipt, output });
      assertReadback(context, settled, identity, expectedOutputRef);
      if (settled.state !== "SUCCEEDED" || settled.receipt === null || settled.output === null) {
        fail("ARTIFACT_COW_MODEL_EFFECT_UNKNOWN", "successful provider output did not settle durably");
      }
      return Object.freeze({ call_slot: context.call_slot, bytes: new Uint8Array(raw), output: settled.output,
        receipt: settled.receipt, model_attempt_id: settled.attempt_id });
    },
  });
}
