# S12 — Machine access to saved reports and exact citations

Baseline: `a2aca127`; finding F09. Depends on S10/#202. Reader unit/integration tests need not wait for S11's complete run path.

## 1. Problem

Starting a run is insufficient: a service client also needs its result, sections, and evidence. Most artifact/reauthorization routes remain owner-only. A result visible in the PWA is not necessarily a usable machine product.

## 2. Required change

Allow an authorized service principal to use the existing artifact/section/citations/open readers within its permitted project. Do not enable Wiki publication or erasure in this task.

## 3. Documentation and exact search anchors

[Architecture, sections 7.9 and 9.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'A model cannot mint citation IDs.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 9.3. Evidence labels' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse the artifact draft reader, historical reauthorization, and exact Evidence resolver. Generalize their authorization context instead of cloning owner readers under new names. Enforce existing streaming bounds and revocation/purge rules. Preserve DRAFT status, coverage, and claim verdicts; service access does not upgrade a result. Access to another owner's report requires an explicit applicable grant and cannot be inferred merely from ownership of one source.

## 5. Acceptance criteria

- [ ] An authorized headless client obtains the same body digest, section, and exact excerpt as an authorized owner.
- [ ] Foreign report IDs, denied projects, purged dependencies, and revoked policies expose neither bytes nor metadata.
- [ ] Historical citations refer to their original revision, not the current source head.
- [ ] Reading invokes no paid synthesis and changes neither artifacts nor permissions.
- [ ] Add actual HTTP/D1/R2 tests and, once S11 is implemented, a combined run-to-result scenario. Record exact SHA and results.
