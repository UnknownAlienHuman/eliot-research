from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new), encoding="utf-8")


replace_once(
    "packages/research/src/wiki.ts",
    '''import {
  wikiMayAutoPromote,
  wikiMayBePublished,
  wikiTargetsExpectedHead,
  type DraftRiskClass,
  type WikiAutoPromotionAuthority,
} from "@eliotr/domain";

export type { EvidenceLabel as StatementLabel, WikiPageRevision, WikiPageType } from "@eliotr/contracts";
export type { DraftRiskClass, WikiAutoPromotionAuthority } from "@eliotr/domain";
''',
    '''import {
  wikiMayBePublished,
  wikiTargetsExpectedHead,
  type DraftRiskClass,
} from "@eliotr/domain";

export type { EvidenceLabel as StatementLabel, WikiPageRevision, WikiPageType } from "@eliotr/contracts";
export type { DraftRiskClass } from "@eliotr/domain";
''',
)
replace_once(
    "packages/research/src/wiki.ts",
    '''  readonly committer_ref: string;
  readonly auto_promotion_policy_receipt_ref?: string;
''',
    '''  readonly committer_ref: string;
''',
)
replace_once(
    "packages/research/src/wiki.ts",
    '''  /** Optional server-owned manual-review coverage; never used by auto promotion. */
''',
    '''  /** Optional server-owned manual-review coverage. */
''',
)
replace_once(
    "packages/research/src/wiki.ts",
    '''export interface WikiAutoPromotionReceipt extends WikiAutoPromotionAuthority {
  readonly publisher_ref: string;
}

export interface WikiPublisher {
  propose(page: WikiPageRevision, riskClass: DraftRiskClass): Promise<VersionedRef>;
  publish(proposalRef: VersionedRef, expectedHeadRevision: number, committerRef: string): Promise<WikiPageRevision>;
  autoPromote(
    proposalRef: VersionedRef,
    expectedHeadRevision: number,
    authority: WikiAutoPromotionReceipt,
  ): Promise<WikiPageRevision>;
}
''',
    '''export interface WikiPublisher {
  propose(page: WikiPageRevision, riskClass: DraftRiskClass): Promise<VersionedRef>;
  publish(proposalRef: VersionedRef, expectedHeadRevision: number, committerRef: string): Promise<WikiPageRevision>;
}
''',
)
replace_once(
    "packages/research/src/wiki.ts",
    '''async function publishStored(
  port: WikiPublicationPort,
  stored: WikiProposalRecord,
  expectedHeadRevision: number,
  committerRef: string,
  autoPromotionPolicyReceiptRef?: string,
  allowReviewedCoverage = false,
): Promise<WikiPageRevision> {
''',
    '''async function publishStored(
  port: WikiPublicationPort,
  stored: WikiProposalRecord,
  expectedHeadRevision: number,
  committerRef: string,
): Promise<WikiPageRevision> {
''',
)
replace_once(
    "packages/research/src/wiki.ts",
    '''  await validatePublication(port, stored.page, allowReviewedCoverage);
''',
    '''  await validatePublication(port, stored.page, true);
''',
)
replace_once(
    "packages/research/src/wiki.ts",
    '''    manifest_ref: immutable.manifest_ref,
    committer_ref: committerRef,
    ...(autoPromotionPolicyReceiptRef === undefined
      ? {}
      : { auto_promotion_policy_receipt_ref: autoPromotionPolicyReceiptRef }),
''',
    '''    manifest_ref: immutable.manifest_ref,
    committer_ref: committerRef,
''',
)
replace_once(
    "packages/research/src/wiki.ts",
    '''      return publishStored(port, stored, expectedHeadRevision, committerRef, undefined, true);
    },

    async autoPromote(rawProposalRef, expectedHeadRevision, authority) {
      const proposalRef = parseRef(rawProposalRef, "proposal reference");
      const stored = await readProposal(port, proposalRef);
      if (!nonEmpty(authority.publisher_ref)
        || !wikiMayAutoPromote(stored.page, stored.risk_class, authority)) {
        fail("WIKI_POLICY_DENIED", "wiki draft is not eligible for automatic promotion");
      }
      return publishStored(
        port,
        stored,
        expectedHeadRevision,
        authority.publisher_ref,
        authority.policy_receipt_ref,
        false,
      );
    },
''',
    '''      return publishStored(port, stored, expectedHeadRevision, committerRef);
    },
''',
)

