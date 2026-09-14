# S34 — завершить renewal уже существующих model proofs

База a2aca127; ER-16/24/26. Реализация renewal уже есть; не писать её повторно. Source: текущий gap-register и research-runtime-configuration.

## 1. Суть
Сохранённые owner runs работали, но automatic qualification renewal не принят на Worker без ELIOTR_MODEL_GATEWAY_READ_TOKEN. Model proof expiry, pricing/policy expiry, browser JWT и deployment — разные причины. Новый финансовый контур владельцем отложен.

## 2. Что сделать
Закрыть существующую цепочку readiness→lazy renewal→route exact readback→new proof→first model dispatch. Проверить корректную установку отдельно Run и Read credentials через текущий runtime/deploy tooling и диагностику missing/forbidden/revoked credentials.

## 3. Документация / grep
[Канон §8.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [Runtime configuration](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/research-runtime-configuration.md).
```sh
git grep -n -F '## 8.5. Generation change gate' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'ELIOTR_MODEL_GATEWAY_READ_TOKEN' -- docs/implementation/research-runtime-configuration.md apps/eliotr-core/src
```

## 4. Как сделать
Использовать research-owner-qualification-renewal/research-model-qualification-renewal и установленный native Dynamic Route. Concurrent first runs должны делить один renewal по route/config identity, без повторной qualification модели на каждом status GET или login. Готовый proof привязать к фактическому model/prompt/schema; иной model не наследует proof. Missing Read token — понятное действие настройки, не скрытый fallback и не попытка сделать токен через account admin из приложения. Если upstream effect UNKNOWN, reconcile existing attempt. Pricing/policy не продлевать через model-proof renewal. Saved evidence/report read не блокировать отсутствием новых model credentials. Secrets не помещать в план/R2/Git.

## 5. Критерии выполнения
Fresh proof→0 renewal calls; expiry→ровно один разрешённый renewal при concurrent runs; same-key replay→тот же proof. Read401/403/revoked, changed route, UNKNOWN и expired policy различаются и не вызывают слепых платных повторов. Сохраняется чтение старого отчёта. Доказать local controlled provider+D1, затем отдельный разрешённый реальный round trip, без заявления live-success заранее. Exact SHA, calls по каждому operation kind и receipts без секретов.
