import { z } from "zod";
import type { WikiEvidence } from "./knowledge";
import { numbersSupported } from "./numbers";

export interface WikiOutput {
  readonly sections: readonly WikiOutputSection[];
}

export interface WikiOutputSection {
  readonly labels: readonly string[];
  readonly text: string;
}

export interface WikiOutputCheck {
  readonly body: string;
  readonly citations: WikiEvidence["citation"][];
  readonly kept: number;
  readonly dropped: { readonly index: number; readonly reason: string }[];
  readonly missingSourceIds: string[];
}

const MAX_SECTIONS = 24;
const MAX_TEXT_LENGTH = 1500;
const MAX_LABELS_PER_SECTION = 4;
const INLINE_CITATION = /\[(?:R|S)[^\]]*\]/;
const HEADING_OR_LIST = /^(?:\s{0,3}#{1,6}(?:\s|$)|\s{0,3}(?:[-*+]\s|\d+[.)]\s))/;

/**
 * Builds a labels-first output schema whose citation vocabulary is limited to
 * the exact passages frozen for this Wiki attempt. Text remains untrimmed and
 * is checked item-by-item by checkWikiOutput so storage-only callers can
 * retain valid sentences without repairing, clipping, or reassigning output.
 */
export function wikiSchema(evidence: readonly WikiEvidence[]) {
  const labels = [...new Set(evidence
    .map((item) => item.citation.label)
    .filter((label) => typeof label === "string" && label.length > 0))];
  if (labels.length === 0) throw new Error("A Wiki schema needs at least one declared evidence label.");
  const declaredLabels = z.enum(labels as [string, ...string[]]);
  return z.object({
    sections: z.array(z.object({
      labels: z.array(declaredLabels).min(1).max(MAX_LABELS_PER_SECTION)
        .describe("Select one to four exact original passage labels first. Preserve their identity; do not invent, rewrite, or reassign a label."),
      text: z.string().min(1).max(MAX_TEXT_LENGTH)
        .describe("One complete factual sentence only, supported by the selected passages. No headings, lists, inline citation labels, new quotes, or clipped text."),
    }).strict()).min(1).max(MAX_SECTIONS),
  }).strict();
}

function evidenceByUniqueLabel(evidence: readonly WikiEvidence[]): { byLabel: Map<string, WikiEvidence>; ambiguous: Set<string> } {
  const byLabel = new Map<string, WikiEvidence>();
  const ambiguous = new Set<string>();
  for (const item of evidence) {
    const label = item.citation.label;
    if (typeof label !== "string" || label.length === 0) continue;
    if (byLabel.has(label)) {
      byLabel.delete(label);
      ambiguous.add(label);
      continue;
    }
    if (!ambiguous.has(label)) byLabel.set(label, item);
  }
  return { byLabel, ambiguous };
}

function invalidTextReason(text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0 || text.trim() !== text) return "invalid-text";
  if (text.length > MAX_TEXT_LENGTH) return "text-too-long";
  if (/[\r\n]/.test(text) || HEADING_OR_LIST.test(text)) return "heading-or-multiline-text";
  if (INLINE_CITATION.test(text)) return "inline-citation-label";
  return null;
}

/**
 * Keeps only complete items with exact declared evidence labels and supported
 * numbers. Invalid items are dropped whole; accepted text and citations are
 * copied verbatim from the output/evidence without paraphrase, clipping,
 * quote synthesis, or citation reassignment.
 */
export function checkWikiOutput(
  output: WikiOutput,
  evidence: readonly WikiEvidence[],
  expectedSourceIds: readonly string[],
): WikiOutputCheck {
  const { byLabel, ambiguous } = evidenceByUniqueLabel(evidence);
  const expected = [...new Set(expectedSourceIds)];
  const expectedSet = new Set(expected);
  const citedSources = new Set<string>();
  const citationsByLabel = new Map<string, WikiEvidence["citation"]>();
  const keptSections: string[] = [];
  const dropped: { index: number; reason: string }[] = [];

  const sections = Array.isArray(output?.sections) ? output.sections : [];
  sections.forEach((section, index) => {
    if (index >= MAX_SECTIONS) {
      dropped.push({ index, reason: "too-many-sections" });
      return;
    }
    const textReason = invalidTextReason(section?.text);
    if (textReason) {
      dropped.push({ index, reason: textReason });
      return;
    }

    const labels = section.labels;
    if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_LABELS_PER_SECTION
      || labels.some((label) => typeof label !== "string") || new Set(labels).size !== labels.length) {
      dropped.push({ index, reason: "invalid-label-list" });
      return;
    }

    const selected: WikiEvidence[] = [];
    for (const label of labels) {
      if (ambiguous.has(label)) {
        dropped.push({ index, reason: "ambiguous-evidence-label" });
        return;
      }
      const item = byLabel.get(label);
      if (!item) {
        dropped.push({ index, reason: "undeclared-evidence-label" });
        return;
      }
      if (!expectedSet.has(item.citation.sourceId)) {
        dropped.push({ index, reason: "source-outside-expected-scope" });
        return;
      }
      selected.push(item);
    }

    if (!numbersSupported(section.text, selected.map((item) => item.quote).join("\n"))) {
      dropped.push({ index, reason: "unsupported-numeric-facts" });
      return;
    }

    keptSections.push(section.text + "\n\n" + labels.join(" "));
    for (const [label, item] of labels.map((label) => [label, byLabel.get(label)] as const)) {
      if (!item) continue;
      citedSources.add(item.citation.sourceId);
      if (!citationsByLabel.has(label)) citationsByLabel.set(label, item.citation);
    }
  });

  return {
    body: keptSections.join("\n\n"),
    citations: [...citationsByLabel.values()],
    kept: keptSections.length,
    dropped,
    missingSourceIds: expected.filter((sourceId) => !citedSources.has(sourceId)),
  };
}
