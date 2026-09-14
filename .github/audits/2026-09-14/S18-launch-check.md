# S18 — исправить слепые зоны существующего launch:code

База `a2aca127`; F21. Не добавлять новый gate или новый реестр готовности.

## 1. Суть
`check-launch-code.mjs` ищет unavailable(...) и disabled_slices. `partial_slices` и условный disabledFederationApi/denied(...) не описываются полно. Число найденных блокеров не равно всем незавершённым операциям.

## 2. Что сделать
Согласовать существующие capabilities, implementation registry и launch checker по обязательным операциям выбранного release profile. Проверять поведение композиции, а не имя helper-функции.

## 3. Документация
[Production readiness §0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md), [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md).
```sh
git grep -n -F '### Mechanical release rule' -- docs/implementation/production-readiness-plan.md
git grep -n -F 'partial_slices' -- apps/eliotr-core/src/composition-root.ts
git grep -n -F 'launchCodeBlockers' -- scripts
```

## 4. Как сделать
Из существующих declarations получать missing/partial операции и config requirements. Проверить отсутствующую и полную federation-конфигурацию в fixture; не выводить отсутствие production secret из его отсутствия в Git. Разделить code-complete, configured и live-qualified. Partial не всегда означает полную неработоспособность, но не должен означать complete. Не блокировать gemini-mcp невыбранным legacy Drive OAuth. Имя unavailable/denied не должно влиять на результат.

## 5. Критерии выполнения
- Negative partial WIKI/FEDERATION и отсутствующий обязательный handler выявляются.
- Переименование helper не меняет заключение.
- Полная тестовая композиция проходит code check без требования ещё невозможных live receipts.
- Невыбранные интеграции не становятся обязательными.
- Используется прежняя команда/реестр, без второй системы статусов; tests/SHA приложены.
