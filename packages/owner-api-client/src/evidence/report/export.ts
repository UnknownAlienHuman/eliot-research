// C3-EM owner-client move of the pure builder half of
// packages/pwa-research-workspace/src/research-markdown-download.ts.
// Only assembly moves here. No transport, no digest, no DOM, no Blob, no object URL and no click.
// The finished bytes leave this module through an injected sink, so a test or a future runtime supplies
// its own delivery, and the client never touches an ambient global.
import type { ArtifactRevision } from '@eliotr/contracts';
import type { ArtifactSectionResponse } from './sections.js';

/**
 * The citation projection is injected by the C3-E gate. C3-EC owns the citation and audit decoders; this
 * module never re-implements an outcome, a disposition or a claim projection. When the seam is absent,
 * claim rows are omitted with an explicit note rather than a fabricated verdict.
 */
export interface ReportClaimAssessment {
  readonly claimText: string;
  readonly claimTextDigest: string;
  readonly verdict: string;
  readonly supportRefs: readonly string[];
  readonly counterevidenceRefs: readonly string[];
}

export interface ReportSectionClaims {
  readonly sectionRef: string;
  readonly semanticVerification: 'EXECUTED' | 'NOT_EXECUTED';
  readonly claims: readonly ReportClaimAssessment[];
}

export type ReportCitationProjection = (
  section: ArtifactSectionResponse,
) => ReportSectionClaims | undefined;

export interface ReportExportInput {
  readonly artifact: ArtifactRevision;
  readonly artifactRef: string;
  /** Exact verified section bytes, in manifest order. */
  readonly sections: readonly ArtifactSectionResponse[];
  readonly citations?: ReportCitationProjection;
}

export interface ReportExportMetadata {
  readonly artifactRef: string;
  readonly createdAt: string;
  readonly sectionCount: number;
  readonly byteLength: number;
}

/** Delivery is injected, so this module never creates a Blob or clicks an anchor. */
export type MarkdownSink = (bytes: Uint8Array, metadata: ReportExportMetadata) => void;

export interface ReportExportResult {
  readonly metadata: ReportExportMetadata;
  /** Exact assembled Markdown bytes, retained for lossless explicit delivery. */
  readonly bytes: Uint8Array;
}

/** A section body without a trailing newline still gains the separator before the next block. */
const decodeUtf8 = (bytes: Uint8Array): string => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('report section bytes are not valid UTF-8');
  }
  return text;
};

export const safeFilenameTimestamp = (createdAt: string): string => {
  const safe = createdAt.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 96);
  return safe.length === 0 ? 'undated' : safe;
};

export const formatRefs = (refs: readonly string[]): string =>
  refs.length === 0 ? 'none recorded' : refs.map((ref) => `\`${ref}\``).join(', ');

export const refKey = (ref: { readonly id: string; readonly revision: number }): string =>
  `${ref.id}:${ref.revision}`;

/**
 * Assembles the draft Markdown export. A required section that has not been read back, or whose bytes do
 * not match its manifest row, blocks the whole export, so a partial report is never written.
 */
export const assembleResearchDraftMarkdown = (input: ReportExportInput): ReportExportResult => {
  const { artifact, sections } = input;
  const declaredRefs = new Set(artifact.sections.map((section) => refKey(section.section_ref)));
  const readRefs = new Set(sections.map((section) => refKey(section.section_ref)));
  // Every declared section must be present with its own verified bytes. A missing readback is a
  // failed required section, and a readback the manifest never declared is not part of this report.
  if (declaredRefs.size !== readRefs.size ||
      [...declaredRefs].some((ref) => !readRefs.has(ref)) ||
      readRefs.size !== sections.length) {
    throw new TypeError('a required report section is missing from the export input');
  }
  for (const section of sections) {
    const declared = artifact.sections.find((item) => refKey(item.section_ref) === refKey(section.section_ref));
    if (declared === undefined) {
      throw new TypeError('an exported section is not declared by the report manifest');
    }
    if (declared.body_object_ref !== section.body_object_ref || declared.body_sha256 !== section.body_sha256) {
      throw new TypeError('an exported section does not match its manifest row');
    }
  }
  if (sections.length === 0) {
    throw new TypeError('the report manifest declares no sections to export');
  }

  const createdAt = safeFilenameTimestamp(artifact.created_at);
  const parts: string[] = [
    '# Research draft\n\n',
    'Status: DRAFT\n\n',
    `Created: ${artifact.created_at}\n\n`,
    'This export contains the saved report text and reauthorized citation metadata. It does not claim that source bytes were opened or freshly verified.\n\n',
  ];
  sections.forEach((section, index) => {
    const body = decodeUtf8(section.bytes);
    parts.push(
      `## Section ${index + 1}\n\n`,
      `Section ref: \`${refKey(section.section_ref)}\`\n\n`,
      body,
      body.endsWith('\n') ? '\n' : '\n\n',
    );
  });

  parts.push('## Claim assessments\n\n');
  sections.forEach((section, index) => {
    parts.push(`### Section ${index + 1}\n\n`);
    const projected = input.citations === undefined ? undefined : input.citations(section);
    // The C3-EC seam owns claim decoding. An absent projection is reported as absent, never invented.
    if (projected === undefined) {
      parts.push('No claim assessment was supplied for this section.\n\n');
      return;
    }
    if (projected.semanticVerification === 'NOT_EXECUTED') {
      parts.push('Verification: NOT_EXECUTED - no claim assessment was recorded.\n\n');
      return;
    }
    if (projected.claims.length === 0) {
      parts.push('Verification: EXECUTED - no claim assessments were recorded.\n\n');
      return;
    }
    projected.claims.forEach((claim, claimIndex) => {
      parts.push(
        `${claimIndex + 1}. Verdict: ${claim.verdict}\n`,
        `   Claim: ${claim.claimText}\n`,
        `   Claim text SHA-256: \`${claim.claimTextDigest}\`\n`,
        `   Support refs: ${formatRefs(claim.supportRefs)}\n`,
        `   Counterevidence refs: ${formatRefs(claim.counterevidenceRefs)}\n\n`,
      );
    });
  });

  parts.push(
    '## Technical appendix\n\n',
    'These references and digests are the saved reauthorization record. They do not by themselves verify source bytes.\n\n',
    `Artifact ref: \`${input.artifactRef}\`\n\n`,
  );
  sections.forEach((section, index) => {
    parts.push(
      `### Section ${index + 1}\n\n`,
      `- Section ref: \`${refKey(section.section_ref)}\`\n`,
      `- Body object ref: \`${section.body_object_ref}\`\n`,
      `- Body SHA-256: \`${section.body_sha256}\`\n`,
      `- Size: ${section.size_bytes} bytes\n\n`,
    );
  });

  const markdown = parts.join('');
  const bytes = new TextEncoder().encode(markdown);
  return {
    metadata: {
      artifactRef: input.artifactRef,
      createdAt,
      sectionCount: sections.length,
      byteLength: bytes.byteLength,
    },
    bytes,
  };
};

/** Assembles the draft and hands the exact bytes to the injected sink. */
export const exportResearchDraftMarkdown = (
  input: ReportExportInput,
  sink?: MarkdownSink,
): ReportExportResult => {
  const result = assembleResearchDraftMarkdown(input);
  if (sink !== undefined) sink(result.bytes, result.metadata);
  return result;
};
