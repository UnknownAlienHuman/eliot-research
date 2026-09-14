# S03 — восстановить реальный browser-сценарий добавления документа

База проверки: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Связь: F20, #98; диагностика #194 полезна, но отдельного разрешения на начало не требуется. Это задание, не выполненное исправление.

## 1. Суть
CI 34838617436 падает в `runRawFileUploadOwnerScenario`, вызванном из `owner-e2e.mjs:6037`. Helper ожидает `File saved`, тогда как текущий интерфейс запускает upload → processing → admission и использует другие состояния. Это подтверждённое расхождение; считать его единственной причиной всего падения без воспроизведения нельзя.

## 2. Что сделать
Восстановить один сценарий: выбрать файл → добавить документ → увидеть сохранённый источник → reload → открыть те же данные без дубликатов. Согласовать момент снимков D1/R2 с реальной автоматической обработкой, а не с прежним captured-only UI.

## 3. Документация
[Execution contract, §3–5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F 'D1/R2/runtime, crypto, transactions' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'runRawFileUploadOwnerScenario' -- tests/integration/browser
git grep -n -F 'rawFileReceiptCopy' -- apps/eliotr-pwa/src
```

## 4. Как сделать
Работать в `tests/integration/browser/raw-file-browser.mjs`, его tests и непосредственно затронутом участке `owner-e2e.mjs`. Сначала получить исходный assertion. До действия сохранить базовое состояние, после окончания — фактические capture/admission/revision/outbox. Проверять стабильное состояние и идентификаторы, не промежуточную фразу. Использовать существующий Worker/browser harness; внешнюю конверсию можно контролировать, application HTTP и хранилища не подменять. Отдельный доказанный дефект приложения исправлять только вместе с воспроизводящим тестом.

## 5. Критерии выполнения
- Linux и Windows owner-browser сценарий проходит; исходный отказ показан до исправления.
- Импорт и reload сохраняют одну логическую операцию и ожидаемое число ревизий; чужой источник не появился.
- Контрольный отказ admission не изображается успешным импортом.
- Сохранены отрицательные проверки, cleanup и реальные D1/R2 readback; нет skip или бессмысленного увеличения timeout.
- В PR указан исправляющий SHA, команды и exit codes; оставшиеся независимые CI-ошибки перечислены отдельно.
