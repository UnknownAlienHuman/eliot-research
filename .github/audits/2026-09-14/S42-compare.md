# S42 — Compare sources along verifiable dimensions

Baseline: `a2aca127`; ER-08/10/11. Requires #227 and the shared result path #233. Scope: one product.

## 1. Problem

Comparison is not two summaries placed side by side. It needs defined axes, versions, measurement conditions, and explicit missing data.

## 2. Required change

Implement an approved COMPARE profile. Targets are authorized source/version references; axes come from the question/protocol. Each outcome cell carries value, unit, conditions, support references, and unknowns. Separate observed differences from recommendations. Persist through existing artifact sections and audit.

## 3. Documentation and exact search anchors

[Architecture, sections 7.12 and 19.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'Dimension-based comparison of documents' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse protocol/prompt/model/output adapters. Bind targets/axes to request identity and frozen inputs. Assess comparability using recorded versions, populations, times, and units. Unit conversion requires an explicit reproducible deterministic operation retaining original values, not silent model substitution. Missing fields remain unknown/not comparable, never zero/false. Include both sides in authorized scope and coverage; duplicate copies are not independent evidence. UI/MCP read one persisted result with exact cell citations; do not create another report engine.

## 5. Acceptance criteria

- [ ] Fixtures with changed-version conditions, differing units, and missing axes preserve correct differences and unknowns.
- [ ] Numbers without exact supporting excerpts cannot be accepted.
- [ ] Foreign-scope targets fail; axis ordering/replay follows a documented request identity and does not repeat completed paid work.
- [ ] Actual API→audit→artifact/citation tests pass with exact SHA/results.
- [ ] Real T3 quality acceptance remains separate from controlled-model integration tests.
