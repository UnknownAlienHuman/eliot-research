import {
  InquiryProtocolProfileSchema,
  type EvidenceGrade,
  type InquiryObligation,
  type InquiryProtocolProfile,
  type VersionedRef,
} from "@eliotr/contracts";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { LedgerObligation } from "@eliotr/research";

export const RESEARCH_RUN_REQUEST_V2 = "eliotr.research-run-request.v2" as const;

export const INSTALLED_INQUIRY_PROTOCOL_REFS = Object.freeze({
  lookup: Object.freeze({ id: "eliotr.research.profile.corpus-exploratory-lookup", revision: 1 }),
  evidence_review: Object.freeze({ id: "eliotr.research.profile.corpus-evidence-review", revision: 1 }),
  architecture_decision: Object.freeze({ id: "eliotr.research.profile.corpus-architecture-decision", revision: 1 }),
}) satisfies Readonly<Record<string, VersionedRef>>;

export type InstalledInquiryProtocolName = keyof typeof INSTALLED_INQUIRY_PROTOCOL_REFS;

interface ObligationDefinition {
  readonly suffix: string;
  readonly kind: string;
  readonly dependencies: readonly string[];
  readonly verifier_ref: string;
  readonly certificate_kind: string;
  readonly lane: "confirmatory" | "exploratory";
  readonly metric_ref: string;
  readonly blocking: boolean;
}

export interface InstalledInquiryProtocolDefinition {
  readonly name: InstalledInquiryProtocolName;
  readonly definition_ref: VersionedRef;
  readonly allowed_grades: readonly EvidenceGrade[];
  readonly intended_decision_or_artifact: string;
  readonly protocol: InquiryProtocolProfile["protocol"];
  readonly lane: InquiryProtocolProfile["lane"];
  readonly source_mode: InquiryProtocolProfile["source_mode"];
  readonly admissible_provider_classes: readonly string[];
  readonly truth_surfaces: readonly string[];
  readonly source_policy: {
    readonly primary_required: boolean;
    readonly peer_reviewed_preferred: boolean;
    readonly authority_classes: readonly string[];
    readonly excluded_classes: readonly string[];
  };
  readonly coverage_goal: InquiryProtocolProfile["coverage_goal"];
  readonly alternatives_required: boolean;
  readonly counter_search_required: boolean;
  readonly falsification_required: boolean;
  readonly independence_policy_ref: string;
  readonly chronology_policy_ref: string;
  readonly fidelity_ceiling: string;
  readonly budget_ref: string;
  readonly stop_rule_ref: string;
  readonly output_contract_ref: string;
  readonly reopen_conditions: readonly string[];
  readonly completeness_test_ref: string;
  readonly external_acquisition: "none";
  readonly required_source_classes: readonly string[];
  readonly required_question_branches: readonly string[];
  readonly obligations: readonly ObligationDefinition[];
}

const COMMON = Object.freeze({
  source_mode: "corpus_only" as const,
  admissible_provider_classes: Object.freeze(["admitted-corpus"]),
  truth_surfaces: Object.freeze(["admitted-source-revisions"]),
  source_policy: Object.freeze({
    primary_required: false,
    peer_reviewed_preferred: false,
    authority_classes: Object.freeze(["owner-admitted-source"]),
    excluded_classes: Object.freeze([]),
  }),
  independence_policy_ref: "eliotr.research.independence.corpus-source-v1",
  chronology_policy_ref: "eliotr.research.chronology.frozen-source-revisions-v1",
  fidelity_ceiling: "eliotr.research.fidelity.normalized-text-coordinates-v1",
  budget_ref: "research-budget-v1",
  external_acquisition: "none" as const,
});