replace_once(
    "packages/domain/src/publication.ts",
    '''export interface WikiAutoPromotionAuthority {
  readonly explicit_project_policy: boolean;
  readonly policy_receipt_ref: string;
  readonly exact_evidence_complete: boolean;
  readonly evidence_receipt_ref: string;
  readonly dependency_closure_complete: boolean;
  readonly coverage_complete: boolean;
  readonly independent_verifier_receipt_ref: string;
  readonly conflict_count: number;
  readonly changes_current_state: boolean;
}

''',
    "",
)
replace_once(
    "packages/domain/src/publication.ts",
    '''/** D2/D3 are unconditionally review-only. D0/D1 still require explicit, receipt-backed policy. */
export function wikiMayAutoPromote(
  page: WikiPageRevision,
  riskClass: DraftRiskClass,
  authority: WikiAutoPromotionAuthority,
): boolean {
  if (!wikiMayBePublished(page)) return false;
  if (riskClass === "D2_ANALYTICAL" || riskClass === "D3_AUTHORITY_SENSITIVE") return false;
  if (riskClass !== "D0_MECHANICAL" && riskClass !== "D1_LOW_RISK_ADDITIVE") return false;
  if (!authority.explicit_project_policy
    || !nonEmpty(authority.policy_receipt_ref)
    || !authority.exact_evidence_complete
    || !nonEmpty(authority.evidence_receipt_ref)
    || !authority.dependency_closure_complete
    || !authority.coverage_complete
    || !nonEmpty(authority.independent_verifier_receipt_ref)
    || !Number.isSafeInteger(authority.conflict_count)
    || authority.conflict_count !== 0
    || authority.changes_current_state) {
    return false;
  }
  const labels = statementLabels(page);
  if (labels === null || labels.length === 0) return false;
  if (riskClass === "D0_MECHANICAL") {
    return labels.every((label) => label === "SOURCE_SUPPORTED" || label === "EDITORIAL_RECOMMENDATION");
  }
  return (page.page_type === "Source" || page.page_type === "Glossary")
    && labels.every((label) => label === "SOURCE_SUPPORTED");
}
''',
    "",
)

replace_once(
    "packages/domain/src/publication.test.ts",
    '''import {
  wikiMayAutoPromote,
  wikiMayBePublished,
  wikiPublicationIssues,
  wikiTargetsExpectedHead,
  type WikiAutoPromotionAuthority,
} from "./publication.js";
''',
    '''import {
  wikiMayBePublished,
  wikiPublicationIssues,
  wikiTargetsExpectedHead,
} from "./publication.js";
''',
)
replace_once(
    "packages/domain/src/publication.test.ts",
    '''const authority: WikiAutoPromotionAuthority = {
  explicit_project_policy: true,
  policy_receipt_ref: "policy-receipt-1",
  exact_evidence_complete: true,
  evidence_receipt_ref: "evidence-receipt-1",
  dependency_closure_complete: true,
  coverage_complete: true,
  independent_verifier_receipt_ref: "verifier-receipt-1",
  conflict_count: 0,
  changes_current_state: false,
};

''',
    "",
)
replace_once(
    "packages/domain/src/publication.test.ts",
    '''
  it("permits D0/D1 auto-promotion only with exact explicit authority and never permits D2/D3", () => {
    expect(wikiMayAutoPromote(page(), "D1_LOW_RISK_ADDITIVE", authority)).toBe(true);
    expect(wikiMayAutoPromote(page(), "D2_ANALYTICAL", authority)).toBe(false);
    expect(wikiMayAutoPromote(page(), "D3_AUTHORITY_SENSITIVE", authority)).toBe(false);
    expect(wikiMayAutoPromote(page(), "D1_LOW_RISK_ADDITIVE", {
      ...authority,
      explicit_project_policy: false,
    })).toBe(false);
    expect(wikiMayAutoPromote(page({ page_type: "Hypothesis" }), "D1_LOW_RISK_ADDITIVE", authority)).toBe(false);
    expect(wikiMayAutoPromote(page({
      statement_labels: { "claim-1": "DERIVED_INFERENCE" },
    }), "D1_LOW_RISK_ADDITIVE", authority)).toBe(false);
  });
''',
    "",
)

