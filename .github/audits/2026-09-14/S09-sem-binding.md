# S09 — передать AI Search в Research Workflow

База `a2aca127`; F04. Это небольшой wiring-fix, не новая поисковая система.

## 1. Суть
Внутренний RETRIEVE_BRANCHES передаёт CORE_DB/SEARCH_DB/EVIDENCE_BUCKET, теряя AI_SEARCH. В `research-retrieval-composition.ts` undefined binding приводит к `sem = null`. Отдельный query endpoint и наличие адаптера не доказывают SEM внутри research.run.

## 2. Что сделать
Провести существующий AI_SEARCH binding по всей цепочке stage dependencies до `retrieveWithHeldScope`. Сохранить явный degraded-path при его отсутствии/сбое.

## 3. Документация
[Канон DEC-003, §6.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'ERC24-DEC-003' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 6.12. Retrieval trace' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'retrieveWithHeldScope' -- apps/eliotr-core/src
```

## 4. Как сделать
Проверить типы/сборку в `research-retrieve-branches.ts`, `research-stage-handlers.ts`, `research-semantic-server.ts` и `research-retrieval-composition.ts`. Не обходить registry generation и Evidence resolver. Тест запускать через ту же factory, что Worker Workflow; injected managed response допустим, but storage/scope/resolution реальны. Контрольный релевантный фрагмент должен находиться только SEM-путём, а не в начале файла или по lexical совпадению.

## 5. Критерии выполнения
- Research stage действительно вызывает существующий managed adapter.
- SEM-only locator разрешается в точные авторизованные R2 bytes и отражён в trace.
- Binding absent/outage не маскируется под успешный semantic поиск; exact/lex сохраняют предусмотренное поведение.
- Чужие, stale и purged SEM hits не входят в evidence.
- Replay не повторяет уже сохранённый результат; tests и exact SHA приложены. Live-quality score из controlled fixture не выводится.
