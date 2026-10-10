import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRevision } from '@eliotr/contracts';
import {
  assembleResearchDraftMarkdown,
  exportResearchDraftMarkdown,
  formatRefs,
  safeFilenameTimestamp,
  type ReportExportInput,
} from './export';
import type { ArtifactSectionResponse } from './sections';

/** Characterization of the legacy Markdown builder, frozen before the move. */

const artifactRef = { id: 'art-one', revision: 3 };
const sectionRef = { id: 'sec-one', revision: 7 };
const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
const createdAt = '2026-10-09T12:00:00.000Z';
const bodyText = 'exact report section body';
const bodyBytes = new TextEncoder().encode(bodyText);

const artifact: ArtifactRevision = {
  artifact_ref: artifactRef,
  spec_ref: { id: 'spec-one', revision: 1 },
  spec_digest: digest,
  evidence_freeze_ref: { id: 'freeze-one', revision: 2 },
  sections: [{
    section_ref: sectionRef,
    contract_id: 'contract-one',
    body_object_ref: 'obj-one',
    body_sha256: digest,
    statement_labels: {},
    evidence_ledger_ref: 'ledger-one',
    verification_receipt_ref: 'receipt-one',
  }],
  dependency_manifest_ref: 'deps-one',
  deterministic_export_refs: { markdown: 'export-one' },
  status: 'DRAFT',
  created_at: createdAt,
};

const section: ArtifactSectionResponse = {
  artifact_ref: artifactRef,
  section_ref: sectionRef,
  body_object_ref: 'obj-one',
  body_sha256: digest,
  size_bytes: bodyBytes.byteLength,
  bytes: bodyBytes,
};

const input = (
  overrides: Partial<ReportExportInput> = {},
): ReportExportInput => ({
  artifact,
  artifactRef: `${artifactRef.id}:${artifactRef.revision}`,
  sections: [section],
  ...overrides,
});

const text = (result: { bytes: Uint8Array }): string => new TextDecoder().decode(result.bytes);

describe('assembleResearchDraftMarkdown', () => {
  it('assembles the draft with the verification disclaimer', async () => {
    const result = assembleResearchDraftMarkdown(input());
    const markdown = text(result);
    expect(markdown).toContain('# Research draft');
    expect(markdown).toContain('Status: DRAFT');
    expect(markdown).toContain(createdAt);
    expect(markdown).toContain(
      'It does not claim that source bytes were opened or freshly verified.',
    );
    expect(markdown).toContain('## Section 1');
    expect(markdown).toContain(bodyText);
    expect(result.metadata.sectionCount).toBe(1);
    expect(result.metadata.byteLength).toBe(result.bytes.byteLength);
  });

  it('blocks the export when a required section is missing', async () => {
    // The C3-EM mandatory negative: a failed required section blocks a complete export.
    expect(() => assembleResearchDraftMarkdown(input({ sections: [] }))).toThrow(TypeError);
  });

  it('blocks the export when a section body digest does not match the manifest row', async () => {
    const mismatched: ArtifactSectionResponse = { ...section, body_sha256: otherDigest };
    expect(() => assembleResearchDraftMarkdown(input({ sections: [mismatched] }))).toThrow(TypeError);
  });

  it('blocks the export when a section object ref does not match the manifest row', async () => {
    const mismatched: ArtifactSectionResponse = { ...section, body_object_ref: 'obj-other' };
    expect(() => assembleResearchDraftMarkdown(input({ sections: [mismatched] }))).toThrow(TypeError);
  });

  it('blocks the export when an undeclared section is supplied', async () => {
    const undeclared: ArtifactSectionResponse = {
      ...section,
      section_ref: { id: 'sec-other', revision: 9 },
    };
    expect(() => assembleResearchDraftMarkdown(input({ sections: [undeclared] }))).toThrow(TypeError);
  });

  it('adds the separator when a section body lacks a trailing newline', async () => {
    const result = assembleResearchDraftMarkdown(input());
    const markdown = text(result);
    expect(markdown).toContain(`${bodyText}\n\n`);
  });

  it('writes the technical appendix with exact refs and digests', async () => {
    const result = assembleResearchDraftMarkdown(input());
    const markdown = text(result);
    expect(markdown).toContain('## Technical appendix');
    expect(markdown).toContain('art-one:3');
    expect(markdown).toContain('sec-one:7');
    expect(markdown).toContain('obj-one');
    expect(markdown).toContain(digest);
  });

  it('omits claim rows with an explicit note when no citation projection is supplied', async () => {
    const result = assembleResearchDraftMarkdown(input());
    const markdown = text(result);
    expect(markdown).toContain('## Claim assessments');
    expect(markdown).toContain('No claim assessment was supplied for this section.');
  });

  it('renders a projected claim verdict with empty ref lists as none recorded', async () => {
    const result = assembleResearchDraftMarkdown(input({
      citations: () => ({
        sectionRef: 'sec-one:7',
        semanticVerification: 'EXECUTED',
        claims: [{
          claimText: 'a supported observation',
          claimTextDigest: 'c'.repeat(64),
          verdict: 'SUPPORTED',
          supportRefs: [],
          counterevidenceRefs: [],
        }],
      }),
    }));
    const markdown = text(result);
    expect(markdown).toContain('1. Verdict: SUPPORTED');
    expect(markdown).toContain('a supported observation');
    expect(markdown).toContain('Support refs: none recorded');
    expect(markdown).toContain('Counterevidence refs: none recorded');
  });

  it('reports NOT_EXECUTED verification without inventing a verdict', async () => {
    const result = assembleResearchDraftMarkdown(input({
      citations: () => ({
        sectionRef: 'sec-one:7',
        semanticVerification: 'NOT_EXECUTED',
        claims: [],
      }),
    }));
    expect(text(result)).toContain('Verification: NOT_EXECUTED');
  });
});

describe('sink and helpers', () => {
  it('hands the exact bytes to the injected sink', async () => {
    const sink = vi.fn();
    const result = exportResearchDraftMarkdown(input(), sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(result.bytes, result.metadata);
  });

  it('returns the assembled result when no sink is supplied', async () => {
    const result = exportResearchDraftMarkdown(input());
    expect(result.metadata.sectionCount).toBe(1);
  });

  it('collapses an unusable timestamp to undated', async () => {
    expect(safeFilenameTimestamp('///')).toBe('undated');
    expect(safeFilenameTimestamp(createdAt)).toBe('2026-10-09T12-00-00.000Z');
  });

  it('formats an empty ref list as none recorded', async () => {
    expect(formatRefs([])).toBe('none recorded');
  });
});
