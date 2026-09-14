# S55 — source changes/erasure доходят до Wiki, sections и governed exports

База a2aca127; ER-11/12/13/28. Existing change producers0060–0066 и historical readers уже есть. #212 UI invalidation и #199 historical reads не заменяют полный dependency lifecycle.

## 1. Суть
Новый source head, отзыв и erasure имеют разные последствия. Нельзя либо стереть всё при любом update, либо продолжить использовать удалённые evidence в производных объектах.

## 2. Что сделать
Замкнуть existing ArtifactDependencyManifest/section/Wiki/evidence-map связи с source/handle/derived artifact/governed export refs. Atomic change producers для недостающих events, authorized replay feed и targeted stale/redacted handling. Подключить WIKI/ARTIFACT retrieval lanes к этим проверенным readers после #246, не к произвольному тексту drafts.

## 3. Документация / grep
[Канон §9.2–9.6/§19.6/§19.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'ArtifactDependencyManifest' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 19.9. Erasure' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Dependency capture при canonical mutation, не позже best effort; normal head+outbox остаётся atomic. Source update помечает зависимые sections stale, сохраняя разрешённую историческую revision; purge/revoke требует redaction/denial и erasure inventory. Не считать новый read grant разрешением resurrection. Feed cursor привязан к principal/project/snapshot/revision; replay dedup, expired cursor→явный resync, не ложный пустой success. WIKI/ARTIFACT lane проверяет accepted/reviewed state, precise labels и original lineage: derived report не становится независимым первичным source из-за самоперецитирования. Network/provider copies ведутся existing export contracts, не обещать физическое удаление неуправляемых скачиваний пользователя.

## 5. Критерии выполнения
A→Wiki→report→export цепь получает targeted stale на source update и запрещённый/redacted доступ при purge, включая source только в omissions. Unrelated project не затронут. Lost change notification/restart восстановимы по feed и D1/R2; unauthorized cursor не раскрывает metadata. Cyclic self-citation не усиливает evidence independence. Actual producer→consumer/read/search tests, exact hashes/SHA и erasure inventory linkage.
