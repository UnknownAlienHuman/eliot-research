# S75 — Wiki/report: прочитать, проверить, исправить, опубликовать

База a2aca127; ER-25/11/12. Использовать реализуемые compiler/publication/dependencies #245–#247 и historical read #199; Research layout #218 не переписывать.

## 1. Суть
Смешение Published/Proposed/DRAFT и повторяющихся технических пояснений делает состояние документа непонятным. Пользователь не должен угадывать, опубликован ли текст и какие утверждения проверены.

## 2. Что сделать
В existing Wiki/report view разделить список черновиков, опубликованные версии и просмотр выбранной revision. Для выбранного документа: текст, claim verdicts/цитаты, history, edit section, review/publish доступные по реальной роли, download/export. Source freshness и editorial publication показывать отдельно от evidence acceptance.

## 3. Документация / grep
[Канон §9.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md) и [production plan §8.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F '### 8.5 Wiki and artifact materialization' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Переиспользовать Wiki/artifact APIs и panels. Переключение revision не меняет canonical head. Edit создаёт новую COW revision; inherited audit не присваивается изменённому утверждению. Показывать причину недоступного publish, не disabled без объяснения; confirm dialog относится к точной revision. При stale CAS предложить сравнить/перечитать, не перезаписать автоматически. Download проверяет все части и сохраняет DRAFT/limitations/verdicts. В длинном отчёте грузить section по мере запроса, не весь corpus/report в браузер одним JSON. Общее оформление/keyboard/mobile из existing UI.

## 5. Критерии выполнения
- Draft→read exact citation→edit B→review→publish→reopen v1/v2 проходит; A/C hashes сохраняются при неизменных dependencies.
- Edited unsupported claim не выглядит проверенным; no permission/stale source/purge/CAS conflict не обходятся кнопкой.
- History/download после reconnect отражают тот же artifact и claims; partial download не выдаётся полным.
- Actual browser/HTTP/storage tests, accessible controls и desktop/mobile/dark/light screenshots; exact SHA. Никакой новой workflow/renderer библиотеки ради перестановки элементов.
