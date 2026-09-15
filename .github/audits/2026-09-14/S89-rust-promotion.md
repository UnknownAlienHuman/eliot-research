# S89 — Ten caller-promotion units, each with explicit M6/M7 proof

Baseline `a2aca127`; ER-40/24/00. Prerequisite: S88's accepted ABI for the specific ready family and that family's S78–S87 parity. Implement these units separately; no whole-project switch and no new global runtime registry.

## 1. Problem

CI vectors and shadow results do not establish actual runtime ownership. A promoted path must use one accepted deterministic decision, retain SQL/platform enforcement, and work after the superseded TS production decision is removed.

## 2. Required change

For each numbered unit below, connect the existing real application caller to the accepted Rust export, prove it with the old TS decision disabled, then remove that superseded production implementation. Preserve reference fixtures and historical byte identities. The aggregate PR closes only when its ten applicable units have actual results.

## 3. Documentation and execution references

[Language §10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [Launch09 K6/K7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), [closed export/family map and commands](https://github.com/UnknownAlienHuman/eliot-research/blob/audit/20260914-execution-index/.github/audits/2026-09-14/EXECUTION-STEPS-03.md).

```sh
git grep -n -F 'K6 — controlled per-family Rust promotion.' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Ordered units and the same four-step implementation

| Unit | Accepted family | Actual integration boundary and retained regression |
|---|---|---|
| 89.1 | S78 canonical/identity | Current identity/codec callers, starting with the accepted retrieval/domain identity path. Retain exact saved digests/IDs and malformed-input errors. |
| 89.2 | S79 owner transitions/cutover | TS owner adapters using domain/source-ownership.ts and owner-cutover.ts. Repeat S70 actual owner/fence/cutover races. |
| 89.3 | S80 scope | Existing cloudflare-navigation scope/authority loader. Repeat S08/S33/S99 replay, expiry, full membership and historical-read tests. |
| 89.4 | S81 policy/residency/budget | Existing authorization evaluator, domain/residency.ts and model-spend-admission pure decision. Repeat S10/S69/S70 negative disclosure and actual reservation tests. |
| 89.5 | S82 source admission/qualification | Existing normalized ingress consuming domain/source-admission.ts and qualification.ts. Repeat S47/S98 valid/degraded/foreign/partial ingress. |
| 89.6 | S83 projection | Existing structural materialization/coordinate-map callers exported by cloudflare-navigation. Repeat S48/S52 map/byte/generation acceptance. |
| 89.7 | S84 evidence/coverage | Existing exact resolver and coverage/exhaustive completion. Repeat S48/S51 exact bytes, failed shards and unknown denominator cases. |
| 89.8 | S85 Research/publication | Existing W1 transition/claim-acceptance/publication callers. Repeat S36/S38/S40/S54 mutation-mask, verifier and edited-claim tests. |
| 89.9 | S86 erasure | Existing coordinator's pure closure decision only. Repeat S63/S66 full/partial/held closure and purge-first restore checks. |
| 89.10 | S87 federation | Existing federation fence/admissibility/result mapping in the real service. Repeat independent S60/S61 wire/replay/denial tests. |

For each unit perform exactly:

1. **Freeze the promotion input.** Retain its TS/native/Wasm independent vectors, property/mutation result, actual workerd shadow, ABI/schema/family identity and measured memory/CPU/size. Use the existing Launch09 row and current caller; unready families do not switch with a ready neighbor.
2. **Switch the decision, not the effects.** The TS caller passes verified explicit observations to the mapped export and consumes the typed result. TS still validates wire bounds and performs HTTP/D1/R2/Queue/Workflow effects. SQL still verifies current identity/revision/policy/purge/CAS at settlement. The kernel must not read its own policy, clock or platform objects.
3. **Prove removal before deleting.** Run the actual caller integration with the old TS decision disabled. Test positive, denial, stale/replay, trap/wrong ABI and historical-byte cases. Remove that superseded TS production decision and repeat the same test. Shared fixtures and independently useful decoders are not another production authority and need not be deleted to satisfy a line count.
4. **Record and advance.** Save the exact implementing SHA, operation/receipt/hashes, test commands/results, deleted function names and accepted rollback target in existing Launch09 and this PR. Proceed to the next ready unit without waiting for unrelated future external receipts.

A trap/ABI mismatch fails the affected operation; there is no silent permissive TS fallback. Unknown active-run compatibility does not permit destroying or replacing runs. Use S05/S67's proven version transition or the existing safe drain/pause path for affected work; preserve readable historical inputs/results. Do not rebuild all family crates, clone adapters or create a global Rust=true switch.

Use applicable existing Rust deep gates (including #176), each unit's original domain checks and actual core Workers tests. Run broad browser/headless regression after the relevant integrated group, plus S90 build/runtime measurements. No test claim is based solely on embedded Wasm self-tests.

## 5. Acceptance criteria

- [ ] Units 89.1–89.10 each have actual caller→accepted compiled operation→typed outcome proof and retained before/after identity/error fixtures.
- [ ] Each promoted caller passes with the old TS decision removed; injecting an invalid Rust decision is detected by an actual application-boundary test.
- [ ] Trap/wrong ABI/revoke/purge/concurrency/replay cannot strengthen permission, alter historical bytes or repeat completed paid effects.
- [ ] SQL atomic guards and TS platform responsibilities remain; the exact removed duplicates are recorded, not guessed from LOC.
- [ ] Per-unit implementation/deep-check/runtime-budget results are complete. One successful family, an aggregate language percentage or a documentation merge is not completion.