replace_once(
    "packages/research/src/wiki.test.ts",
    '''  type DraftRiskClass,
  type WikiAutoPromotionReceipt,
  type WikiHeadCommit,
''',
    '''  type DraftRiskClass,
  type WikiHeadCommit,
''',
)
replace_once(
    "packages/research/src/wiki.test.ts",
    '''const autoAuthority: WikiAutoPromotionReceipt = {
  publisher_ref: "wiki-auto-publisher-1",
  explicit_project_policy: true,
  policy_receipt_ref: "policy-receipt-1",
  exact_evidence_complete: true,
  evidence_receipt_ref: "evidence-receipt-1",
  dependency_closure_complete: true,
  coverage_complete: true,
  independent_verifier_receipt_ref: "verifier-receipt-1",
  conflict_count: 0,
  changes_current_state: false,
};

''',
    "",
)
replace_once(
    "packages/research/src/wiki.test.ts",
    '''
  it("never auto-promotes D2/D3 and performs no immutable write when policy denies", async () => {
    const port = new MemoryWikiPort();
    const publisher = createWikiPublisher(port);
    for (const risk of ["D2_ANALYTICAL", "D3_AUTHORITY_SENSITIVE"] as const) {
      const proposalRef = await publisher.propose(page(risk === "D2_ANALYTICAL" ? "a" : "b"), risk);
      await expect(publisher.autoPromote(proposalRef, 0, autoAuthority))
        .rejects.toMatchObject({ code: "WIKI_POLICY_DENIED" });
    }
    expect(port.events.some((event) => event.startsWith("r2:write:"))).toBe(false);
    expect(port.commits).toHaveLength(0);
  });

  it("auto-promotes an exact D1 draft only with its policy receipt bound into the commit", async () => {
    const port = new MemoryWikiPort();
    const publisher = createWikiPublisher(port);
    const proposalRef = await publisher.propose(page(), "D1_LOW_RISK_ADDITIVE");
    await expect(publisher.autoPromote(proposalRef, 0, autoAuthority)).resolves.toMatchObject({
      status: "PUBLISHED",
      reviewer_ref: autoAuthority.publisher_ref,
    });
    expect(port.commits[0]?.auto_promotion_policy_receipt_ref).toBe(autoAuthority.policy_receipt_ref);
  });
''',
    "",
)

replace_once(
    "docs/implementation/wiki-inbox.md",
    '''| `packages/research/src/wiki.ts` | Generic publisher validates evidence/coverage/dependencies, writes a manifest and requires `commitHeadAndOutbox`; unused runtime auto-promotion remains. | Small concrete proposal/read/accept/reject/edit operations in `cloudflare-wiki`; delete the proof-oriented port and `autoPromote`. |
''',
    '''| `packages/research/src/wiki.ts` | Generic publisher still validates evidence/coverage/dependencies and writes a manifest; unused runtime auto-promotion has been removed. | Small concrete proposal/read/accept/reject/edit operations in `cloudflare-wiki`; delete the remaining proof-oriented port. |
''',
)
replace_once(
    "docs/implementation/wiki-inbox.md",
    '''- `WikiPublicationPort`, `createWikiPublisher`, risk-class auto-promotion and `autoPromote` when no real caller remains;
''',
    '''- `WikiPublicationPort` and `createWikiPublisher` when their remaining real callers move to concrete Wiki operations;
''',
)
