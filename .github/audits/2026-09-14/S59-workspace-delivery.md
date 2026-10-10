# S59 — Deliver a canonical artifact to Google and verify that copy

Baseline: `a2aca127`; ER-11/36/24. Reuse export and Workspace plan/observation services, with canonical REPORT #245/#246. Selected profile: gemini-mcp, not legacy drive-exchange.

## 1. Problem

Importing Google content does not complete outbound delivery. Google failures must not destroy the canonical artifact or start Research again. Google-native representations also cannot be assumed byte-identical to a Markdown export.

## 2. Required change

Connect canonical artifact reference → authorized deterministic export → existing candidate sync plan → official selected-client Drive/Docs action → exact read/export-back → delivery observation/reconciliation. Bind artifact revision/hash, parent, representation/transform version, and operation identity before writing. Pin an existing target ID for update; for creation, retain the actual provider-created ID as soon as it is observed. Do not invent an ID the selected connector cannot reserve.

Expose Copy to Google in the existing result UI without introducing another publishing backend.

## 3. Documentation and exact search anchors

[ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md); [architecture, section 9.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'A future authenticated ELIOT admission/reconciliation contract' -- docs/adr/0006-google-external-transport-profiles.md
```

## 4. Implementation approach

The server reads only the authorized artifact revision and preserves DRAFT/accepted labels, limitations, and lineage. The separately connected client executes Google I/O. Define the comparison representation before the action: compare read-back bytes for a byte-preserving export, or a documented canonical representation for a native Doc. Do not compare a provider ZIP/PDF container directly with Markdown and call the difference corruption.

An authenticated caller observation alone is not proof that an external action happened. A verified delivery status requires the independently observed readback supported by the actually qualified connector. On a lost creation acknowledgement, reconcile using retained provider/action identity and the connector's demonstrated capabilities before attempting creation again. Filename alone is not unique identity. If the outcome cannot be proved, retain UNKNOWN and an explicit reconciliation action rather than promising exactly-once creation or making a second Doc.

Content/parent/revision mismatch is conflict/unknown; the original artifact remains available. Permission, reauthentication, and Google outage belong to delivery state, not Research state. Register managed external copies with dependency/erasure inventory #247 and respect disclosure ceilings. Transfer large exports through bounded file/handle paths, not base64 JSON. No Worker Google secrets or custom OAuth/Cloud project is introduced.

## 5. Acceptance criteria

- [ ] Exact selected-representation readback verifies the intended artifact revision and preserves status/limitations; wrong parent/content/representation fails.
- [ ] Replay, restart, and lost acknowledgements do not cause blind duplicate creation or false DELIVERED. Unreconcilable creation remains explicitly UNKNOWN.
- [ ] Google outage leaves the canonical report and citations readable under current authorization.
- [ ] Revoked disclosure prevents delivery; governed-copy dependencies are recorded.
- [ ] Record local transport tests and exact SHA separately from actual selected-client/connector action and readback receipts. Do not assume unsupported provider idempotency or normalization guarantees.