const GROUNDING: ObligationDefinition = Object.freeze({
  suffix: "grounding",
  kind: "exact-evidence-grounding",
  dependencies: Object.freeze([]),
  verifier_ref: "eliotr.verifier.exact-evidence.v1",
  certificate_kind: "eliotr.certificate.exact-evidence.v1",
  lane: "exploratory",
  metric_ref: "eliotr.metric.material-claim-support.v1",
  blocking: true,
});
const COVERAGE: ObligationDefinition = Object.freeze({
  suffix: "coverage",
  kind: "coverage-accounting",
  dependencies: Object.freeze(["grounding"]),
  verifier_ref: "eliotr.verifier.coverage-receipt.v1",
  certificate_kind: "eliotr.certificate.coverage-receipt.v1",
  lane: "exploratory",
  metric_ref: "eliotr.metric.coverage-honesty.v1",
  blocking: true,
});
const COUNTER: ObligationDefinition = Object.freeze({
  suffix: "counterevidence",
  kind: "counterevidence-search",
  dependencies: Object.freeze(["grounding"]),
  verifier_ref: "eliotr.verifier.counterevidence.v1",
  certificate_kind: "eliotr.certificate.counterevidence.v1",
  lane: "exploratory",
  metric_ref: "eliotr.metric.counterevidence-considered.v1",
  blocking: true,
});
const ALTERNATIVES: ObligationDefinition = Object.freeze({
  suffix: "alternatives",
  kind: "rival-alternatives",
  dependencies: Object.freeze(["grounding", "counterevidence"]),
  verifier_ref: "eliotr.verifier.alternatives.v1",
  certificate_kind: "eliotr.certificate.alternatives.v1",
  lane: "exploratory",
  metric_ref: "eliotr.metric.material-alternatives-considered.v1",
  blocking: true,
});
const IMPLEMENTATION: ObligationDefinition = Object.freeze({
  suffix: "implementation-state",
  kind: "implementation-state-separation",
  dependencies: Object.freeze(["grounding"]),
  verifier_ref: "eliotr.verifier.implementation-state.v1",
  certificate_kind: "eliotr.certificate.implementation-state.v1",
  lane: "exploratory",
  metric_ref: "eliotr.metric.spec-code-runtime-separated.v1",
  blocking: true,
});

const DEFINITIONS: Readonly<Record<InstalledInquiryProtocolName, InstalledInquiryProtocolDefinition>> = Object.freeze({
  lookup: Object.freeze({
    ...COMMON,
    name: "lookup",
    definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup,
    allowed_grades: Object.freeze(["E0", "E1", "E2"] as const),
    intended_decision_or_artifact: "bounded corpus lookup draft with exact evidence handles",
    protocol: "lookup",
    lane: "exploratory",
    coverage_goal: "exploratory",
    alternatives_required: false,
    counter_search_required: false,
    falsification_required: false,
    stop_rule_ref: "eliotr.research.stop.one-bounded-corpus-retrieval-v1",
    output_contract_ref: "eliotr.research.output.draft-answer-with-exact-handles-v1",
    reopen_conditions: Object.freeze([
      "A changed ScopeSnapshot requires a new W1 investigation revision.",
      "Exploratory output cannot be promoted to a confirmatory claim without a declared protocol.",
    ]),
    completeness_test_ref: "eliotr.research.coverage.exploratory-membership-observation-v1",
    required_source_classes: Object.freeze([]),
    required_question_branches: Object.freeze([]),
    obligations: Object.freeze([GROUNDING, COVERAGE]),
  }),
  evidence_review: Object.freeze({
    ...COMMON,
    name: "evidence_review",
    definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review,
    allowed_grades: Object.freeze(["E1", "E2"] as const),
    intended_decision_or_artifact: "bounded evidence review with support, counterevidence and explicit coverage limits",
    protocol: "evidence_review",
    lane: "exploratory",
    coverage_goal: "high_recall",
    alternatives_required: false,
    counter_search_required: true,
    falsification_required: false,
    stop_rule_ref: "eliotr.research.stop.one-bounded-corpus-retrieval-v1",
    output_contract_ref: "eliotr.research.output.draft-answer-with-exact-handles-v1",
    reopen_conditions: Object.freeze([
      "New admitted evidence outside the frozen scope requires explicit reopening.",
      "An unresolved material contradiction remains a ResearchDebt.",
    ]),
    completeness_test_ref: "eliotr.research.coverage.exploratory-membership-observation-v1",
    required_source_classes: Object.freeze(["supporting-evidence", "counterevidence"]),
    required_question_branches: Object.freeze(["SUPPORT", "COUNTER"]),
    obligations: Object.freeze([GROUNDING, COUNTER, COVERAGE]),
  }),
  architecture_decision: Object.freeze({
    ...COMMON,
    name: "architecture_decision",
    definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision,
    allowed_grades: Object.freeze(["E1", "E2"] as const),
    intended_decision_or_artifact: "architecture decision record with alternatives, implementation state and counterevidence",
    protocol: "architecture_decision",
    lane: "exploratory",
    coverage_goal: "representative",
    alternatives_required: true,
    counter_search_required: true,
    falsification_required: true,
    stop_rule_ref: "eliotr.research.stop.one-bounded-corpus-retrieval-v1",
    output_contract_ref: "eliotr.research.output.draft-answer-with-exact-handles-v1",
    reopen_conditions: Object.freeze([
      "A changed implementation or normative source revision requires explicit reopening.",
      "A newly discovered material alternative requires a versioned supersession or reopen.",
    ]),
    completeness_test_ref: "eliotr.research.coverage.exploratory-membership-observation-v1",
    required_source_classes: Object.freeze(["project-evidence", "normative-or-empirical-evidence"]),
    required_question_branches: Object.freeze(["SUPPORT", "COUNTER", "ALTERNATIVE", "IMPLEMENTATION", "SOURCE_AUDIT"]),
    obligations: Object.freeze([GROUNDING, COUNTER, ALTERNATIVES, IMPLEMENTATION, COVERAGE]),
  }),
});

