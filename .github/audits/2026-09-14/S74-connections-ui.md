# S74 — Connections для реально выбранного профиля

База a2aca127; ER-25/36. Выбран gemini-mcp. Переиспользовать grant UI S31/#223, MCP tools #205, Workspace #250/#251, proof readiness #226 и diagnostics #263.

## 1. Суть
«MCP подключён», «модель готова», «есть право на проект» и «Google action проверен» — разные состояния. Простое перечисление неиспользуемых URL в аудите не означает, что надо включить legacy OAuth в выбранном Workspace-профиле.

## 2. Что сделать
Один экран Connections показывает отдельные карточки: сервер; модель/маршрут; конкретный agent principal и project grant; выбранный Workspace transport и последняя реально выполненная action/readback. Дать правильное действие исправления для каждого отказа, без принудительного копирования огромной инструкции в чат.

## 3. Документация / grep
[Канон: Profile applicability](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md).
```sh
git grep -n -F '## Profile applicability — ADR-0006' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Использовать existing health/capabilities/client diagnostic/model-readiness API и S31 grant CRUD. Проверка связи не оплачивает qualification и не помечает Google readback пройденным. Refresh/read/authorize/revoke имеют разные подписи. В gemini-mcp ERC revoke отменяет только ERC grant; отзыв Google consent выполняется в реально владеющем им external client, нельзя показывать ложное «Google отключён». В невыбранном drive-exchange не создавать OAuth project/client и не вызывать его endpoints. Для missing Run/Read secret показывать имя требуемого параметра и назначение, никогда значение. Технические schema/generation/proof details доступны здесь, не загромождают Research.

## 5. Критерии выполнения
- Настроенный агент проходит scoped check; неправильный actor/project не получает зелёный статус. Результат содержит наблюдённое время и проверенную операцию.
- Expired proof, missing credential, revoked grant, unconfigured transport и external OAuth failure различимы; чтение сохранённых отчётов остаётся доступным при допустимых правах.
- Revoke перестаёт разрешать ERC calls, не заявляет отзыва чужой OAuth-сессии; reconnect не создаёт второй backend/transport.
- Selected/unselected profile fixtures, accessible controls, desktop/mobile screenshots и actual HTTP/browser tests; ни секретов, ни лишних paid checks.
