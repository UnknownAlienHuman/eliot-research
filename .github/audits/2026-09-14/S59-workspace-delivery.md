# S59 — отдать готовый artifact в Google и сверить ту же копию

База a2aca127; ER-11/36/24; existing export/Workspace plan-observation, canonical REPORT #245/#246. Selected gemini-mcp, не legacy drive-exchange.

## 1. Суть
Рабочий импорт из Google не закрывает обратную доставку результата. Ошибка Google не должна уничтожать canonical artifact или запускать исследование повторно.

## 2. Что сделать
Canonical artifact ref→authorized deterministic export→existing candidate sync plan→official selected-client Drive/Docs write→exact read/export-back→delivery observation/reconciliation. Target ID/parent, artifact revision/hash и idempotency identity закреплены до write. Добавить Copy to Google в существующий result UI, не новый publishing backend.

## 3. Документация / grep
[ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md), [канон §9.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'A future authenticated ELIOT admission/reconciliation contract' -- docs/adr/0006-google-external-transport-profiles.md
```

## 4. Как сделать
Server читает только разрешённую artifact revision, сохраняет DRAFT/accepted labels/limitations и export lineage; Google action выполняет отдельно connected client. Authenticated caller observation не становится доказательством действия сама по себе: status exact-readback наблюдения допустим только в границах реально квалифицированного connector пути. Lost create ACK сначала reconcile по прежнему intended target/action identity, не создавать новый Doc. Content/parent/revision mismatch — conflict/unknown, original artifact доступен. Permission/reauth/Drive outage вынести в delivery state, не Research state. Registered external copy входит в dependency/erasure inventory #247; приватные источники не экспортируются сверх allowed disclosure. Крупный файл передавать bounded file/handle path, не base64 JSON.

## 5. Критерии выполнения
Artifact text/hash/status matches exact Google readback; wrong parent, modified copy, duplicate/lost ACK/restart и revoked disclosure не создают ложный DELIVERED/дубликат. Google unavailable оставляет canonical report/citations доступными. Нет Google secrets в Worker, нет custom OAuth/Google Cloud requirement. Local transport tests и реальные выбранные client/connector receipts разделены; неизвестный внешний результат честно UNKNOWN, exact SHA.
