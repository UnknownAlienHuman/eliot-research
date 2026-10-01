# S87 — Port federation fence, candidate, and disposition decisions

Baseline `a2aca127`; ER-22/41/40. Target eliotr-federation-core. Use the accepted #252/#253 wire/execution path as the reference; do not replace an independent peer protocol with internal Research DTOs.

## 1. Problem

Transport COMPLETED cannot strengthen a research outcome. Credential/fence/manifest checks and candidate semantics remain required regardless of implementation language.

## 2. Required change

Port pure request admissibility, fence/bridge/reference-manifest compatibility, and internal-to-wire completion mapping. HTTP signing/authentication, status persistence, bundle streaming, and external-provider invocation remain TypeScript responsibilities.

## 3. Documentation and exact search anchors

[Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md); [Architecture section 11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'K4.federation fence/candidate mapping' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Implementation approach

Use existing versioned schemas and explicit verified principal/fence/bridge/grant/source facts. Matching a field name cannot authorize references outside the manifest. Preserve native research dispositions and unknown outcomes without stronger mappings. Peer outputs remain untrusted candidates until canonical admission; receipt-shaped client JSON is not execution proof.

Preserve the legitimate distinction between W2 run identity and W3 model-operation identity; do not implement the audit's refuted SQL finding. Introduce no client database dependency, ELIOT runtime package, reverse canonical mutation, or alternate federation service. A shared server codec is not an independent wire oracle.

## 5. Acceptance criteria

- [ ] TS/native/Wasm agree on approved, foreign, stale, unknown-version, substituted-manifest, and disposition-mapping cases.
- [ ] Transport completion/ACK cannot upgrade partial, inconclusive, or unknown research outcomes; candidate admission is not automatic.
- [ ] Missing-fence and stronger-disposition mutations are detected; the independent #253 client remains valid.
- [ ] Record pure Rust gates, fixtures, exact SHAs, and results. Actual caller shadow/promotion is verified separately under S89.
