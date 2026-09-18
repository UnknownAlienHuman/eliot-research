import {
  parseResearchPlanningManifest,
  type ResearchPlanningManifest,
  type VersionedRef,
} from "@eliotr/contracts";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { InstalledInquiryProtocolDefinition } from "./research-inquiry-protocol.js";

export interface ResearchPlanningSourceFact {
  readonly source_revision_ref: string;
  readonly source_id: string;
  readonly source_class: string;
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
  readonly origin_uri?: string | null;
}

export interface ResearchPlanningManifestInput {
  readonly investigation_id: string;
  readonly operation_id: string;
  readonly question: string;
  readonly inquiry_protocol_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_created_at: string;
  readonly definition: InstalledInquiryProtocolDefinition;
  readonly sources: readonly ResearchPlanningSourceFact[];
}

type QuestionKind = ResearchPlanningManifest["questions"][number]["kind"];

const ROLE_KIND: Readonly<Record<string, QuestionKind>> = Object.freeze({
  SUPPORT: "support",
  COUNTER: "counter",
  ALTERNATIVE: "alternative",
  CHRONOLOGY: "chronology",
  IMPLEMENTATION: "implementation",
  LITERATURE: "literature",
  SOURCE_AUDIT: "source_audit",
});

const ROLE_QUESTION: Readonly<Record<string, string>> = Object.freeze({
  SUPPORT: "What exact admitted evidence supports the primary question?",
  COUNTER: "What material counterevidence or contradiction challenges the primary question?",
  ALTERNATIVE: "What material rival explanation or alternative should be compared?",
  CHRONOLOGY: "What dated events and temporal uncertainties matter to the primary question?",
  IMPLEMENTATION: "What differs between specification, implementation and observed execution?",
  LITERATURE: "What primary, secondary and origin evidence bears on the primary question?",
  SOURCE_AUDIT: "What provenance, independence, qualification and precision limitations affect the answer?",
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizedOrigin(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.toString();
  } catch {
    return value;
  }
}

async function stableIdentifier(prefix: string, value: unknown): Promise<string> {
  return `${prefix}-${(await evidenceSha256(value)).slice(0, 48)}`;
}

async function sourceFamilyRef(source: ResearchPlanningSourceFact): Promise<string> {
  const origin = normalizedOrigin(source.origin_uri);
  return stableIdentifier("source-family", origin === null ? { source_id: source.source_id } : { origin_uri: origin });
}

async function buildQuestions(input: ResearchPlanningManifestInput) {
  const primaryId = await stableIdentifier("question", {
    protocol_ref: input.inquiry_protocol_ref,
    scope_ref: input.scope_snapshot_ref,
    kind: "primary",
    text: input.question,
  });
  const questions: ResearchPlanningManifest["questions"][number][] = [{
    question_id: primaryId,
    text: input.question,
    kind: "primary",
    dependency_question_ids: [],
  }];
  for (const role of uniqueSorted(input.definition.required_question_branches)) {
    const kind = ROLE_KIND[role];
    const text = ROLE_QUESTION[role];
    if (kind === undefined || text === undefined) throw new RangeError(`unsupported installed research branch role ${role}`);
    questions.push({
      question_id: await stableIdentifier("question", {
        protocol_ref: input.inquiry_protocol_ref,
        scope_ref: input.scope_snapshot_ref,
        role,
        primary_question_id: primaryId,
      }),
      text,
      kind,
      dependency_question_ids: [primaryId],
    });
  }
  return { primaryId, questions };
}

async function buildHypotheses(
  input: ResearchPlanningManifestInput,
  primaryQuestionId: string,
): Promise<ResearchPlanningManifest["hypotheses"]> {
  if (!input.definition.falsification_required && !input.definition.alternatives_required) return [];
  const candidateId = await stableIdentifier("hypothesis", {
    protocol_ref: input.inquiry_protocol_ref,
    question_id: primaryQuestionId,
    role: "candidate",
  });
  const rivalId = await stableIdentifier("hypothesis", {
    protocol_ref: input.inquiry_protocol_ref,
    question_id: primaryQuestionId,
    role: "rival",
  });
  return [
    {
      hypothesis_id: candidateId,
      question_id: primaryQuestionId,
      statement: "The candidate decision or explanation in the primary question satisfies the stated constraints.",
      origin: "protocol_required",
      prediction: "Admitted project, normative and empirical evidence consistently supports the candidate under the stated conditions.",
      falsifier: "A material contradiction, failed implementation check, or better supported alternative defeats the candidate under the stated conditions.",
      alternative_hypothesis_ids: [rivalId],
    },
    {
      hypothesis_id: rivalId,
      question_id: primaryQuestionId,
      statement: "A material alternative satisfies the stated constraints better than the candidate decision or explanation.",
      origin: "protocol_required",
      prediction: "At least one admitted alternative has stronger support or avoids a material contradiction affecting the candidate.",
      falsifier: "No admitted alternative survives exact support, counterevidence and implementation-state checks within the frozen scope.",
      alternative_hypothesis_ids: [candidateId],
    },
  ];
}

export async function createResearchPlanningManifest(
  input: ResearchPlanningManifestInput,
): Promise<ResearchPlanningManifest> {
  if (input.definition.definition_ref.id !== input.inquiry_protocol_ref.id ||
      input.definition.definition_ref.revision !== input.inquiry_protocol_ref.revision) {
    throw new RangeError("planning definition does not match the selected inquiry protocol");
  }
  const { primaryId, questions } = await buildQuestions(input);
  const hypotheses = await buildHypotheses(input, primaryId);
  const withFamilies = await Promise.all(input.sources.map(async (source) => ({
    source_revision_ref: source.source_revision_ref,
    source_id: source.source_id,
    source_class: source.source_class,
    source_namespace_id: source.source_namespace_id,
    source_owner_generation: source.source_owner_generation,
    source_family_ref: await sourceFamilyRef(source),
  })));
  const familyCounts = new Map<string, number>();
  for (const source of withFamilies) familyCounts.set(source.source_family_ref, (familyCounts.get(source.source_family_ref) ?? 0) + 1);
  const members = withFamilies
    .map((source) => ({
      ...source,
      independence: (familyCounts.get(source.source_family_ref) ?? 0) > 1 ? "KNOWN_SHARED_ORIGIN" as const : "UNKNOWN" as const,
    }))
    .sort((left, right) => compareText(left.source_revision_ref, right.source_revision_ref));
  const requiredSourceClasses = uniqueSorted(input.definition.required_source_classes);
  const representedSourceClasses = uniqueSorted(members.map((source) => source.source_class));
  const represented = new Set(representedSourceClasses);
  const missingSourceClasses = requiredSourceClasses.filter((value) => !represented.has(value));
  const sharedFamilies = uniqueSorted(members.filter((source) => source.independence === "KNOWN_SHARED_ORIGIN").map((source) => source.source_family_ref));
  const independenceLimitations = [
    ...(members.length === 0 ? ["The frozen scope contains no admitted source revisions."] : []),
    ...(members.some((source) => source.independence === "UNKNOWN") ? ["Independence is unknown for source families without an explicit shared-origin witness."] : []),
    ...sharedFamilies.map((family) => `Multiple revisions or sources share origin family ${family}; they do not count as independent evidence.`),
  ];
  const identity = {
    protocol: "eliotr.research-planning-manifest.v1" as const,
    investigation_id: input.investigation_id,
    operation_id: input.operation_id,
    inquiry_protocol_ref: input.inquiry_protocol_ref,
    scope_snapshot_ref: input.scope_snapshot_ref,
    primary_question_id: primaryId,
    questions,
    hypotheses,
    source_portfolio: {
      members,
      required_source_classes: requiredSourceClasses,
      represented_source_classes: representedSourceClasses,
      missing_source_classes: missingSourceClasses,
      independence_limitations: independenceLimitations,
    },
    required_branch_roles: uniqueSorted(input.definition.required_question_branches),
    created_at: input.scope_created_at,
  };
  const identityDigest = await evidenceSha256(identity);
  return parseResearchPlanningManifest({
    ...identity,
    manifest_ref: { id: `eliotr.research.planning-${identityDigest}`, revision: 1 },
    identity_digest: identityDigest,
  });
}

export async function assertResearchPlanningManifestIdentity(
  value: ResearchPlanningManifest,
): Promise<ResearchPlanningManifest> {
  const parsed = parseResearchPlanningManifest(value);
  const { manifest_ref: _manifestRef, identity_digest: _identityDigest, ...identity } = parsed;
  const digest = await evidenceSha256(identity);
  if (digest !== parsed.identity_digest || parsed.manifest_ref.id !== `eliotr.research.planning-${digest}`) {
    throw new RangeError("planning manifest identity digest is invalid");
  }
  return parsed;
}
