from pathlib import Path

path = Path("apps/eliotr-core/src/research-evidence-freeze-composition.ts")
text = path.read_text(encoding="utf-8")
old = "    read_branch_reconciliation: (input) => readCommittedResearchBranchReconciliationLineage({\n"
new = "    read_branch_reconciliation: (input: EvidenceFreezeCommittedReaderInput) =>\n      readCommittedResearchBranchReconciliationLineage({\n"
if text.count(old) != 1:
    raise SystemExit(f"expected one app callback type insertion, found {text.count(old)}")
path.write_text(text.replace(old, new), encoding="utf-8")
