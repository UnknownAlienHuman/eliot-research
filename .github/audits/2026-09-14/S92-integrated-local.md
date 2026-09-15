# S92 — единая local product acceptance на итоговом main

База a2aca127; ER-27/25/24/00. Не новый harness: использовать существующий Playwright/core local runtime и independent fetch/MCP client. Выполняется после интеграции необходимых product paths, не вместо их unit/regression tests.

## 1. Суть
Сумма зелёных отдельных helpers не доказывает, что источник, проект, права, поиск, исследование, отчёт и цитата работают вместе. Старая browser инфраструктура не должна быть единственным критерием удобства.

## 2. Что сделать
Разбить existing owner-e2e на короткие сценарные модули с общей prepare/cleanup и сохранить нужные security negatives. Один aggregate запускает человеческий и машинный пути на одном точном build/config/schema: empty setup→source→project→query/run→report→citation→edit/publish→history→revoke/purge.

## 3. Документация / grep
[Execution contract§4–5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F 'D1/R2/runtime, crypto, transactions' -- docs/implementation/launch-prs/execution-contract.md
```

## 4. Как сделать
Only external IdP/provider responses контролируются, application HTTP/D1/R2/Queue/DO/Wasm реальны. Owner выдаёт клиенту grant через API, не INSERT готовой authority в D1. Проверить initial source intake и revision/readiness, ASK/COMPARE/FACT_CHECK/DEEP/REPORT выбранными fixtures, actual citations, Workspace candidate/delivery и federation adapters по их local contracts. Параллельно owner/agent видят только разрешённые данные. В сценарии сделать refresh JWT, compatible deployment, source update, offline/reconnect, cancel и transient recovery. Native platform-specific hibernation/provider settlement не подменять local успехом: это S95. У каждого сценария собственные expected durable IDs/effects/digests, phase labels и safe failure context; нет широких catch-success/skip/таймаутов для маскировки. Один scenario file не содержит всё в тысячах строк.

## 5. Критерии выполнения
- Реальные owner UI и independent headless client завершают маршруты без SQL/manual browser credential подстановки; совпадают разрешённые artifact/citation hashes и dispositions.
- Reload/replay/recovery не дублируют upload/run/платные завершённые этапы; lawful последующий AUDIT учитывается отдельно от дубля.
- Revoke/purge/foreign scopes/late replies/corrupt outputs не раскрываются, исторические v1/v2 читаются правильно при допустимых правах.
- Frozen install, check:affected, strict fixtures/typecheck, build/types/dry-run, local-owner/local-smoke и оба Linux/Windows browser jobs проходят на итоговом exact SHA. Existing unrelated failure остаётся блокером агрегатной приёмки, не ложным PASS.
