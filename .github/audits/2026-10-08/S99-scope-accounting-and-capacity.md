# S99 — Полный frozen scope уже есть; закончить точный учёт и сквозную приёмку

Дата проверки: 2026-10-08. Source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.
**Статус: документационное задание, runtime/SQL не изменены.** Сохранены исходные #291/S99 критерии, migration 0071 и checkpoint e09e9ef4. Старую planning-ветку не вливать как implementation; писать исправления от актуального source baseline.

## 1. Читать и переиспользовать существующее

- [Architecture §7.5 и §§6.7–6.10](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/architecture/ELIOT_RESEARCH.md): SourcePortfolio, trace, frozen denominator и exhaustive отсутствие; [workflow-checkpoints — Full owner Research scope](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/implementation/workflow-checkpoints.md).
- [owner-scope-profile.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/owner-scope-profile.ts): `requireOwnerScopeProfile`, `readOwnerScopeProfile`, `bindOwnerResearchScopeProfile`, `createProfiledOwnerScopeService`. Уже разделены 4096 Research members, 1000 explicit IDs и legacy 64.
- [createOrientationApi](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/orientation-service.ts): execution scope замораживается целиком; `.slice(0, 64)` ограничивает metadata preview, а НЕ сохранённый snapshot.
- [prepareResearchRunScope / loadResearchPlanningSources](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-runtime/src/research-run-admission.ts): replay не refreeze-ит новые heads; planning sources загружаются через `splitExhaustiveSourceRefs` с проверкой каждого исходного member.
- [owner-historical-scope.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/owner-historical-scope.ts): `requireHistoricalScopeOrigin`, `provesSourceHeadAdvance`, exact original-member checks. История не должна незаметно подменять старые revisions текущими.

**Не требуется снова реализовывать profile, freezer, batch loader или historical reauthorization.** Число 4096 — metadata envelope, не приёмка retrieval quality, body-size или представимости Cloudflare filter.

## 2. CODE A — trace должен считать выполненную работу

В `orientation-service.ts` поле `candidates_by_lane.SOURCECARD` заполняется длиной ВСЕГО snapshot. Но [navigation-service.ts: orient](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/navigation-service.ts#L336-L453) рассматривает bounded candidateSources: `min(MAX_ORIENTATION_CANDIDATES, max(maximum_sources*4, maximum_sources))`; отдельно materializeMetadataNavigation создаёт preview максимум для 64 execution members.

При corpus 299, max_results=16, без Atlas: выбор candidateSources ограничен 64, а trace записывает 299. Это статически подтверждённое расхождение факта работы и счётчика; не доказательство усечения frozen corpus или live disclosure.

Исправлять `packages/cloudflare-navigation/src/navigation-service.ts` и `orientation-service.ts`: считать selected candidates там, где сформирован candidateSources, available cards — после exact decode, represented — после map/output ограничения. Передавать эти счётчики в caller одним внутренним immutable work result, а не повторно вычислять второй candidate algorithm. Возможное имя нового private helper — `orientWithWork`; существующий public `orient` должен использовать ту же реализацию и возвращать прежний совместимый результат.

`candidates_by_lane` получает actual selected candidate count. Denominator продолжает читаться из full ScopeSnapshot; represented/omitted counts — из existing NavigationResult. Не выдавать маленький omission sample за весь omitted set; сохранять `omitted_source_revision_count` и `omissions_truncated`. Не вводить новый telemetry service или дублирующий ScopeCoverage registry.

Если internal work result становится частью persisted/public wire, согласовать versioned codec, readers и identity; старые trace не переписывать. Для минимального среза предпочтителен server-only work result плюс существующие поля trace, с новым корректно маркированным execution profile при изменении persisted semantics.

## 3. CODE B — провести scope через существующий путь, не менять все 64

Проследить и сохранить цепочку: `prepareResearchRunScope` → `createOrientationApi` → `bindOwnerResearchScopeProfile` → `loadResearchPlanningSources` → held-scope retrieval/freeze → historical artifact read. Использовать исходный `member_source_revision_refs`, не preview cards и не query top-k. Исправлять конкретный residual caller только после найденной потери profile/members; перечисленные уже работающие методы не переписывать.

`readOwnerScopeProfile` возвращает legacy только для отсутствующего profile и допустимого старого размера. Не добавлять permissive v2 fallback для corrupt/missing profile большого corpus. JWT renewal/history не продлевает старое execution admission автоматически. Исторические SourceRevision и current revoke/purge/owner checks нужны одновременно.

`splitExhaustiveSourceRefs`, `loadResearchPlanningSources` и `provesSourceHeadAdvance` уже используют bounded reads; последние два передают batch как JSON в `json_each(?1)`, а не один bind parameter на source. Не заменять это тысячами placeholders. D1 сейчас ограничивает statement 100 bound parameters и 30 секундами выполнения; JSON array всё равно нуждается в byte/row/work bounds. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/), прочитано 2026-10-08.

