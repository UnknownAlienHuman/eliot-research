export interface NamespaceCommand {
  readonly protocol: "eliotr.local-namespace-init.v1";
  readonly namespace: string;
  readonly owner_incarnation_ref: string;
  readonly expected_ownership_revision: 0;
  readonly expected_policy_revision: 0;
  readonly created_at: string;
  readonly policy: {
    readonly allowed_ownership_modes: readonly ["immutable_import"];
    readonly source_class: string;
    readonly assurance_ceiling: "LOCATOR_ONLY" | "CAPTURED" | "QUALIFIED";
    readonly instruction_taint: "DATA_ONLY" | "UNTRUSTED" | "COMMAND_LIKE";
    readonly allowed_effects: "READ_ONLY" | "CANDIDATE_ONLY" | "NO_EXTERNAL_EFFECT";
    readonly allowed_use: readonly string[];
    readonly disclosure_ceiling: string;
    readonly license_policy_ref: string;
    readonly default_storage_policy: "NORMALIZED_CLOUD_ONLY";
    readonly default_residency_profile_id: string;
    readonly default_retention_policy_id: string;
    readonly minimum_quality_state: "high_fidelity" | "standard" | "degraded";
  };
}
export interface NamespaceReceipt {
  readonly protocol: "eliotr.local-namespace-init.v1";
  readonly state: "INITIALIZED_OR_REPLAY";
  readonly ownership: {
    readonly source_namespace_id: string;
    readonly ownership_record_revision: 1;
    readonly owner_system_id: "eliotr";
    readonly owner_incarnation_ref: string;
    readonly source_owner_generation: string;
    readonly source_admission_policy_revision: 1;
    readonly status: "ACTIVE";
    readonly cutover_receipt_ref: null;
    readonly created_at: string;
  };
  readonly admission_policy: Readonly<Record<string, string | number>>;
  readonly command_sha256: string;
  readonly read_access_granted: false;
  readonly remote_effects: "NOT_EXECUTED";
}
export function validateNamespaceCommand(command: unknown, now?: number): NamespaceCommand;
/** The caller, not this helper, supplies a signature-verified owner and a local-only D1 adapter. */
export function initializeLocalNamespace(input: {
  readonly command: unknown;
  readonly identity: unknown;
  readonly query: (sql: string) => Promise<readonly Record<string, unknown>[]>;
  readonly now?: () => number;
}): Promise<NamespaceReceipt>;
