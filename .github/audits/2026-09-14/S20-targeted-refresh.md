# S20 — обновлять только зависимые от изменившегося источника представления

База `a2aca127`; F18.

## 1. Суть
`refreshAfterSourceAdmission` вызывает `researchRun.invalidateSourceRevision()` при любом raw admission; метод удаляет открытый report и забывает workflow ID без проверки зависимости. Загрузка несвязанного документа закрывает текущую работу.

## 2. Что сделать
Передать в существующее событие подтверждённые source/revision IDs и обновлять только затронутый report/Wiki. При изменении релевантного head показать previous-revision состояние и повторно проверить read authority, не уничтожать исторический текст.

## 3. Документация
[Канон §9.2 и §9.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 9.2. Copy-on-write section tree' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'refreshAfterSourceAdmission' -- apps/eliotr-pwa/src/main.ts
git grep -n -F 'invalidateSourceRevision' -- apps/eliotr-pwa/src
```

## 4. Как сделать
Из actual admission response брать source identity; использовать dependencies/freshness уже прочитанного report. Не угадывать по имени файла и не добавлять глобальный event bus. Если dependency metadata отсутствует, выполнить проверку freshness без автоматического model rerun. При подлинном revoke/purge закрытие protected content остаётся обязательным. Исходный report ID и hashes не менять.

## 5. Критерии выполнения
- Admission несвязанного source не закрывает открытый report и не сбрасывает draft/selection.
- Новая версия зависимого source показывает предыдущую revision и сохраняет original report.
- Duplicate event не запускает дублированные refresh/model calls.
- Revoke/purge нельзя обойти кэшированным view или поздним ответом.
- Browser tests для двух независимых проектов и source update; exact SHA/results.
