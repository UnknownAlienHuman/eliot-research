import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  VersionedRefSchema,
  type VersionedRef,
} from "./common.js";

export const ErasureProtocolSchema = z.literal("erc.privacy.erasure.v1");
export const PurgeLocationSchema = z.enum([
  "CanonicalPayload", "Projection", "Index", "Blob", "OperationalRecovery", "ProviderCopy", "BackupRestorePath", "RouteContinuation",
]);
export type PurgeLocation = z.infer<typeof PurgeLocationSchema>;

export const PurgeStateSchema = z.enum([
  "REQUESTED", "QUARANTINE_AND_REVOKE", "ENUMERATE_DEPENDENCY_CLOSURE", "CHECK_RETENTION_AND_HOLDS",
  "PURGE_EACH_LOCATION", "VERIFY_ABSENCE_OR_BLOCK", "APPEND_PURGE_LEDGER", "INVALIDATE_DEPENDENTS", "COMPLETE", "BLOCKED",
]);
export type PurgeState = z.infer<typeof PurgeStateSchema>;

export const ErasureRequestSchema = z.object({
  protocol: ErasureProtocolSchema,
  erasure_ref: VersionedRefSchema,
  requested_by_principal_ref: IdentifierSchema,
  exact_subject_refs: z.array(IdentifierSchema).min(1).max(10_000),
  required_locations: z.array(PurgeLocationSchema).min(1).max(PurgeLocationSchema.options.length),
  legal_basis_ref: IdentifierSchema,
  admitted_at: IsoDateTimeSchema,
  deadline: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.exact_subject_refs).size !== value.exact_subject_refs.length) {
    context.addIssue({ code: "custom", path: ["exact_subject_refs"], message: "duplicate erasure subject" });
  }
  if (new Set(value.required_locations).size !== value.required_locations.length) {
    context.addIssue({ code: "custom", path: ["required_locations"], message: "duplicate purge location" });
  }
  if (Date.parse(value.deadline) <= Date.parse(value.admitted_at)) {
    context.addIssue({ code: "custom", path: ["deadline"], message: "erasure deadline must follow admission" });
  }
});
export type ErasureRequest = z.infer<typeof ErasureRequestSchema>;

export const ErasureReceiptSchema = z.object({
  protocol: ErasureProtocolSchema,
  erasure_ref: VersionedRefSchema,
  state: z.enum(["COMPLETE", "BLOCKED"]),
  requested_locations: z.array(PurgeLocationSchema).min(1).max(PurgeLocationSchema.options.length),
  completed_locations: z.array(PurgeLocationSchema).max(PurgeLocationSchema.options.length),
  blocked_locations: z.array(z.object({
    location: PurgeLocationSchema,
    policy_or_hold_ref: IdentifierSchema,
    next_review_at: IsoDateTimeSchema,
  }).strict()).max(PurgeLocationSchema.options.length),
  purge_ledger_entry_ref: IdentifierSchema,
  issued_at: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  const requested = new Set(value.requested_locations);
  const completed = new Set(value.completed_locations);
  const blocked = new Set(value.blocked_locations.map((item) => item.location));
  if (requested.size !== value.requested_locations.length) {
    context.addIssue({ code: "custom", path: ["requested_locations"], message: "duplicate requested location" });
  }
  if (completed.size !== value.completed_locations.length) {
    context.addIssue({ code: "custom", path: ["completed_locations"], message: "duplicate completed location" });
  }
  if (blocked.size !== value.blocked_locations.length) {
    context.addIssue({ code: "custom", path: ["blocked_locations"], message: "duplicate blocked location" });
  }
  if ([...completed].some((location) => !requested.has(location))) {
    context.addIssue({ code: "custom", path: ["completed_locations"], message: "completed location was not requested" });
  }
  if ([...blocked].some((location) => !requested.has(location))) {
    context.addIssue({ code: "custom", path: ["blocked_locations"], message: "blocked location was not requested" });
  }
  const complete = completed.size === requested.size && [...requested].every((location) => completed.has(location));
  if (value.state === "COMPLETE" && (!complete || blocked.size !== 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "COMPLETE requires exact location equality and no blockers" });
  }
  if (value.state === "BLOCKED" && blocked.size === 0) {
    context.addIssue({ code: "custom", path: ["blocked_locations"], message: "BLOCKED requires at least one blocker" });
  }
});
export type ErasureReceipt = z.infer<typeof ErasureReceiptSchema>;

