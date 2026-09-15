# S68 — закончить Research Steward без автономной порчи данных

База a2aca127; ER-33/24. Использовать `packages/research/src/steward.ts`, existing scheduled handler и observability; не писать нового долговечного агента.

## 1. Суть
Система должна сама обнаруживать stale dependencies, застрявший outbox, несогласованные hashes и просроченный purge, но Steward не должен бесконечно переписывать документы или сам выдавать себе разрешения.

## 2. Что сделать
Подключить детерминированные checks из ER-33 к bounded scheduled pass и owner-visible findings. Семантический revalidation/QueryHint — только candidate по явному trigger с verifier и Golden replay перед policy promotion.

## 3. Документация / grep
[ER-33 §Required implementation, Acceptance](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-33-research-steward.md).
```sh
git grep -n -F 'Turn retrieval feedback into versioned QueryHint/policy generation followed by Golden replay.' -- docs/agent-work/ER-33-research-steward.md
```

## 4. Как сделать
Каждый pass читает ограниченную страницу current hashes/readiness/handles/watermarks/outbox/DLQ/backup/purge/route/usage и сохраняет cursor/findings по existing operation identity. Не сканировать весь corpus в одной Worker invocation. Повтор одного trigger не вызывает модель вновь; отсутствие изменений не генерирует «улучшения». Версии hints/policy меняются через текущий policy/verifier path, не напрямую Steward-ом. Issue erasure эскалируется в существующий операторский путь, не hard-delete. Наблюдение недоступной зависимости — unknown/degraded, не healthy и не автоматическая permission mutation.

## 5. Критерии выполнения
- Stale Wiki fixture даёт revalidation candidate с точной зависимостью/trigger/owner, но не новый published head; unchanged pass выполняет ноль semantic calls.
- Outbox/DLQ/backup/purge/route failures видны в owner diagnostics; повтор/restart не дублирует findings/effects.
- Embedded instruction не меняет scope/tools/policy; Steward не публикует D2/D3, не hard-delete и не расширяет grant.
- QueryHint не активируется до Golden comparison, отрицательный replay сохраняет прежнюю policy generation. Actual scheduled/D1 tests и exact SHA приложены.
