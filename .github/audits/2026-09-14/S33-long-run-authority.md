# S33 — длительный run переживает короткую сессию, но не отзыв прав

База a2aca127; ER-09/13/24/30. Дополняет #197/#198, не повторяет historical read fix.

## 1. Суть
ScopeService по умолчанию выдаёт snapshot на15 минут; W2 current view требует неистёкшие snapshot/grant. Продление модельного proof не продлевает эти права. История после нового JWT и продолжение активной операции — разные задачи.

## 2. Что сделать
При запуске зафиксировать operation-bound execution authorization с дедлайном из уже разрешённых policy/delegation/budget, отдельно от bearer lifetime вкладки. Короткий snapshot служит неизменяемой provenance; повторная проверка права на ту же frozen member set не должна перефризить текущие heads. Реальное истечение upstream policy или explicit revoke останавливает dispatch и оставляет возобновляемую/ограниченную работу, не скрывает run.

## 3. Документация / grep
[Канон §7, §7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [held scope](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/workflow-checkpoints.md).
```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'loadHeldResearchScope' -- apps/eliotr-core/src packages/cloudflare-research/src
```

## 4. Как сделать
Использовать existing scope_access_grant/W1 authorization receipt и held-scope loader, не новый session/token service. Разделить проверки read bearer и server-execution grant: stage не хранит browser JWT. Для обновлённого execution grant требуется та же operation/principal/frozen source revisions/disclosure и current upstream policy; старые snapshot/receipt hashes не переписывать. Original revoked grant, purge или cutover нельзя обойти новым grant. Пока policy действительна — narrow renewal той же операции; policy истекла/изменена — явное owner reauthorization по существующей namespace/delegation процедуре, затем #207 сверяет сохранённые checkpoints. Нельзя silently увеличить policy scope/TTL, принять новые source heads или повторить model stage.

Изменения current view и loader согласовать с #197; не создавать два альтернативных SQL view. Migration additive и readback-old/new tests. Передача run другому агенту возможна только через явное делегирование, не по знанию operation ID.

## 5. Критерии выполнения
- Run проходит границу короткого snapshot/JWT TTL при ещё действительном operation authorization, с теми же frozen IDs/hashes и без открытой вкладки.
- Policy/delegation expiry, revoke, purge, cutover и отмена на следующей dispatch останавливают эффекты; исторические результаты сохраняются там, где чтение ещё разрешено.
- Законное повторное разрешение и recovery продолжают тот же run; revoked не восстанавливается случайно.
- Для границ времени использовать короткие контролируемые fixtures и реальные D1 predicates, не только подмену JS Date; исходные SQL expiry guards доказанно проверены.
- Exact SHA, positive/negative HTTP/Workflow/D1/R2 tests и отдельный live long-run сценарий в финальной приёмке.
