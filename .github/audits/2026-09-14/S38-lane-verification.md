# S38 — Keep confirmatory and exploratory lanes explicitly distinct

Baseline: `a2aca127`; ER-08/10/03. Requires #227. Reuse W1 and existing pure lane rules; connect them to actual acceptance rather than creating another verification system.

## 1. Problem

Completing legacy confirmatory checkpoints does not establish preregistration, independent confirmation, or a valid verification certificate.

## 2. Required change

Enforce LaneRegistration and named-verifier acceptance in run admission/branch completion. Register protocol, hypothesis, evaluator, exclusions, and primary metric before outcome exposure. Mixed-lane work requires an explicit split rather than an unlabeled shared EvidencePack.

## 3. Documentation and exact search anchors

[Architecture, sections 7.1 and 7.3–7.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 7.3. Confirmatory and exploratory lanes' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'only the named verifier may issue the certificate' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Existing Investigation services/W1 commands check registration digests and exposure order within guarded mutations. Select the verifier from the AllowedReferenceManifest/approved protocol, never from a worker's model output. Exact-source certificates use the Evidence resolver. Measurement/build/proof certificates require the corresponding qualified external verifier and immutable input/output evidence.

An unavailable verifier leaves its obligation BLOCKED with a typed next probe; do not execute unsafe code in the Worker to bypass it. Implement protocol-specific adapters behind existing ports, not a universal execution framework. After outcome exposure, changes require a declared deviation and an appropriate exploratory result, or new preregistration before new independent data. Grade supersession is versioned; preserve historical evidence labels.

## 5. Acceptance criteria

- [ ] Post-exposure metric/exclusion/evaluator changes cannot receive confirmatory acceptance; a valid held-out/independent case passes its named verifier.
- [ ] Self-issued certificates and model agreement presented as verification are rejected.
- [ ] Compliant negative results are retained; mixed-lane evidence cannot cross a blinded boundary.
- [ ] Legacy replay cannot strengthen the original disposition.
- [ ] Actual HTTP/W1/Workflow tests cover declared supported protocols with real verifier paths or explicit blocked obligations. Record exact SHA/results; no false E3 claim.
