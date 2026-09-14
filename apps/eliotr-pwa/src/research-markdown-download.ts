export interface ResearchMarkdownClaimAssessment {
  readonly claimText: string;
  readonly claimTextDigest: string;
  readonly verdict: string;
  readonly supportRefs: readonly string[];
  readonly counterevidenceRefs: readonly string[];
}

export interface ResearchMarkdownAudit {
  readonly stageAttemptRef: string;
  readonly stageRequestSha256: string;
  readonly outputSha256: string;
  readonly synthesisOutputSha256: string;
  readonly normalizationBindingSha256: string;
  readonly verifierRef: string;
  readonly verifierSchemaGeneration: string;
  readonly modelReceiptRef: string;
}

export interface ResearchMarkdownCitation {
  readonly originalHandleRef: string;
  readonly handleRef: string;
  readonly excerptSha256: string;
}

export interface ResearchMarkdownSection {
  readonly sectionRef: string;
  readonly originalScopeSnapshotRef: string;
  readonly authorizationScopeSnapshotRef: string;
  readonly body: string;
  readonly semanticVerification: "EXECUTED" | "NOT_EXECUTED";
  readonly verificationReceiptRef: string;
  readonly claims: readonly ResearchMarkdownClaimAssessment[];
  readonly audit?: ResearchMarkdownAudit;
  readonly citations: readonly ResearchMarkdownCitation[];
}

function formatRefs(refs: readonly string[]): string {
  return refs.length === 0 ? "none recorded" : refs.map((ref) => `\`${ref}\``).join(", ");
}

function safeFilenameTimestamp(createdAt: string): string {
  const safe = createdAt.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96);
  return safe.length === 0 ? "undated" : safe;
}

export function downloadResearchDraftMarkdown(
  artifactRef: string,
  createdAt: string,
  sections: readonly ResearchMarkdownSection[],
): void {
  if (sections.length === 0) return;
  const parts: BlobPart[] = [
    "# Research draft\n\n",
    "Status: DRAFT\n\n",
    `Created: ${createdAt}\n\n`,
    "This export contains the saved report text and reauthorized citation metadata. It does not claim that source bytes were opened or freshly verified.\n\n",
  ];
  sections.forEach((section, index) => {
    parts.push(`## Section ${index + 1}\n\n`, `Verification: ${section.semanticVerification}\n\n`, section.body, section.body.endsWith("\n") ? "\n" : "\n\n");
  });

  parts.push("## Claim assessments\n\n");
  sections.forEach((section, index) => {
    parts.push(`### Section ${index + 1}\n\n`);
    if (section.semanticVerification === "NOT_EXECUTED") {
      parts.push("Verification: NOT_EXECUTED — no claim assessment was recorded.\n\n");
      return;
    }
    if (section.claims.length === 0) {
      parts.push("Verification: EXECUTED — no claim assessments were recorded.\n\n");
      return;
    }
    section.claims.forEach((claim, claimIndex) => {
      parts.push(`${claimIndex + 1}. Verdict: ${claim.verdict}\n`, `   Claim: ${claim.claimText}\n`, `   Support refs: ${formatRefs(claim.supportRefs)}\n`, `   Counterevidence refs: ${formatRefs(claim.counterevidenceRefs)}\n\n`);
    });
  });

  parts.push("## Technical appendix\n\n", "These references and digests are the saved reauthorization record. They do not by themselves verify source bytes.\n\n", `Artifact ref: \`${artifactRef}\`\n\n`);
  sections.forEach((section, index) => {
    parts.push(`### Section ${index + 1}\n\n`, `- Section ref: \`${section.sectionRef}\`\n`, `- Original scope snapshot: \`${section.originalScopeSnapshotRef}\`\n`, `- Authorization scope snapshot: \`${section.authorizationScopeSnapshotRef}\`\n`, `- Verification: ${section.semanticVerification}\n`, `- Verification receipt: \`${section.verificationReceiptRef}\`\n`);
    if (section.audit !== undefined) {
      parts.push(`- Audit stage attempt: \`${section.audit.stageAttemptRef}\`\n`, `- Stage request SHA-256: \`${section.audit.stageRequestSha256}\`\n`, `- Output SHA-256: \`${section.audit.outputSha256}\`\n`, `- Synthesis output SHA-256: \`${section.audit.synthesisOutputSha256}\`\n`, `- Normalization binding SHA-256: \`${section.audit.normalizationBindingSha256}\`\n`, `- Verifier: \`${section.audit.verifierRef}\` (schema \`${section.audit.verifierSchemaGeneration}\`)\n`, `- Model receipt: \`${section.audit.modelReceiptRef}\`\n`);
      section.claims.forEach((claim, claimIndex) => {
        parts.push(`- Claim ${claimIndex + 1} text SHA-256: \`${claim.claimTextDigest}\`\n`);
      });
    }
    if (section.citations.length === 0) {
      parts.push("- Cited evidence: none recorded\n\n");
      return;
    }
    section.citations.forEach((citation) => {
      parts.push(`- Original handle: \`${citation.originalHandleRef}\`; reauthorized handle: \`${citation.handleRef}\`; excerpt SHA-256: \`${citation.excerptSha256}\`\n`);
    });
    parts.push("\n");
  });

  const url = URL.createObjectURL(new Blob(parts, { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `research-draft-${safeFilenameTimestamp(createdAt)}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
