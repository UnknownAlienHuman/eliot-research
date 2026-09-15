# S69 — проверить реальную цепочку disclosure и prompt injection

База a2aca127; ER-03/17/24. Это интеграция существующего evaluator/firewall, не новый security framework. Выполнять после появления соответствующего caller; не объявлять отсутствие уязвимостей по одним unit tests.

## 1. Суть
Право человека читать документ не даёт права раскрывать его любой модели/агенту. Source/model text не может назначать tools, verifier, grant, callback URL или публикацию.

## 2. Что сделать
Проследить policy order и taint от admitted bytes через retrieval/EvidencePack/AllowedReferenceManifest до model dispatch, artifact и API/MCP/Google/federation disclosure. Закрыть реальные missing checks и сохранить отрицательные fixtures на actual caller chain.

## 3. Документация / grep
[ER-03](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md), `## Required implementation`/`## Mandatory negative boundary`.
```sh
git grep -n -F 'Permission to view never implies model/client disclosure.' -- docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md
```

## 4. Как сделать
Использовать `packages/policy`, HTTP/MCP verified actor и existing context/output compiler. Матрица: viewer allowed/model denied; model allowed/client denied; revoked during read; untrusted text requests erase/publish/secret exfiltration; provider invents handle/tool/URL; forged audience/principal/Origin/cookie; unsafe redirect/private destination в acquisition S39. Проверять before/after external work, не только UI visibility. Запретить side-effect tools в generation surface, но сохранить явно авторизованные owner operations вне generation. Body/HTML/Markdown отображать без выполнения script/unsafe links. Content-free telemetry: token/cookie/source/model body не появляются в log/cause/metrics. Использовать существующие dependency/secret/license checks, точный результат классифицировать, не скрывать исключением папки.

## 5. Критерии выполнения
- Все матричные запреты дают отсутствие запрещённых network/provider/D1 effects и утечек; допустимый владелец/агент всё ещё работают.
- Source instructions не меняют manifest/tools/verifier/policy; model-created citation не accepted; XSS не исполняется в PWA.
- Currentness revoke во время stream/output отражён; разрешение чтения не становится declassification.
- Негативы исполняют настоящие application services и D1/R2 с контролируемыми внешними границами; для публичной security декларации отдельно требуется T5 на выбранной платформе. Exact SHA, threat matrix и результаты прилагаются.