export const PurgeLedgerEntrySchema = z.object({
  protocol: ErasureProtocolSchema,
  ledger_entry_ref: IdentifierSchema,
  ledger_revision: PositiveIntegerSchema,
  erasure_ref: VersionedRefSchema,
  non_revealing_subject_digest: Sha256Schema,
  disposition: z.enum(["COMPLETE", "BLOCKED"]),
  created_at: IsoDateTimeSchema,
}).strict();
export type PurgeLedgerEntry = z.infer<typeof PurgeLedgerEntrySchema>;

export type ErasureTargetKind = "OBJECT" | "LOCATION_EMPTY_PROOF";

export interface PurgeTarget {
  readonly target_id: string;
  readonly target_kind: ErasureTargetKind;
  readonly exact_subject_ref: string;
  readonly location: PurgeLocation;
  readonly canonical_ref: string;
  readonly provider_ref?: string;
  readonly identity_digest: string;
  readonly shared_live_reference_count: number;
  readonly retention_or_hold_ref?: string;
  readonly next_review_at?: string;
}

export interface ErasureDependencyClosure {
  readonly erasure_ref: VersionedRef;
  readonly request_digest: string;
  readonly closure_digest: string;
  readonly targets: readonly PurgeTarget[];
}

export interface ErasureBlocker {
  readonly target_id: string;
  readonly location: PurgeLocation;
  readonly policy_or_hold_ref: string;
  readonly next_review_at: string;
  readonly reason_code: string;
}

export interface ErasureFence {
  readonly erasure_id: string;
  readonly revision: number;
  readonly lease_owner: string;
  readonly lease_generation: number;
  readonly lease_until_ms: number;
}

export type ErasureAcquireResult =
  | { readonly disposition: "TERMINAL"; readonly receipt: ErasureReceipt }
  | { readonly disposition: "ACQUIRED"; readonly fence: ErasureFence };

export interface PurgeAttemptReceipt {
  readonly target_id: string;
  readonly disposition: "DELETE_ACCEPTED" | "ALREADY_ABSENT" | "BLOCKED";
  readonly receipt_ref: string;
  readonly reason_code?: string;
}

export interface AbsenceVerificationReceipt {
  readonly target_id: string;
  readonly absent: boolean;
  readonly receipt_ref: string;
  readonly reason_code?: string;
}

export interface ErasureBackend {
  acquire(request: ErasureRequest): Promise<ErasureAcquireResult>;
  quarantineAndRevoke(request: ErasureRequest, fence: ErasureFence): Promise<string>;
  advanceLifecycle(
    request: ErasureRequest,
    fence: ErasureFence,
    expectedState: string,
    nextState: string,
    payloadDigest: string,
  ): Promise<string>;
  enumerateDependencyClosure(
    request: ErasureRequest,
    fence: ErasureFence,
  ): Promise<ErasureDependencyClosure>;
  checkRetentionAndHolds(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
  ): Promise<readonly ErasureBlocker[]>;
  recordBlockedTarget(
    request: ErasureRequest,
    fence: ErasureFence,
    target: PurgeTarget,
    blocker: ErasureBlocker,
  ): Promise<void>;
  purge(
    request: ErasureRequest,
    fence: ErasureFence,
    target: PurgeTarget,
  ): Promise<PurgeAttemptReceipt>;
  verifyAbsent(
    request: ErasureRequest,
    fence: ErasureFence,
    target: PurgeTarget,
    purgeReceipt: PurgeAttemptReceipt,
  ): Promise<AbsenceVerificationReceipt>;
  appendNonRevealingLedgerEntry(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
    completedTargets: readonly PurgeTarget[],
    blockers: readonly ErasureBlocker[],
  ): Promise<{ readonly ledger_entry_ref: string; readonly ledger_revision: number }>;
  invalidateDependents(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
    ledgerEntryRef: string,
  ): Promise<readonly string[]>;
  complete(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
    completedTargets: readonly PurgeTarget[],
    ledger: { readonly ledger_entry_ref: string; readonly ledger_revision: number },
  ): Promise<ErasureReceipt>;
  block(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
    completedTargets: readonly PurgeTarget[],
    blockers: readonly ErasureBlocker[],
    ledger: { readonly ledger_entry_ref: string; readonly ledger_revision: number },
  ): Promise<ErasureReceipt>;
  fail(request: ErasureRequest, fence: ErasureFence, errorCode: string): Promise<void>;
}
