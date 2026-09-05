# Launch 03 — Full structural Corpus Lens

Status: queued draft, unclaimed. Integration predecessor: Launch 02 (#90) for exact evidence opening.
Owners: ER-31, ER-06/07/39 and ER-25 UI; ER-24 transport composition. Reuse current
`packages/cloudflare-navigation`, `packages/retrieval/src/navigation-*`, D1 navigation store and
migrations 0010/0011. Read the owning work packets and existing orientation integration tests first.

The current E0 metadata orientation is real but not structural/semantic navigation. Extend it without
changing the meaning of the existing profile or fabricating headings, summaries, excerpts or citations.

## Small sequential checkpoints

- [ ] C1. Bind normalized section/coordinate-map inputs to the exact admitted source revision, checksum
  and policy. Read bounded R2 ranges through existing ports; do not parse raw PDFs/OCR in the Worker.
- [ ] C2. Materialize versioned SourceCards and DocumentMaps from actual structure. Preserve explicit
  unsupported/missing-structure states; guard immutable writes/replay and generation identity.
- [ ] C3. Build/persist ProjectAtlas for an exact frozen authorized denominator. Account for omissions,
  source limits, overlaps and taint-changing selection. No top-k completeness or inferred membership.
- [ ] C4. Wire Atlas -> source -> section -> locator -> canonical resolved EvidenceHandle using #90.
  Recheck grant, expiry, owner revision and purge after reads; handle policy/purge races without output.
- [ ] C5. Add the ER-25 structural navigation UI, bounded expansion and exact evidence opening. Preserve
  existing metadata fallback and visibly distinguish unsupported structure from empty structure.
- [ ] C6. Test long RU/EN/code/table documents, missing maps, forged maps, sparse coverage, multi-project
  scopes, max+1 bounds, replay, restart and policy/purge invalidation through actual Worker/D1/R2.

Each checkpoint is a separate bounded implementation commit with its negative case. Current packet
ownership remains authoritative; shared exports/schema/routes need synchronized integration permission.
Do not introduce another navigation store, authority cache, scope freezer or evidence resolver.

## Completion

Require repository/strict Workers fixture gates, exact-head CI, local Linux/Windows smoke and a browser
Library -> Atlas -> section -> exact bytes loop. Test content-addressed identities against the same
builders and readers, not duplicate golden values only. Update the profile/capabilities and gap/status
records honestly; metadata-only paths do not close structural navigation. Keep draft until C1–C6 pass.
Real Access/R2/D1 platform receipts remain NOT_EXECUTED until complete staging; no partial deployment.
