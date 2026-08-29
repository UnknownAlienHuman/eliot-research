# Privacy erasure contour

Only the ErasureCoordinator may invoke `erc.privacy.erasure.v1`. Required lifecycle:

```text
REQUESTED → QUARANTINE_AND_REVOKE → ENUMERATE_DEPENDENCY_CLOSURE
→ CHECK_RETENTION_AND_HOLDS → PURGE_EACH_LOCATION → VERIFY_ABSENCE_OR_BLOCK
→ APPEND_PURGE_LEDGER → INVALIDATE_DEPENDENTS → COMPLETE | BLOCKED
```

A success receipt requires exact equality between requested and completed PurgeLocation sets. Bucket
Lock or legal hold produces `BLOCKED` with the location and next review condition. Restore and all
projection rebuilds apply the PurgeLedger first; a REDACTED EvidenceHandle returns no deleted content.
