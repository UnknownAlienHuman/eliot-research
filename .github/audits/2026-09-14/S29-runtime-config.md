# S29 — Replace split semantic environment JSON with one configuration revision

Baseline: `a2aca127`; finding F25. Scope: ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0/_1, not redesign of the entire AI system.

## 1. Problem

Large semantic configuration is split across environment bindings, making verification and deployment state harder to manage. This is not evidence that Budget Governor, the AI Search registry, or native Dynamic Routes should be deleted.

## 2. Required change

Store non-secret semantic configuration as one immutable revision in existing storage. Keep a short reference and digest in the environment. Provider/gateway tokens remain Worker secrets.

## 3. Documentation and exact search anchors

[Architecture, sections 8.2 and 8.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [runtime configuration](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/research-runtime-configuration.md).

```sh
git grep -n -F '## 8.5. Generation change gate' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0' -- apps scripts docs
```

## 4. Implementation approach

Reuse R2 Work immutable-object/readback patterns and the existing parser. Do not create a configuration service or another authority store. Validate version/hash/shape before execution. Cache only immutable identity-bound bytes, not current grants. Provide an explicit transition: recognize the old split format during migration, switch deliberately, then remove it. Reject ambiguous mixed sources. Do not perform network reads inside a D1 transaction.

## 5. Acceptance criteria

- [ ] One versioned configuration is read correctly and bound to run provenance.
- [ ] Missing, corrupt, or wrong-version configuration fails before model dispatch with a specific safe reason.
- [ ] Migration/restart/rollback cannot silently change a run's frozen model, prompt, or schema.
- [ ] Secret values never enter configuration JSON, R2, Git, or the browser; no second configuration framework is introduced.
- [ ] Preserve required model/generation/budget checks; attach exact tests/SHA and migration instructions.