## 4. CODE C — не обещать managed capacity по одному scope cap

#320 — отдельный bounded prefilter patch; #242 — managed hybrid/budgets. Их наличие в draft не означает, что они уже работают на main. Большой 4096-member snapshot не обязан помещаться в single filter #320. S99 не обрезает IDs и не откатывается к unfiltered search.

До оплачиваемого/модельного действия определить представимость ВЫБРАННОГО retrieval profile. Непредставимый scope получает честный limit/degradation и объяснение разрешённого exact/exhaustive либо явного partition пути. Автоматического paid fan-out нет; не вводить G3 reindex/новый provider как скрытую зависимость S99.

Исходное требование S99 «полезный tail source доступен» сохраняется: доказать его на actual qualified retrieval profile отдельно от scope-freeze/history. Контролируемый fake provider пригоден для local wiring, но не доказывает, что managed Search обслужит весь такой corpus. Без настоящего совместимого retrieval evidence S99 остаётся частично незавершённым, даже если 4096 metadata успешно сохранены.

## 5. DOCS — четыре различных размера вместо универсального capacity

В #291, workflow-checkpoints и existing status/gap entries различать:

`frozen_members / preview_candidates / provider_candidate_pool / resolved_evidence`.

Дополнительно указывать explicit-selected-ID cap и canonical UTF-8 envelope. 64 preview, 16 результатов и 4096 members — не взаимозаменяемые константы. Формулировка «в проекте по-прежнему общий лимит 64» неверна для прочитанного execution path.

#293/#294 SQL-target/grant результаты брать из текущего backend-delivery-plan, не из старого текста S99. Закрытый #243 не переоткрывать автоматически; сохранить его реальный exhaustive implementation и negative criteria. Не менять claimed implementation state по одному docs diff.

## 6. Конкретная приёмка после assembly

- 65 и 299 действительно admitted sources: полный exact snapshot/profile/planning portfolio сохранён; preview не меняет denominator. 4096 — отдельный boundary test, не обязательный model-call-per-document сценарий.
- Corpus 299 / max_results 16 / без Atlas: trace показывает 64 selected candidates, <=16 represented и полный размер scope 299. Missing card/map уменьшает соответствующий observed count, а не denominator.
- Tail beyond 64 достигает подходящего exact/exhaustive И отдельно qualified relevance/counter-search пути. No-hit/partial scan не даёт NO_MATCH_IN_COMPLETE_SCOPE.
- Lost ACK freeze/profile/reservation, reload, head advance и history сохраняют исходные members и refs; новый текущий документ не попадает в старый отчёт.
- Foreign/revoked/purged member, missing v2 profile, подменённый profile и неподдержанный byte/member/filter envelope отклоняются без silent truncation. Отдельно проверяется unrepresentable managed scope BEFORE paid calls.
- Контролируемый D1 transport, native D1, managed Search, quality и latency — разные receipts; ни один не заменяет остальные. Не запускать исторический uncertain run для приёмки.

Code-first: scoped build `packages/cloudflare-navigation/tsconfig.json`, `packages/cloudflare-research-runtime/tsconfig.json`, scoped ESLint; при SQL — `pnpm d1:depth`. Existing scope/history/retrieval fixtures расширить после сборки. **Implementation/compilation/native/quality результатов в этом docs PR нет, PENDING.** Нет новой БД, workflow engine, permission cache, deployment, paid calls, backup или GitHub-комментариев.
