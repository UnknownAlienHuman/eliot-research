# S61 — независимый federation client, ranges/cursors и compatibility

База a2aca127; ER-22/27/41. Execution #252; generic wire conformance не зависит от готовности другого клиентского репозитория.

## 1. Суть
Два тестовых конца с одним serializer могут одинаково ошибаться. Нужен реально отдельный HTTP-клиент и byte/schema oracle для всех federation операций.

## 2. Что сделать
В existing integration harness реализовать independent client без импорта server services/codecs; submit/status/result/cancel/bundle manifest+range/changes. Закрепить ERC-owned versioned wire fixtures и отдельный optional ELIOT compatibility adapter test, без runtime импорта DTO чужого репозитория.

## 3. Документация / grep
[Канон §11, §19.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'ERC29-DEC-012' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Client на native fetch/JSON с независимо сохранёнными expected fields/bytes и adversarial mutations. Test exact authenticated principal/issuer/audience, request/bridge generation, current client fence, AllowedReferenceManifest, verifier/tool whitelist и disclosure/retention. Cursor bound to principal/job/scope/revision, range bounded against canonical length. Wrong range/expired cursor/corrupt/truncated R2/unsupported wire fields дают typed refusal, not empty success. Выполнить reauth/credential rotation по declared compatibility, не unpin bridge generation ради passing test. Повтор после transport timeout readbacks same job. OPTIONAL leaf adapter mappings prove result not stronger and same evidence lineage; отсутствие unselected peer не блокирует generic local tests, но selected peer qualification нельзя считать passed.

## 5. Критерии выполнения
Все операции проходят через actual local Worker/D1/R2 independent client; forged/out-of-scope/verifier substitution и purge-during-stream не раскрывают данные. Result disposition не сильнее internal, synthetic text остаётся candidate. Lost ACK/cursor/restart не теряет/удваивает jobs. Контрольная ошибочная server serialization ловится независимым oracle. После staging отдельный mutually-authenticated deployed peer run с exact receipts; local fixtures не live.
