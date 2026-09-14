# S58 — выбранный Workspace/Drive client передаёт реальные bytes в Eliot

База a2aca127; ER-36/37/21/24. Перечитан workspace-candidate-admission.ts: plan/observation/capture binding и owner authorization уже реализованы. Сначала воспользоваться этим кодом; не создавать второй importer.

## 1. Суть
MCP tools/list и valid Google receipt не доказывают получение файла или canonical admission. Полный выбранный gemini-mcp client round trip ещё не квалифицирован.

## 2. Что сделать
Связать actual selected-client Drive export/read→existing v2 plan/observation→raw immutable capture/conversion→`/api/v1/workspace/admission`→SourceRevision/readiness. Добавить недостающий пользовательский/agent transport adapter и тесты реальных байтов; receipt-only без capture не принимается.

## 3. Документация / grep
[ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md), [existing service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/workspace-candidate-admission.ts).
```sh
git grep -n -F 'does not receive Google credentials' -- docs/adr/0006-google-external-transport-profiles.md
```

## 4. Как сделать
Google I/O выполняет отдельно подключённый официальный connector выбранного клиента. Eliot не получает Google OAuth secrets, не создаёт Google Cloud/Vertex/custom OAuth и не вызывает Google API от имени выдуманного owner. Current WorkspaceOwnerAuthorization и legacy logical gemini-spark transport identity сохраняются согласно ADR; verified actor для Research delegation #202 — отдельная внутренняя identity, не переписывание старых observations.

Owner-authorized import уже существует. Для service-initiated submission разрешить только явно выданное `workspace.admit` действие (additive operation в #202/#223) вместе с current namespace admission policy и existing Workspace owner binding; передавать typed authorized admission context, не forged owner_pwa. Один actor не импортирует чужой capture/observation. Payload bytes/hash/revision проверяются independently, caller receipt остаётся candidate observation. Refresh/reauth/readback same IDs, UNKNOWN action outcome не означает повтор Google создания. Импорт не требует полной Research engine готовности.

## 5. Критерии выполнения
Один фактически экспортированный файл через выбранный client даёт matching capture hash и один admitted source/outbox; duplicate/lost response/restart converge. Altered receipt/bytes/parent/actor, expired grant, cross-principal substitution отказаны. No Google keys in Worker/Git/PWA. Local exact HTTP/D1/R2/provider-control proof отдельно от реальных Antigravity и Spark action/readback receipts; successful connector action alone не LIVE_QUALIFIED.