export class InstalledInquiryProtocolError extends Error {
  public constructor(
    public readonly code: "INQUIRY_PROTOCOL_UNSUPPORTED" | "INQUIRY_PROTOCOL_GRADE_UNSUPPORTED" | "INQUIRY_PROTOCOL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "InstalledInquiryProtocolError";
  }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function installedInquiryProtocolDefinition(ref: VersionedRef): InstalledInquiryProtocolDefinition {
  for (const definition of Object.values(DEFINITIONS)) {
    if (sameRef(definition.definition_ref, ref)) return definition;
  }
  throw new InstalledInquiryProtocolError("INQUIRY_PROTOCOL_UNSUPPORTED", "inquiry protocol is not installed");
}

export function defaultInquiryProtocolRef(): VersionedRef {
  return { ...INSTALLED_INQUIRY_PROTOCOL_REFS.lookup };
}

function obligationId(definition: InstalledInquiryProtocolDefinition, suffix: string): string {
  return `${definition.name}:${suffix}`;
}

function compileObligations(definition: InstalledInquiryProtocolDefinition): InquiryObligation[] {
  return definition.obligations.map((obligation) => ({
    obligation_id: obligationId(definition, obligation.suffix),
    kind: obligation.kind,
    dependency_obligation_ids: obligation.dependencies.map((suffix) => obligationId(definition, suffix)),
    verifier_ref: obligation.verifier_ref,
    certificate_kind: obligation.certificate_kind,
    lane: obligation.lane,
    metric_ref: obligation.metric_ref,
    blocking: obligation.blocking,
  }));
}

export function compileInquiryLedgerObligations(definition: InstalledInquiryProtocolDefinition): LedgerObligation[] {
  return compileObligations(definition).map((obligation) => ({
    ...obligation,
    status: "REGISTERED",
    exposed: false,
  }));
}

export interface CompileInstalledInquiryProtocolInput {
  readonly definition_ref: VersionedRef;
  readonly question: string;
  readonly evidence_grade: EvidenceGrade;
  readonly model_profile_ref: string;
  /** Omit only for historical/unversioned lookup requests. */
  readonly include_obligations?: boolean;
}

export interface CompiledInstalledInquiryProtocol {
  readonly definition: InstalledInquiryProtocolDefinition;
  readonly profile: InquiryProtocolProfile;
  readonly identity_digest: string;
  readonly ledger_obligations: readonly LedgerObligation[];
}

export async function compileInstalledInquiryProtocol(
  input: CompileInstalledInquiryProtocolInput,
): Promise<CompiledInstalledInquiryProtocol> {
  const definition = installedInquiryProtocolDefinition(input.definition_ref);
  if (!definition.allowed_grades.includes(input.evidence_grade)) {
    throw new InstalledInquiryProtocolError(
      "INQUIRY_PROTOCOL_GRADE_UNSUPPORTED",
      "requested evidence grade is not supported by the installed inquiry protocol",
    );
  }
  const fields: Omit<InquiryProtocolProfile, "profile_ref"> = {
    question: input.question,
    intended_decision_or_artifact: definition.intended_decision_or_artifact,
    protocol: definition.protocol,
    evidence_grade: input.evidence_grade,
    lane: definition.lane,
    source_mode: definition.source_mode,
    admissible_provider_classes: [...definition.admissible_provider_classes],
    truth_surfaces: [...definition.truth_surfaces],
    source_policy: {
      primary_required: definition.source_policy.primary_required,
      peer_reviewed_preferred: definition.source_policy.peer_reviewed_preferred,
      authority_classes: [...definition.source_policy.authority_classes],
      excluded_classes: [...definition.source_policy.excluded_classes],
    },
    coverage_goal: definition.coverage_goal,
    alternatives_required: definition.alternatives_required,
    counter_search_required: definition.counter_search_required,
    falsification_required: definition.falsification_required,
    independence_policy_ref: definition.independence_policy_ref,
    chronology_policy_ref: definition.chronology_policy_ref,
    fidelity_ceiling: definition.fidelity_ceiling,
    model_profile_ref: input.model_profile_ref,
    budget_ref: definition.budget_ref,
    stop_rule_ref: definition.stop_rule_ref,
    output_contract_ref: definition.output_contract_ref,
    reopen_conditions: [...definition.reopen_conditions],
    ...(input.include_obligations === false ? {} : { obligations: compileObligations(definition) }),
  };
  const identity_digest = await evidenceSha256(fields);
  const profile = InquiryProtocolProfileSchema.parse({
    profile_ref: { id: `eliotr.research.compiled-profile-${identity_digest}`, revision: 1 },
    ...fields,
  });
  return {
    definition,
    profile,
    identity_digest,
    ledger_obligations: compileInquiryLedgerObligations(definition),
  };
}

export function assertInstalledInquiryProtocolProfile(
  definitionRef: VersionedRef,
  profile: InquiryProtocolProfile,
): InstalledInquiryProtocolDefinition {
  const definition = installedInquiryProtocolDefinition(definitionRef);
  if (!definition.allowed_grades.includes(profile.evidence_grade) ||
      profile.intended_decision_or_artifact !== definition.intended_decision_or_artifact ||
      profile.protocol !== definition.protocol || profile.lane !== definition.lane ||
      profile.source_mode !== definition.source_mode || profile.coverage_goal !== definition.coverage_goal ||
      profile.alternatives_required !== definition.alternatives_required ||
      profile.counter_search_required !== definition.counter_search_required ||
      profile.falsification_required !== definition.falsification_required ||
      profile.independence_policy_ref !== definition.independence_policy_ref ||
      profile.chronology_policy_ref !== definition.chronology_policy_ref ||
      profile.fidelity_ceiling !== definition.fidelity_ceiling || profile.budget_ref !== definition.budget_ref ||
      profile.stop_rule_ref !== definition.stop_rule_ref || profile.output_contract_ref !== definition.output_contract_ref ||
      JSON.stringify(profile.admissible_provider_classes) !== JSON.stringify(definition.admissible_provider_classes) ||
      JSON.stringify(profile.truth_surfaces) !== JSON.stringify(definition.truth_surfaces) ||
      JSON.stringify(profile.source_policy) !== JSON.stringify(definition.source_policy) ||
      JSON.stringify(profile.reopen_conditions) !== JSON.stringify(definition.reopen_conditions) ||
      (profile.obligations === undefined
        ? definition.name !== "lookup"
        : JSON.stringify(profile.obligations) !== JSON.stringify(compileObligations(definition)))) {
    throw new InstalledInquiryProtocolError("INQUIRY_PROTOCOL_INVALID", "compiled inquiry protocol does not match its installed definition");
  }
  return definition;
}
