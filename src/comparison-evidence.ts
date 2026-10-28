import type { Citation } from "./citations.js";
import type { ComparisonClaim } from "./comparisons.js";
import { numbersSupported, parseSingleNumber } from "./numbers.js";
import type { WikiEvidence } from "./knowledge.js";

/** A source-text-derived result row considered by the K6 project map. */
export interface SourceResultCandidate {
  readonly role: "own" | "baseline" | "unknown";
  readonly label: string;
  readonly protocolLabels: string[];
  readonly method: string;
  readonly task: string;
  readonly metric: string;
  readonly dataset: string;
  readonly valueText: string;
  readonly unit: string;
  readonly conditions: string;
  readonly evaluationConditions: string;
}

type ExtendedComparisonClaim = ComparisonClaim & {
  readonly evaluationConditions?: string;
  readonly protocolCitations?: Citation[];
};

const MAX_METADATA_LENGTH = 512;
const MAX_METADATA_TOTAL_LENGTH = 4096;
const MAX_LABEL_LENGTH = 256;
const MAX_PROTOCOL_LABELS = 16;
const INLINE_CITATION_TOKEN = /\[(?:S\d+:[^\]\r\n]+|R[^:\]\r\n]+:\d+)\]/;

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function hasInlineCitationToken(value: string): boolean {
  return INLINE_CITATION_TOKEN.test(value);
}

function validEvidence(item: WikiEvidence): boolean {
  const citation = item.citation;
  return typeof item.quote === "string"
    && item.quote.trim().length > 0
    && typeof citation.sourceId === "string" && citation.sourceId.length > 0
    && typeof citation.revisionId === "string" && citation.revisionId.length > 0
    && boundedText(citation.sourceTitle, 2048)
    && Number.isSafeInteger(citation.block) && citation.block >= 0
    && Number.isSafeInteger(citation.start) && citation.start >= 0
    && Number.isSafeInteger(citation.end) && citation.end > citation.start
    && citation.label === `[R${citation.revisionId}:${citation.block}]`;
}

function evidenceByUniqueLabel(evidence: readonly WikiEvidence[]): Map<string, WikiEvidence> {
  const byLabel = new Map<string, WikiEvidence>();
  const duplicateLabels = new Set<string>();
  for (const item of evidence) {
    if (!validEvidence(item)) continue;
    const label = item.citation.label;
    if (byLabel.has(label)) {
      byLabel.delete(label);
      duplicateLabels.add(label);
    } else if (!duplicateLabels.has(label)) {
      byLabel.set(label, item);
    }
  }
  return byLabel;
}

function hasValidMetadata(candidate: SourceResultCandidate): boolean {
  const values = [
    candidate.method,
    candidate.task,
    candidate.metric,
    candidate.dataset,
    candidate.valueText,
    candidate.unit,
    candidate.conditions,
    candidate.evaluationConditions,
  ];
  return values.every((value) => boundedText(value, MAX_METADATA_LENGTH)
    && !hasInlineCitationToken(value))
    && values.reduce((total, value) => total + value.length, 0) <= MAX_METADATA_TOTAL_LENGTH;
}

function resultId(
  sourceId: string,
  label: string,
  candidate: SourceResultCandidate,
): string {
  return `source-result:${JSON.stringify([
    sourceId,
    label,
    candidate.method,
    candidate.task,
    candidate.metric,
    candidate.valueText,
  ])}`;
}

/**
 * Projects only owned, scalar source results whose value and protocol labels
 * resolve to the same frozen source revision. It preserves the value passage
 * and its original byte range; candidate-provided identifiers are never used.
 */
export function projectComparisonResults(
  candidates: readonly SourceResultCandidate[],
  evidence: readonly WikiEvidence[],
): ComparisonClaim[] {
  const byLabel = evidenceByUniqueLabel(evidence);
  const projected: ComparisonClaim[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.role !== "own"
      || !boundedText(candidate.label, MAX_LABEL_LENGTH)
      || !Array.isArray(candidate.protocolLabels)
      || candidate.protocolLabels.length > MAX_PROTOCOL_LABELS
      || !candidate.protocolLabels.every((label) => boundedText(label, MAX_LABEL_LENGTH))
      || !hasValidMetadata(candidate)) {
      continue;
    }

    const valueEvidence = byLabel.get(candidate.label);
    if (!valueEvidence) continue;
    const valueCitation = valueEvidence.citation;
    const protocolEvidence: WikiEvidence[] = [];
    const protocolLabelsSeen = new Set<string>();
    let validProtocols = true;
    for (const label of candidate.protocolLabels) {
      if (protocolLabelsSeen.has(label)) continue;
      protocolLabelsSeen.add(label);
      const item = byLabel.get(label);
      if (!item
        || item.citation.sourceId !== valueCitation.sourceId
        || item.citation.revisionId !== valueCitation.revisionId) {
        validProtocols = false;
        break;
      }
      protocolEvidence.push(item);
    }
    if (!validProtocols) continue;

    const valueNumber = parseSingleNumber(candidate.valueText);
    if (valueNumber === null || !Number.isFinite(valueNumber)
      || !numbersSupported(candidate.valueText, valueEvidence.quote)) {
      continue;
    }

    const supportQuotes = [valueEvidence.quote, ...protocolEvidence.map((item) => item.quote)];
    const supportText = supportQuotes.join("\n");
    const statement = `${candidate.method.trim()} — ${candidate.metric.trim()}: ${candidate.valueText}`;
    if (!numbersSupported(statement, supportText)
      || !numbersSupported(candidate.conditions, supportText)
      || !numbersSupported(candidate.evaluationConditions, supportText)) {
      continue;
    }

    const id = resultId(valueCitation.sourceId, valueCitation.label, candidate);
    if (seen.has(id)) continue;
    seen.add(id);

    const protocolCitations = protocolEvidence
      .filter((item) => item.citation.label !== valueCitation.label)
      .map((item) => ({ ...item.citation }));
    const claim: ExtendedComparisonClaim = {
      id,
      sourceId: valueCitation.sourceId,
      revisionId: valueCitation.revisionId,
      kind: "result",
      statement,
      quote: valueEvidence.quote,
      block: valueCitation.block,
      start: valueCitation.start,
      end: valueCitation.end,
      ambiguous: false,
      task: candidate.task,
      metric: candidate.metric,
      dataset: candidate.dataset,
      valueText: candidate.valueText,
      valueNumber,
      unit: candidate.unit,
      conditions: candidate.conditions,
      evaluationConditions: candidate.evaluationConditions,
      ...(protocolCitations.length > 0 ? { protocolCitations } : {}),
    };
    projected.push(claim);
  }

  return projected;
}
