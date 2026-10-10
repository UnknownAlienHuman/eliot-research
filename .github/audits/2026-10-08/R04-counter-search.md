# R04 / S22 — Контрпоиск и проверяемая связь с гипотезой

Статус: IMPLEMENTATION TASK, только документация. Проверка 2026-10-08 на `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. [PR #214](https://github.com/UnknownAlienHuman/eliot-research/pull/214). [Исходный паспорт S22](https://github.com/UnknownAlienHuman/eliot-research/blob/56776c25a9835cd7acb5162af547b33798dc11bb/.github/audits/2026-09-14/S22-counter-search.md) и negative requirements сохраняются. Не вливать старую planning-ветку как новую реализацию.

## 1. Читать

- `docs/architecture/ELIOT_RESEARCH.md`, §§7.2, 7.8–7.9: counter obligation, protocol, EvidenceFreeze и claim audit.
- [research-branch-execution.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-branch-execution.ts): текущие counter handler/recovery.
- [research-branch-execution-results.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-branch-execution-results.ts): `evidenceForRole`, `buildRoleResultFromModelOutput`, debts.
- [research-evidence-freeze-branch-lineage.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-evidence-freeze-branch-lineage.ts): binding counter refs и unresolved contradictions.
- R03/#325 — общий question/finding envelope; R02/#242 — scoped managed results. Не вводить независимые альтернативы этим двум контрактам.

## 2. Требуемый результат

COUNTER_SEARCH исполняет собственный вопрос из planning manifest в исходном frozen corpus. Найденный passage становится relation candidate к конкретному claim/hypothesis, а не автоматически contradiction. No-hit — результат исполненного плана с определёнными границами, не доказательство отсутствия контрпримеров в corpus.

## 3. CODE — законченный corpus-only путь

1. Использовать immutable root/branch question binding R03. Counter получает исходную цель, проверяемую гипотезу и falsification conditions. Итоговый SUPPORT prose не становится его инструкцией.
2. В shared `research-branch-execution.ts` вызвать `retrieveWithHeldScope` через существующий injected retrieval port для counter question, вместо повторного анализа одного stage-five pack. Лимиты задаёт сервер, scope не расширяется. Required role с ошибкой остаётся незавершённой, optional absent role делает zero model calls.
3. Удалить authority через подстроки `source_class` в `research-branch-execution-results.ts`. Role membership происходит из планового query/selection receipt; source class описывает источник, не смысл passage.
4. Использовать versioned finding contract R03 в `packages/contracts/src/research-branch.ts` и `research-branch-role-output.ts`. Candidate связывает proposition, hypothesis/claim ref, relation, evidence refs, qualifications и uncertainty. Переиспользовать существующий relation vocabulary; не создавать синонимичные enums или вторую таблицу истины.
5. Search trace сохраняет фактический query, scope, candidate/scan work, stop reason и no-hit/failure. Не добавлять отдельный search journal: reuse R02 trace, branch results и ResearchDebt/failed_probe_refs.
6. Согласованно изменить `research-evidence-freeze-branch-lineage.ts` и его freeze consumer. Убрать автоматическое равенство selected counter handle → unresolved_contradiction_ref. Membership, candidate relation и verified disposition — разные проверки. Неосмысленный список handles не закрывает counter obligation.
7. До EvidenceFreeze включить точные handles обеих сторон, qualifications и open debt. После freeze новый материал допускается только существующим reopen/revision протоколом. Synthesis/AUDIT_CLAIMS должны видеть opposing findings; только существующий verifier/claim audit может повысить их статус. Не переносить сюда аудит из будущей стадии и не создавать циклическую зависимость.

## 4. Донор и native функции

[PaperQA2 GatherEvidence](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/agents/tools.py#L250-L315): отдельный targeted question для evidence. Перенести question-bound context, не shared mutable `session.question` и не Python engine.

Cloudflare `instance.search()` используется только через R02, а не отдельным raw provider client. Eliot resolver, W1/W2/W3, reference firewall и debt services сохраняются. Counter model не получает SQL, backend credentials или право публиковать truth.

## 5. DOCS, generations, зависимости

R03/#325 первым интегрирует общие question/finding types и non-counter producer/consumer. R04 затем меняет counter behavior и freeze lineage; одновременное редактирование shared contracts/executor запрещено. R02 нужен для итоговой native retrieval-приёмки; R00 сохраняет причины отказов.

В архитектуре §§7.8–7.9 и исходном S22 packet уточнить: COMPLETE означает выполненный обязательный counter plan, не `handle_count > 0` и не COMPLETE_SCOPE. Реальный coverage denominator остаётся SourcePortfolio. Новые handler/lineage codecs не переинтерпретируют старые checkpoints. Forward migration — только при реальной persisted schema change, с согласованием vocabulary R00.

Обновлять existing status/gap entries только по поставленному коду. Не создавать десятый CompletionDisposition или fake ATOM/ARGUMENT executor.

## 6. Результат и отрицательная приёмка

- Контрпример вне первоначального общего top-k находится отдельным counter query и достигает freeze/audit/report.
- Релевантный, но не противоречащий passage не становится contradiction; qualifies и alternative не путаются с refutation.
- `counterfeit-product` не даёт counter authority; реальный negative result не теряется из-за отсутствия слова counter в source_class.
- No-hit, timeout, malformed response и unavailable branch имеют разные outcome/limitations; required unexecuted role не засчитывается.
- Foreign/stale/purged/revoked/cancelled inputs, изменённая hypothesis и mixed generations отвергаются; same committed model result не вызывается повторно.
- Неудача соседней ветки не уничтожает уже сохранённое допустимое opposing evidence. Post-freeze изменение не наследует старый claim audit.

Code-first: `pnpm exec tsc -b packages/cloudflare-research-branches/tsconfig.json packages/cloudflare-research-runtime/tsconfig.json --pretty false`, scoped ESLint; SQL — `pnpm d1:depth`. Existing branch/freeze/recovery fixtures расширяются после assembly. Implementation, compilation и behavioral/native/quality evidence сейчас PENDING.

Corpus-only: никакого Web Search/crawl. WEB остаётся у #231. GraphRAG, notebooks/UI, deployment, paid calls, replay старого uncertain run, backups и новые GitHub-комментарии не входят.
