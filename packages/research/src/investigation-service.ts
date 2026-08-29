import type { Investigation, InquiryProtocolProfile, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import type { ResearchRunResult } from "./ports.js";

export interface CreateInvestigationInput {
  readonly goal: string;
  readonly intended_decision_or_artifact: string;
  readonly interpretations: readonly string[];
  readonly scope_snapshot: ScopeSnapshot;
  readonly protocol: InquiryProtocolProfile;
  readonly execution_product: Investigation["execution_product"];
  readonly model_profile_ref: string;
  readonly budget_ref: string;
  readonly stop_rule_ref: string;
  readonly parent_investigation_ref?: VersionedRef;
}

export interface InvestigationService {
  create(input: CreateInvestigationInput): Promise<Investigation>;
  start(investigationRef: VersionedRef, idempotencyKey: string): Promise<{ workflow_instance_id: string }>;
  cancel(investigationRef: VersionedRef, reason: string): Promise<VersionedRef>;
  reopen(investigationRef: VersionedRef, reason: string, affectedClaimRefs: readonly string[]): Promise<Investigation>;
  status(investigationRef: VersionedRef): Promise<Investigation>;
  result(investigationRef: VersionedRef): Promise<ResearchRunResult | null>;
}
