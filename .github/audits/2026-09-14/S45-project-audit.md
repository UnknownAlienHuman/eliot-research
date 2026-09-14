# S45 — PROJECT_VS_LITERATURE_AUDIT с трассируемой матрицей

База a2aca127; ER-08/10/11; inputs #228/#229/#231/#232.

## 1. Суть
Summary документации проекта не проверяет его утверждения относительно литературы, стандартов и operational evidence.

## 2. Что сделать
Один approved product profile: строки project_claim/assumption → source version → external normative/empirical evidence → counterevidence → mismatch/gap/alternative/severity → exact support/next probe. Входные project docs/code snapshots и литература — admitted sources, не непроверенные live ссылки.

## 3. Документация / grep
[Канон §7.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Project claims and assumptions are mapped to evidence' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Existing branch executor/source portfolio/exact resolver и artifact schema. Различать нормативное требование, implementation claim, реально наблюдавшийся run и мнение автора. По design document нельзя утверждать, что feature реализована или измерена. При сравнении версий пинить commit/document edition/time, source-native code anchors только квалифицированным bridge; иначе normalized exact span и typed precision limitation. Недоступная external source становится acquisition debt, не реконструируется моделью. Severity — объяснённая оценка последствий, не автоматически подтверждённая уязвимость. Рекомендации не записываются в клиентский проект и не создают PR без explicit client authority.

## 5. Критерии выполнения
Fixture: заявленная, но не подтверждённая runtime feature, obsolete spec, конфликтующий первичный source и community claim получают разные статусы с evidence/limitations. Из наличия файла не получается execution PASS, из no-hit — доказанного отсутствия реализации. Source/excerpt sufficiency разделены, контрпозиция не пропущена. Same run/refs replay, scope isolation, artifact readback и exact SHA/tests.
