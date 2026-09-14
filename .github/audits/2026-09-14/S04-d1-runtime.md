# S04 — проверять Project/Wiki SQL в D1, а не только в node:sqlite

База `a2aca127`; F14/F16. Самостоятельная задача, не массовая миграция всех тестов.

## 1. Суть
Project update и Wiki edit уже упирались в глубину SQL-выражений на реальном D1. Успех node:sqlite не подтверждает совместимость с workerd/D1. Сам локальный D1 воспроизводит ограничение; проблема не требует production для обнаружения.

## 2. Что сделать
Добавить runtime-регрессию для двух реально падевших операций: обновление проекта с memberships и сохранение Wiki owner edit. Выполнять настоящие migration chain и emitted SQL через существующую Workers Vitest-конфигурацию.

## 3. Документация
[Языковой контракт §3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), строка `D1 queries and transaction orchestration`.
[Execution contract §4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md), `D1/R2/runtime, crypto, transactions`.
```sh
git grep -n -F 'Expression tree too large' -- docs/implementation
git grep -n -F 'D1 queries and transaction orchestration' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```

## 4. Как сделать
Использовать текущие `apps/eliotr-core/test`, project-owner service и Wiki edit service. Не копировать SQL из приложения в тест: вызывать реальный сервис. Подготовить минимальный валидный fixture через существующие helpers; выполнить insert/update, прочитать head/receipt/outbox. Показать откат при stale CAS. Отдельный маленький SQL negative должен подтвердить, что тест реально использует D1, а не более терпимый SQLite. Чистые unit-тесты оставить быстрыми; не устанавливать второй test framework.

## 5. Критерии выполнения
- Обе операции компилируются и исполняются под workerd с текущими миграциями.
- Negative stale-head сохраняет прежние данные, без частичных изменений/outbox.
- Тест выявляет превышение поддерживаемой D1 глубины до deployment.
- В CI исполняются эти тесты; node:sqlite не выдаётся за D1-приёмку.
- Приложены команды, exact SHA, before/after; cloud deployment не нужен.
