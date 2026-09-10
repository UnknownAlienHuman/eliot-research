# Cross-field contract validation

Strict schemas reject unknown fields, but several load-bearing rules depend on combinations of fields.
Decode through `decodeContractWithInvariants` so a generated adapter cannot stop after structural parsing.

Required order:

```text
strict wire schema
→ cross-field invariants
→ authentication/signature/provider checks
→ domain state transition
```

Do not duplicate these rules in transport adapters. Extend the shared validator and its negative fixtures.
