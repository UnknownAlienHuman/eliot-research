# Eliot Research — полный план завершения v1 и сверка аудитов

**99 PR-заданий S01–S99 (#193–#291). Этот документ — индекс и карта покрытия, не сотая реализация, не новый runtime registry и не заявление о готовом приложении.**

Проверенная кодовая база: `main@a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Аудиты датированы2026-09-14; дополнение очереди завершено2026-09-15 UTC. Дата каталога сохраняет дату исходного аудита. Составление PR не изменило product code/main или живой deployment.

## 1. Цель, границы и авторитетные источники

Завершить обязательный **production-ready v1: Slices0–6, выбранный gemini-mcp профиль**, по [ELIOT_RESEARCH29.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [LANGUAGE_RUNTIME_CONTRACT1.0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md) и [production-readiness-plan](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).

Один Worker с PWA/HTTP/MCP/Queue/DO/Workflows. D1 Core/R2 — canonical; D1 Search/AI Search — rebuildable projections. TypeScript — Cloudflare control plane; Rust — принятые pure deterministic decisions; SQL — схема и atomic invariants. Никакого нового backend, agent framework, policy DSL или второго registry.

Не добавляются как обязательные: невыбранный legacy drive-exchange/custom OAuth, Google Cloud project, клиентский ELIOT runtime, specialist profiles Slice7 и optional Browser Rendering/R2 SQL. Работа с обычными scientific sources, таблицами и conversation exports не означает включения всех optional specialist-продуктов.

Код и его узкие regression/negative/replay tests выполняются сначала. Большие качественные/нагрузочные/live проверки — после готовности соответствующих путей. Число закрытых карточек не критерий production-ready: конечная проверка — **S97/#289**.

## 2. Порядок исполнения

**Начало:** S01–S04 возвращают наблюдаемую диагностику и реальные D1/browser tests. S02 технически независим от S01; номер — приоритет, не разрешение начать.

**Основной backend:** S05–S15, S31–S34, S17. Сюда же сразу входят **S98 и S99**, несмотря на поздние номера: полноценный headless ingest и scope больше64источников нельзя откладывать за выпуск.

**Полный Research:** S35–S46 с S21–S23; источники/navigation/retrieval S47–S52. Затем compiler/publication/dependencies и интеграции S53–S61. Source admission и compiler можно разрабатывать до завершения целого DEEP-продукта: зависимость относится к конкретным interfaces/results, не к целой тематической ветке.

**Сохранность и эксплуатация:** S62–S72. **Все человеческие экраны:** S26/S73–S75, а не только перестановка Research-панелей. UI использует тот же API, что headless, не исправляет backend своей второй логикой.

**Язык и сопровождение:** S76–S91. Pure Rust family переносится после стабилизации её semantics; готовую identity family и ABI можно проверять раньше. По каждой family: parity → shadow → actual caller switch → удаление заменённой TS authority. Не массовая перепись всего проекта.

**Общая приёмка:** S92 local integration → S94 первая полная разрешённая staging-выкладка → S93 quality + S95 native/security + S96 workload → S97 release/canary. Подготовка runners/corpus не требует live credentials. Реальные T4/T6 receipts не являются круговым предусловием их первой staging-среды.

Это не распоряжение запустить99агентов одновременно. Product changes выполняются последовательно в актуальном **main, без локальных worktrees**. Общие composition/routes/Env/contracts/migrations/locks/CI изменяются согласованно, без конфликтующих писателей. Remote planning branches — оболочки заданий; merge Markdown не означает исправление приложения.

### Технические зависимости без целых тематических циклов

```text
S10 authorizer -> S31 owner grant CRUD
S10 -> S11 query/run/status + S12 report/evidence -> S13 MCP
S14 cancel + S15 recover + S13 -> S32 клиентские controls
S10/S31 + normalized admission -> S98 machine ingest
S05/S06 -> S33 long-run authority; S29 -> S34 model-proof lifecycle
S35 protocol -> S36 portfolio -> S37 actual branch execution
S35 + S09 -> S22 counter-search -> S37 integration
S35/S36 -> S38 verifier/lane -> S40 debts/reopen
S37/S38/S39/S40 -> S46 DEEP orchestration
S47 admission -> S48 navigation -> S49 Atlas
S47 -> S51 exhaustive + S52 projection lifecycle
S53 compiler + S38 -> S54 publication; S53 -> S55 dependencies
S62 erasure request + S55 -> S63 closure
S65 epoch + S63 purge + S52 rebuild -> S66 restore
S05 + S52 -> S67 code/index rollback (не data restore)
S78 ready identity family -> S88 product ABI/shadow
accepted S79–S87 family + S88 -> S89 per-family promotion/removal
integrated product including S98/S99 -> S92 local integration
S92 + code/config/build readiness -> S94 first staging
S94 -> S93/S95/S96 -> S97 release
```

## 3. Решения, которые уже определены в заданиях

**Deployment:** S05 различает точный build provenance и fingerprint backend/handler/schema/config совместимости. PWA-only изменение не является отзывом. Неизвестную совместимость нельзя скрыть постоянным generation ID; backend rollback отдельно S67.

**Agent access:** S10 выбирает один `project_client_grant`, verified issuer/subject/service identity, owner ceiling и существующие snapshot grants. S31 задаёт owner CRUD. Агент не становится owner_pwa и не получает browser JWT. S98 добавляет явный ingest.bundle и namespace allow-set к тому же механизму; project read сам по себе не source write или ownership transfer.

**Run lifecycle:** историческое чтение S06, execution grant S33, model-proof expiry S34 и source revision S07 различаются. Frozen inputs/receipts не переписываются. S15 запрещает повторный SYNTHESIZE, но допускает первый законный AUDIT_CLAIMS по собственной reservation; общий счётчик платных вызовов не обязан остаться прежним.

**Корпус:** S99 использует существующий larger scope loader, не новый storage. Generic scope-service уже допускает больше64members; preview/page/result top-k — не полный denominator. Реальные memory/byte bounds остаются и дают явный отказ, не скрытое усечение.

**Cloudflare AI:** native Gateway/AI Search, existing generation registry и Budget Governor сохраняются. S09 — wiring, S29/S34 — config/proof lifecycle. Большой control-plane adapter не объявляется заново написанным managed service только по числу строк.

**Rust:** S88 выбирает canonical byte envelope и wasm-bindgen byte-array shell/glue над precompiled Module. Только product exports Language§6.3, не workers-rs перепись Worker и не Rust microservice. После M6 нельзя тихо использовать более permissive TS fallback.

**Упрощение:** S28/S77 объединяют только доказанно совместимые byte/text contracts. S76 — один dev-formatter, S90 — actual build/runtime measurements вместо неверных source proxies. Никакой минификации методов, бессмысленной нарезки packages или нового численного whitelist.

**Процедурные ограничения:** S27 удаляет cap веток/dated exceptions. S90 явно обновляет source-budget правила по указанию владельца; реальные memory/security/idempotency/purge ограничения не снимаются. Более ранние формулировки про физическое число строк читать с этим уточнением.

## 4. Все99заданий

Каждый PR содержит паспорт с пятью разделами: суть, что сделать, конкретная документация/grep, способ реализации и проверяемые критерии. Ниже — ссылки на задачи, не разрешение сливать старые code branches.

### Стабилизация и интерфейсы

| ID | PR | Результат |
|---|---|---|
| S01 | [#193](https://github.com/UnknownAlienHuman/eliot-research/pull/193) | Пять package-boundary failures без wildcard. |
| S02 | [#194](https://github.com/UnknownAlienHuman/eliot-research/pull/194) | Первопричина browser failure без секретов. |
| S03 | [#195](https://github.com/UnknownAlienHuman/eliot-research/pull/195) | Actual upload/admission/reload browser regression. |
| S04 | [#196](https://github.com/UnknownAlienHuman/eliot-research/pull/196) | Project/Wiki mutations на workerd-D1. |
| S05 | [#197](https://github.com/UnknownAlienHuman/eliot-research/pull/197) | Compatible deployment continuity. |
| S06 | [#198](https://github.com/UnknownAlienHuman/eliot-research/pull/198) | История run после нового JWT. |
| S07 | [#199](https://github.com/UnknownAlienHuman/eliot-research/pull/199) | Historical report/Wiki/citation после source update. |
| S08 | [#200](https://github.com/UnknownAlienHuman/eliot-research/pull/200) | Replay bound к исходной scope expression. |
| S09 | [#201](https://github.com/UnknownAlienHuman/eliot-research/pull/201) | AI_SEARCH в RETRIEVE_BRANCHES. |
| S10 | [#202](https://github.com/UnknownAlienHuman/eliot-research/pull/202) | Project-scoped service authorizer. |
| S11 | [#203](https://github.com/UnknownAlienHuman/eliot-research/pull/203) | Machine query/run/status. |
| S12 | [#204](https://github.com/UnknownAlienHuman/eliot-research/pull/204) | Machine report/section/exact evidence. |
| S13 | [#205](https://github.com/UnknownAlienHuman/eliot-research/pull/205) | Research tools существующего MCP. |
| S14 | [#206](https://github.com/UnknownAlienHuman/eliot-research/pull/206) | Public durable cancellation. |
| S15 | [#207](https://github.com/UnknownAlienHuman/eliot-research/pull/207) | Recovery без повторной synthesis. |
| S16 | [#208](https://github.com/UnknownAlienHuman/eliot-research/pull/208) | False DO cancel и terminal race. |
| S17 | [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209) | Первичная runtime reason. |
| S18 | [#210](https://github.com/UnknownAlienHuman/eliot-research/pull/210) | Existing launch checker без blind spots. |
| S19 | [#211](https://github.com/UnknownAlienHuman/eliot-research/pull/211) | User intent/run ID после временной потери сети. |
| S20 | [#212](https://github.com/UnknownAlienHuman/eliot-research/pull/212) | Unrelated admission не закрывает report. |
| S21 | [#213](https://github.com/UnknownAlienHuman/eliot-research/pull/213) | Technical checkpoint не research procedure. |
| S22 | [#214](https://github.com/UnknownAlienHuman/eliot-research/pull/214) | Corpus counter-search до freeze. |
| S23 | [#215](https://github.com/UnknownAlienHuman/eliot-research/pull/215) | Intro fallback не релевантный hit. |
| S24 | [#216](https://github.com/UnknownAlienHuman/eliot-research/pull/216) | Многострочный research input. |
| S25 | [#217](https://github.com/UnknownAlienHuman/eliot-research/pull/217) | Wiki writer/read Unicode/reference parity. |
| S26 | [#218](https://github.com/UnknownAlienHuman/eliot-research/pull/218) | Research: источники, вопрос, ответ, цитата. |
| S27 | [#219](https://github.com/UnknownAlienHuman/eliot-research/pull/219) | Удаление branch cap/dated exceptions. |
| S28 | [#220](https://github.com/UnknownAlienHuman/eliot-research/pull/220) | Byte-compatible canonical duplicate removal. |
| S29 | [#221](https://github.com/UnknownAlienHuman/eliot-research/pull/221) | Immutable semantic config вместо env split. |
| S30 | [#222](https://github.com/UnknownAlienHuman/eliot-research/pull/222) | Registry/deployed/partial-live truth. |
| S31 | [#223](https://github.com/UnknownAlienHuman/eliot-research/pull/223) | Owner grant CRUD/API/UI, не manual SQL. |
| S32 | [#224](https://github.com/UnknownAlienHuman/eliot-research/pull/224) | Stop/Recover в PWA/MCP. |
| S33 | [#225](https://github.com/UnknownAlienHuman/eliot-research/pull/225) | Long-run authority отдельно от browser TTL. |
| S34 | [#226](https://github.com/UnknownAlienHuman/eliot-research/pull/226) | Model-proof lifecycle/credential readiness. |

### Research, источники, результаты и внешние клиенты

| ID | PR | Результат |
|---|---|---|
| S35 | [#227](https://github.com/UnknownAlienHuman/eliot-research/pull/227) | Inquiry protocol/input/acceptance contract. |
| S36 | [#228](https://github.com/UnknownAlienHuman/eliot-research/pull/228) | QuestionGraph/SourcePortfolio/HypothesisCard. |
| S37 | [#229](https://github.com/UnknownAlienHuman/eliot-research/pull/229) | Actual read/analyze/reconcile/branch scheduler. |
| S38 | [#230](https://github.com/UnknownAlienHuman/eliot-research/pull/230) | Lanes/prereg/named verifier certificates. |
| S39 | [#231](https://github.com/UnknownAlienHuman/eliot-research/pull/231) | Approved acquisition→frozen bytes→admission. |
| S40 | [#232](https://github.com/UnknownAlienHuman/eliot-research/pull/232) | Debts/next probes/disposition/explicit reopen. |
| S41 | [#233](https://github.com/UnknownAlienHuman/eliot-research/pull/233) | ASK/BRIEF и follow-up. |
| S42 | [#234](https://github.com/UnknownAlienHuman/eliot-research/pull/234) | COMPARE axes/units/conditions/cell evidence. |
| S43 | [#235](https://github.com/UnknownAlienHuman/eliot-research/pull/235) | HYPOTHESIS_REVIEW rivals/falsifiers/certificates. |
| S44 | [#236](https://github.com/UnknownAlienHuman/eliot-research/pull/236) | FACT_CHECK каждой входной claim. |
| S45 | [#237](https://github.com/UnknownAlienHuman/eliot-research/pull/237) | PROJECT_VS_LITERATURE_AUDIT. |
| S46 | [#238](https://github.com/UnknownAlienHuman/eliot-research/pull/238) | DEEP_RESEARCH над настоящими ветвями. |
| S47 | [#239](https://github.com/UnknownAlienHuman/eliot-research/pull/239) | Format quality/normalized admission. |
| S48 | [#240](https://github.com/UnknownAlienHuman/eliot-research/pull/240) | Exact DocumentMap/sections/parent-neighbors. |
| S49 | [#241](https://github.com/UnknownAlienHuman/eliot-research/pull/241) | Scoped ProjectAtlas и omissions. |
| S50 | [#242](https://github.com/UnknownAlienHuman/eliot-research/pull/242) | LOCATE/literal/structural/semantic lanes. |
| S51 | [#243](https://github.com/UnknownAlienHuman/eliot-research/pull/243) | Exhaustive denominator/shard reconciliation. |
| S52 | [#244](https://github.com/UnknownAlienHuman/eliot-research/pull/244) | Admission-fed projection/readiness/shadow/rollback. |
| S53 | [#245](https://github.com/UnknownAlienHuman/eliot-research/pull/245) | REPORT compiler/COW/verified export. |
| S54 | [#246](https://github.com/UnknownAlienHuman/eliot-research/pull/246) | Accepted publication/D0–D3 decisions. |
| S55 | [#247](https://github.com/UnknownAlienHuman/eliot-research/pull/247) | Derived dependencies/freshness/change replay. |
| S56 | [#248](https://github.com/UnknownAlienHuman/eliot-research/pull/248) | Selective EvidenceAtoms/profile semantics. |
| S57 | [#249](https://github.com/UnknownAlienHuman/eliot-research/pull/249) | Evidence-bound typed ArgumentMap. |
| S58 | [#250](https://github.com/UnknownAlienHuman/eliot-research/pull/250) | Selected Workspace candidate bytes→admission. |
| S59 | [#251](https://github.com/UnknownAlienHuman/eliot-research/pull/251) | Artifact→Google exact delivery/readback. |
| S60 | [#252](https://github.com/UnknownAlienHuman/eliot-research/pull/252) | Seven federation operations→real execution. |
| S61 | [#253](https://github.com/UnknownAlienHuman/eliot-research/pull/253) | Independent federation wire/client acceptance. |

### Сохранность, эксплуатация и интерфейс

| ID | PR | Результат |
|---|---|---|
| S62 | [#254](https://github.com/UnknownAlienHuman/eliot-research/pull/254) | Owner erasure permission/request/status. |
| S63 | [#255](https://github.com/UnknownAlienHuman/eliot-research/pull/255) | Full managed erasure closure/holds/late producers. |
| S64 | [#256](https://github.com/UnknownAlienHuman/eliot-research/pull/256) | Outbox/Queue/DLQ recovery. |
| S65 | [#257](https://github.com/UnknownAlienHuman/eliot-research/pull/257) | Coherent backup source/offsite adapter. |
| S66 | [#258](https://github.com/UnknownAlienHuman/eliot-research/pull/258) | Isolated restore, current purge before disclosure. |
| S67 | [#259](https://github.com/UnknownAlienHuman/eliot-research/pull/259) | Code/index rollback без отката данных. |
| S68 | [#260](https://github.com/UnknownAlienHuman/eliot-research/pull/260) | Bounded Steward/candidate-only feedback. |
| S69 | [#261](https://github.com/UnknownAlienHuman/eliot-research/pull/261) | Disclosure/injection/XSS/secret boundaries. |
| S70 | [#262](https://github.com/UnknownAlienHuman/eliot-research/pull/262) | Ownership/cutover/residency/unsaved snapshots. |
| S71 | [#263](https://github.com/UnknownAlienHuman/eliot-research/pull/263) | Content-free diagnostics/metrics/spend controls. |
| S72 | [#264](https://github.com/UnknownAlienHuman/eliot-research/pull/264) | Events/cursor replay/backpressure/hibernation. |
| S73 | [#265](https://github.com/UnknownAlienHuman/eliot-research/pull/265) | Library/projects/import/revision UX. |
| S74 | [#266](https://github.com/UnknownAlienHuman/eliot-research/pull/266) | Truthful model/agent/Workspace Connections. |
| S75 | [#267](https://github.com/UnknownAlienHuman/eliot-research/pull/267) | Wiki/report review/edit/publish/history UI. |
| S76 | [#268](https://github.com/UnknownAlienHuman/eliot-research/pull/268) | Dev formatter и читаемый TypeScript. |
| S77 | [#269](https://github.com/UnknownAlienHuman/eliot-research/pull/269) | Shared Unicode/length primitive, точные contracts. |

### Rust, общая приёмка и выпуск

| ID | PR | Результат |
|---|---|---|
| S78 | [#270](https://github.com/UnknownAlienHuman/eliot-research/pull/270) | Остаток M2 identity parity. |
| S79 | [#271](https://github.com/UnknownAlienHuman/eliot-research/pull/271) | Pure owner lifecycle/cutover. |
| S80 | [#272](https://github.com/UnknownAlienHuman/eliot-research/pull/272) | Pure scope algebra/currentness. |
| S81 | [#273](https://github.com/UnknownAlienHuman/eliot-research/pull/273) | Pure policy/residency/budget decisions. |
| S82 | [#274](https://github.com/UnknownAlienHuman/eliot-research/pull/274) | Pure admission/qualification и bundle verifier CLI. |
| S83 | [#275](https://github.com/UnknownAlienHuman/eliot-research/pull/275) | Pure structural projection transforms. |
| S84 | [#276](https://github.com/UnknownAlienHuman/eliot-research/pull/276) | Pure exact evidence/coverage. |
| S85 | [#277](https://github.com/UnknownAlienHuman/eliot-research/pull/277) | Pure Research/acceptance/publication. |
| S86 | [#278](https://github.com/UnknownAlienHuman/eliot-research/pull/278) | Pure erasure closure decisions. |
| S87 | [#279](https://github.com/UnknownAlienHuman/eliot-research/pull/279) | Pure federation fence/candidate mapping. |
| S88 | [#280](https://github.com/UnknownAlienHuman/eliot-research/pull/280) | Product Wasm ABI/actual Worker shadow. |
| S89 | [#281](https://github.com/UnknownAlienHuman/eliot-research/pull/281) | Per-family M6/M7 switch/removal. |
| S90 | [#282](https://github.com/UnknownAlienHuman/eliot-research/pull/282) | Measured build/runtime вместо source proxy. |
| S91 | [#283](https://github.com/UnknownAlienHuman/eliot-research/pull/283) | Все active D1 authority transactions. |
| S92 | [#284](https://github.com/UnknownAlienHuman/eliot-research/pull/284) | One-build full owner/headless local acceptance. |
| S93 | [#285](https://github.com/UnknownAlienHuman/eliot-research/pull/285) | Adjudicated T2/T3 quality corpus. |
| S94 | [#286](https://github.com/UnknownAlienHuman/eliot-research/pull/286) | Exact private staging attestation. |
| S95 | [#287](https://github.com/UnknownAlienHuman/eliot-research/pull/287) | Native T4/T5/selected-client conformance. |
| S96 | [#288](https://github.com/UnknownAlienHuman/eliot-research/pull/288) | T6 workload/overload/latency/cost. |
| S97 | [#289](https://github.com/UnknownAlienHuman/eliot-research/pull/289) | Mandatory readiness/canary/release receipt. |
| S98 | [#290](https://github.com/UnknownAlienHuman/eliot-research/pull/290) | Machine normalized ingest без browser/Google/SQL. |
| S99 | [#291](https://github.com/UnknownAlienHuman/eliot-research/pull/291) | Full Research scope/history для65/299источников. |

S78/S89 — конечный перечень family-specific checkpoints, не один массовый rewrite commit. S92–S97 агрегируют приёмку уже выполненных компонентов, а не реализуют их второй раз. Предлагаемые новые routes/DTO в паспортах обозначены как работа к созданию; это не утверждение, что такие endpoints уже работают.

## 5. Полное покрытие объединённого аудита F01–F26

Исходный загруженный файл: `eliot-research-consolidated-audit-2026-09-14.md`, SHA256 `9460d84cb0da21a6ab4553dc573e79652c532da749532fbb1db9176f5359fad5`. Он не автоматически существует в репозитории; ниже его явное соответствие заданиям.

| Finding | Что закрываем | Задания |
|---|---|---|
| F01 | Deployment как глобальный допуск к старым runs | S05/S67 |
| F02 | JWT rotation смешана с владельцем | S06/S33 |
| F03 | Historical-read fix не прошёл live acceptance | S07/S92/S95 |
| F04 | Потерян AI Search binding | S09 |
| F05 | Replay не сравнивает новую scope expression | S08 |
| F06 | Technical stages вместо требуемых процедур | S21/S22/S35–S46 |
| F07 | Intro fallback и неверное coverage | S23/S50–S52/S93 |
| F08 | Input/scope ограничения | S24/S99 |
| F09 | HTTP/PWA не равны service rights | S10–S13/S31/S32/S58/S60/S61/S98 |
| F10 | Public run lifecycle | S14/S15/S32 |
| F11 | Uniform retries=0 | S15/S64/S95 |
| F12 | False cancel и возможная DO race | S16/S72 |
| F13 | Потеря причины ошибки | S02/S17/S71 |
| F14 | node:sqlite не доказывает D1 | S04/S91 |
| F15 | SQL/TS predicate mismatch; writer reachability | S25/S77/S91 |
| F16 | SQL complexity без снятия atomic protection | S04/S91, pure decisions S79–S87 |
| F17 | Offline/health сбрасывает intent | S19/S72 |
| F18 | Unrelated admission закрывает report | S20/S55 |
| F19 | Console-oriented UX | S26/S73–S75 |
| F20 | Main CI не полностью зелёный | S01–S04/S76/S90–S92 |
| F21 | Launch checker blind spots | S18/S94/S97 |
| F22 | Registry/deployed/частный live смешаны | S30/S97 |
| F23 | Canonical JSON/text duplicates | S28/S77/S78/S89 |
| F24 | Long lines/source budgets | S76/S90 |
| F25 | AI config/routes/renewal эксплуатационная сложность | S29/S34/S71/S95 |
| F26 | Rust не включён в runtime | S78–S89 и прежний mutation debt #176 |

Каждой из26находок назначена реализация/проверка; это не статус FIXED. F12 race и F15 normal-writer exploit не повышены до доказанных live-инцидентов: сначала воспроизвести достижимый путь. Полная готовность дополнительно требует канонических задач, которых в узком дефектном аудите могло не быть.

## 6. Claude/Antigravity: сохранённые и снятые выводы

Входной `audit-2026-09-14.md`, SHA256 `230bd4c9cb762cf044db1c0ef7ced49b07837fec71f1e95ce557b337374e72e6`; [репозиторная версия аудита](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/audit-2026-09-14.md).

| Группа | Как учтена |
|---|---|
| AUTH-01/02/03 | S05/S06/S33/S34. Новый JWT сам не удаляет DB-строку. Browser TTL, execution grant, модельные proofs и deployment compatibility разделены. |
| D1-TEST/LIMIT-01, D1-AUTH-01/02 | S04/S25/S91. Локальный workerd-D1 depth100; node:sqlite1000 не его эквивалент. Слабый SQL predicate не доказывает normal-API exploit при существующей validation writer. |
| CI-01/GATE-01 | S01–S04/S18/S90–S97. Не создавать вторую систему гейтов, проверять реальные outcomes. |
| DUP-01/OVR-05/RT-01 | S28/S76–S78/S89/S90. Имена не доказывают equivalent bytes; source не bundle. |
| RT-02/CONF-DR/AI-03 | S29/S34/S71. Упрощать фактический lifecycle/overhead, не удалять Gateway adapters по LOC. |
| PIPE-DO-01/PIPE-CFG-01 | S16/S72/S94. Actual callers/bindings; DO не объявляется единственным входом run. Простой reread перед неатомарным save не исправляет race. |
| FRONT-UI/03/04/05 | S26/S73–S75/S92. Простой пользовательский цикл плюс сохранённые security negatives; unused legacy routes не активируются автоматически. |
| OVR-04 | Ограниченные изменения current main с before/after regression, не бесконечное усложнение. |
| CONF-03 | S78–S89: завершить обязательную language migration, не отменить молча. |
| CONF-04 | S30/S97: проверять поведение, не существование файлов. |
| OVR-01/общие codec/error/LOC counts | Не приказ удалить код. Actual definitions/callers и измеренная семантическая избыточность — S28/S77/S90. |

**Не переносить в задания опровергнутые тезисы:** Budget Governor и AI Search generation registry предусмотрены каноном; model qualification в двух слоях не два независимых engines; INCOMPLETE_COVERAGE с sampled denominator не дефект; W2 run и W3 model IDs различаются законно; отсутствие tests в собственной папке не отсутствие любых tests; исторический SQLITE_NOMEM не нынешняя причина CI. Missing secret в Git не доказательство отсутствия в deployment. `workers.dev` допустим, прямой main — решение владельца. Нет приказа удалить35–40тыс.строк по ошибочному grep-счётчику.

Уточнение этой повторной проверки: [generic scope-service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-navigation/src/scope-service.ts) уже рассчитан на более крупный member set. S99 устраняет owner/ORIENT/historical bottleneck64, а не строит вторую базу scopes.

## 7. Покрытие обязательного канона

| Требование | Задания | Проверяемый результат |
|---|---|---|
| Foundation/authority/один Worker | S01/S05/S10/S27/S33/S69/S70/S90/S94 | Правильные identities/currentness/resource bindings. |
| Ingest/quality/residency | S39/S47/S70/S82/S98 | Реальные admitted revisions/bytes/outbox; candidates не context. |
| Retrieval/AI Search/exact/exhaustive | S08/S09/S23/S48/S50–S52/S84/S99 | Authorized full scope, active generation и exact evidence. |
| Corpus Lens/Atlas | S36/S48/S49/S56/S57/S73 | Maps/omissions и понятная навигация без synthetic citation authority. |
| Governed Research | S21/S22/S35–S46/S53/S85 | Protocol/obligations/lanes/verifier/freeze/debts/disposition. |
| Artifact/Wiki/distillation | S07/S25/S53–S57/S75 | COW, risk-tier review, exact accepted support/dependencies. |
| HTTP/MCP/federation | S10–S15/S31/S32/S60/S61/S72/S98 | Реально подключаемый scoped клиент без browser JWT/manual SQL. |
| Selected Google Workspace | S58/S59/S74 | External action/bytes/readback, не вера receipt от клиента. |
| Budget/model lifecycle | S15/S29/S33/S34/S71/S81 | Lawful costs/renewal/UNKNOWN, без повторной оплаты завершённых стадий. |
| Security/disclosure/injection | S10/S25/S69/S70/S81/S95 | No forbidden disclosure/effects, no authority from prose. |
| Queue/DO/Workflow failure | S14–S17/S32/S64/S72/S95 | Durable cancel/replay/hibernation, no unbounded buffers. |
| Erasure/retention/backup/restore/exit | S55/S62–S67/S86/S95 | Full managed closure, purge-first restore, approved offsite/rollback. |
| Steward/operational diagnostics | S17/S68/S71/S74 | Content-free findings, candidate-only changes, no mutation loops. |
| Rust M1–M7/native verifier | S78–S89, existing K1/K2a/#176 | Real ABI/caller promotion/removal, не CI-only kernel. |
| Combined UX/quality/performance | S26/S73–S76/S90/S92–S96 | Integrated local, adjudicated corpus, native conformance и T6. |
| Production declaration | S30/S97 | Complete existing readiness receipt и одобренный canary head. |

Быстрые подтверждённые ориентиры для grep:

```sh
git grep -n -F '## 7.5. SourcePortfolio and coverage denominator' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 6. TypeScript ↔ Rust/Wasm ABI' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
git grep -n -F '## 7. SQL authority contract' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
git grep -n -F 'K6 — controlled per-family Rust promotion.' -- docs/implementation/launch-prs/09-rust.md
git grep -n -F '## 16. Phase 14 — production launch' -- docs/implementation/production-readiness-plan.md
```

## 8. Исполнение и прекращение новых архитектурных догадок

Агент читает индекс, конкретный паспорт, названный canonical section и фактических callers **текущего** main. Пинa2 — проверенная исходная база, не приказ откатывать код. Готовые source/backup/identity/admission механизмы не переписываются; извлекается отсутствующий delta. Старые Launch PR#90–#98 — тематическая история, не разрешение wholesale merge устаревших code trees. #176 сохраняет собственный mutation debt.

Цикл: именованный failing case → узкое изменение существующего пути → positive/negative/replay actual-boundary tests → readback state/bytes/IDs → exact commit/результат в PR. Shared schema/interface изменения проверяют callers и миграцию одновременно. Helper/compile-only/новый файл не завершают пользовательский outcome. Более широкий интеграционный тест не заменяет узкий регрессионный тест исправления.

При противоречии паспортов применяется канон и конкретное исправленное решение, а сами паспорта обновляются согласованно. Установленные уточнения: S15 разрешает первый audit после recovery; S90 меняет неверные процедурные source proxies, не resource/security bounds; S74 не включает legacy Google OAuth; S99 различает larger scope и preview64. Нельзя отдельно придумать разные cancel/recover DTO для PWA и MCP или разные grant stores для HTTP и Workspace.

После двух одинаковых неуспешных подходов сохранить exact failure/observed state, найти первопричину и сменить проверяемую стратегию. Не делать бесконечный unchanged retry, не добавлять очередной framework/logger/registry/квоту. Новый дефект привязывается к owning задаче с regression; необходимость фикса не изображается доказательством полной переписи.

## 9. Внешние параметры только там, где они объективно нужны

| Вход | Применимость |
|---|---|
| Approved account/resources/hostname/jurisdiction/disposable target/budget | S94–S96, не local code. |
| Valid Access/service identities и model Run/Read secrets | S31/S34/S74/S94; значения не в Git/chat/PWA/receipts. |
| Авторизованный selected Google client/action/target | S58/S59/S95; собственный OAuth server не изобретается. |
| Approved offsite destination с независимым failure domain и retention/delete policy | S65/S66; controlled local destination не live proof. |
| Independent federation peer либо согласованный disposable wire client/identity | S61/S95. |
| Release-owner approval после canary | S97; модель не объявляет себя release approver. |

Отсутствие одного такого входа локализуется в соответствующем live-case, не блокирует написание остальных компонентов и не разрешает fake receipt. Не обещается удалить неконтролируемые ранее скачанные копии или измерить месячный счёт до наступления месяца.

## 10. Проверка качества самого плана и конечный результат

Повторно сопоставлены оба аудита, PR-описания, канонические разделы и конкретные исходники ключевых разрывов. GitHub подтвердил99открытых новых PR, последнийS99/#291. Декларативная карта проверена:99уникальных task IDs, соответствие#193–#291, всеF01–F26 связаны с задачами, граф указанных технических зависимостей без цикла. Перепроверены важные grep anchors, включая Rust K2/K3/K4/K6. Исправлена неверная ссылка S76 на S77 вместо budget S90.

Это **проверка плана**, не запуск software tests и не гарантия отсутствия будущих дефектов. Невоспроизведённые риски сохраняют статус и требуют actual reachability test. Агенту больше не нужно самостоятельно составлять план завершения и выбирать новый стек; он обязан читать меняющийся код, реализовывать named delta и доказывать результат, а не слепо копировать псевдокод.

**Готовность достигнута, когда:** обязательные code paths выбранного v1 собраны в одном main; ошибки аудита закрыты реальными исправлениями; language/data/security/runtime guarantees подтверждены; применимые T0–T6 и canary прошли по S97. Не когда написано99Markdown-файлов, не когда на экране READY и не когда несколько дней идут коммиты.
