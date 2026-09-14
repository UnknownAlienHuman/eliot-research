# S07 — закрыть приёмку старого отчёта после новой версии источника

База `a2aca127`; F03. Исправление уже внесено в `e5b5613`; не писать второй historical reader. По stop checkpoint работающий Worker оставался `git-66a0e20`, исправление не было live-принято.

## 1. Суть
Source update сохранял обе LIVE-ревизии, но invalidated scope приводил к HTTP 410 для старой Wiki/Research. В main добавлен отдельный historical read с проверкой source-head advance. Нужно проверить весь путь, а не только наличие helper.

## 2. Что сделать
Regression: источник v1 → сохранённые report/Wiki → v2 → открыть старый текст и его цитату, увидеть признак предыдущей версии. После действительного revoke/purge чтение должно отказать.

## 3. Документация
[Канон §7 и §9.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
[Stop checkpoint](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/live-document-project-acceptance-2026-09-14.md).
```sh
git grep -n -F '### Stop checkpoint requested by the owner' -- docs/implementation/live-document-project-acceptance-2026-09-14.md
git grep -n -F '## 9.2. Copy-on-write section tree' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Использовать `owner-historical-scope.ts`, `research-artifact-reauthorization-http.ts`, `wiki-proposal-reauthorization.ts` и `source-revision-freshness.ts`. Добавить test через API + реальные D1/R2, включая nested section/citations и activity. Исправлять только выявленные разрывы. Старые invalidation flags/grants не сбрасывать. Открытие отчёта не должно переписывать его текст под новый source head.

## 5. Критерии выполнения
- Старый body и citation совпадают с v1 hashes; v2 отдельно доступна.
- UI/API честно показывают previous revisions, не подменяют старую цитату новой.
- Новый source update не создаёт третий run или model call при чтении.
- REVOKED, purged, foreign и повреждённая revision отказаны.
- Local acceptance и последующий разрешённый live-check записаны отдельно; до live-check статус не объявляется live-fixed.
