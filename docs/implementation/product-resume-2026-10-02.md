# Product integration checkpoint, 2026-10-02

This is an isolated development checkpoint. Remote main was refreshed at `6480186ea5ead7052e7122ec1b523713ddc97f21`. Only PR #306 had applicable merge authorization. No other PR was merged, no live deployment or provider spending was performed, and no credentials were created.

## Settled decisions

- [#298](https://github.com/UnknownAlienHuman/eliot-research/issues/298) and [#106](https://github.com/UnknownAlienHuman/eliot-research/issues/106) are closed. Their source repairs do not replace exact-build browser or Rust acceptance.
- [#294](https://github.com/UnknownAlienHuman/eliot-research/issues/294) remains open for dynamic-query coverage and native acceptance. The depth-100 compiler passes recovered SQL but explicitly reports unresolved prepare sites.
- [#301](https://github.com/UnknownAlienHuman/eliot-research/issues/301) remains the ordered queue with complete task criteria. Existing v7 selection/composition/freeze wiring and #299 recovery must be reused.
- S94 A/B is not an unresolved product decision. The existing [staging checklist](launch-prs/cloudflare-handoff.md) permits a dedicated approved account or a separately reviewed isolated resource profile. Same-account preflight requires different D1/R2 resource IDs; this is not permission to apply a deployment.
- [ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md) keeps providers, external agents and Google clients independently selectable. S95 does not impose an unselected Gemini client.
- S93 quality preparation is independent local work. S96 live load requires bounded approved spending. S97 requires exact release evidence and explicit production approval.

## Integrated source boundaries

This branch combines the owner publication checkpoint from [#313](https://github.com/UnknownAlienHuman/eliot-research/pull/313), portable recovery checkpoint from [#314](https://github.com/UnknownAlienHuman/eliot-research/pull/314), COW source `8657037470814fd0d03b556db57512bde357bdd7`, and COW fixture checkpoint `8c150f4a`. All remain draft development, not live qualification.

- Core REPORT admission persists the full owner/source/policy/spend witness before the dedicated COW W2. The server model admission derives separate SYNTHESIZE and independent-verification quotes from installed rules, pins route/prompt/schema, checks current source and grant authority, and binds model input digest to immutable intent. UNKNOWN gives no retry permission.
- Migration 0100 now validates the actual canonical `{request, attempt_ref}` envelope for W3 admission. COMMITTED additionally requires a real CAS-written DRAFT child with the original spec/freeze/scope and exact manifest readback hash. An absent child or invented manifest hash is denied.
- Owner HTTP acceptance creates separate immutable publication authority. Repeating the same request reuses the receipt, while DRAFT stays DRAFT. Invalid V2 bytes and later purge deny publication/read; accepted heads retain their immutable receipts.
- Portable backup explicitly includes publication receipts/heads, COW W2/W3 admission histories and model/budget COW locators. Unknown tables or columns still fail closed; live credentials and grants remain excluded, with immutable historical grant provenance exported separately.
- Cloudflare target attestation lives in `@eliotr/cloudflare-backup`, alongside the provider adapter. O2-only `@eliotr/backup-o2` owns manifest/crypto verification. Preflight bounds accumulated plaintext to 8 MiB and returns only `PREFLIGHT_VERIFIED_NO_WRITES`. A later purge rejects before offsite reads or target writes.

## Verification and honest limits

- Workerd/D1/R2: dedicated COW W2 2/2; REPORT admission 2/2; owner HTTP publication 2/2. The COW readback test proves absent-child and wrong-hash negatives as well as a real child commit and immutable replay. HTTP verifies ACCEPTED/replay/read, purge denial and corrupted V2 refusal.
- Backup suite: first default 5-second run had 115 PASS and 2 timeout failures. Repeating at a local test-harness timeout of 20 seconds passed 117/117. This changes no production or acceptance threshold. After placing target attestation in its platform package, the Cloudflare backup suite passed 21/21 (12 preflight and 9 transport checks).
- Core TypeScript, focused ESLint, import boundaries and complete canonical table/column inventory pass. Depth-100 SQL compilation passes with 110 explicitly unresolved dynamic/non-SQL prepare sites in this checkpoint; it is not exhaustive query acceptance.
- Broad source budgets have inherited failures and this combined branch also grows existing oversized packages. No limit was increased and no broad budget PASS is claimed. Local controlled model responses never qualify S93 or live provider behavior.
- GitHub workflows are manual. An empty status rollup or zero runs is NOT EXECUTED, not CI PASS. No workflow dispatch was requested.

## Remaining critical path

The separate COW, W3 and owner-publication primitives are not yet a proven full owner loop. Core still needs the section-revise HTTP/dispatch composition and exact mapping between the fresh REPORT execution scope and immutable historical artifact/freeze/handle provenance. The section producer currently compares those different scopes as equal, so that genuine code gap must be repaired without changing immutable spec/freeze identities. Run a real local synthesis -> independent verification -> child CAS -> owner ACCEPTED -> restart/purge-negative loop before declaring S92 complete.

Restore preflight is not disaster recovery. O2 offsite copy currently transports the 15 encrypted manifest parts and R2 object inventory, not R2 payload bytes. Missing code includes authenticated bounded payload transport, exact current purge/terminal-target/backup-obligation reconciliation before writes, canonical VERIFIED backup_epoch linkage, and a coherent WORK_BUCKET manifest-part sink that avoids self-inventory drift. Missing or ambiguous archive authority must continue to block BackupRestorePath; never fabricate VERIFIED rows or traffic readiness.

After those code gaps, S94/S93/S95/S96/S97 need an exact approved isolated target and their own native/live evidence. Current instructions prohibit live apply, spending and new credentials; the next engineering steps need no new A/B choice.
