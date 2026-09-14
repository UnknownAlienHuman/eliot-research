# S49 — ProjectAtlas отражает выбранный проект, а не случайный top-k

База a2aca127; ER-30/31/39. Existing SourceCard/DocumentMap/materialization переиспользовать; structural reading #240.

## 1. Суть
Metadata orientation и отдельный SourceCard не дают законченной карты проекта и объяснимого покрытия источников. Gap-register прямо оставляет полный Atlas открытым.

## 2. Что сделать
Собрать immutable ProjectAtlas из доступных source cards/maps: frozen membership, тематические reading routes, represented/omitted refs с причинами и точные ссылки для structural expansion. Для первого checkpoint работать внутри текущего supported scope; масштабирование logical scope отдельная задача, не повышать лимиты вслепую.

## 3. Документация / grep
[Канон §6.5–6.7 и §19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'ProjectAtlas' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 19.5. Projects and disclosure' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Existing navigation stores, source refs и scope service; Atlas assembly deterministic over exact allowed membership, no graph DB. Две project memberships одного source не создают второй canonical SourceRevision. Missing parser/map/source class остаётся omission, не исчезает из denominator. Topic labels/routes navigation-only; evidence support требует exact resolver. Membership/head update создаёт новую Atlas revision, stale cached map не mixed с текущим scope. UI ORIENT открывает конкретный route→section→evidence, доступная metadata не выдаётся за полный source grant.

## 5. Критерии выполнения
Два проекта с общим source имеют правильные независимые Atlases и общую canonical revision без cross-project disclosure. Eligible set = represented плюс explicit omissions в выбранном scope; unknown denominator не становится complete. Change/purge даже source, упомянутого только в omissions, инвалидирует зависимый view. Replay/restart возвращают immutable Atlas hashes. Actual orientation/expand/API/browser tests и SHA.
