# Locator boundary

Managed search, FTS and model-selected references produce locators, never evidence. The strict decoder
accepts only the canonical `LocatorCandidate` envelope, applies result/preview bounds and rejects any
row that attempts to supply an evidence handle, citation ID or verification flag.

```text
vendor response
→ vendor-specific extraction adapter
→ decodeUnresolvedLocatorCandidates
→ D1 scope/policy/purge recheck
→ exact EvidenceHandle resolution against the pinned R2 revision
→ evidence
```

Do not add a convenience conversion from `UnresolvedLocatorCandidate` to an evidence DTO.
