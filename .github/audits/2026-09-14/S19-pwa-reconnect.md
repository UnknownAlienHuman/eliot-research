# S19 — не терять вопрос и operation ID при временной потере связи

База `a2aca127`; F17. Не задача на offline-хранилище приватных документов.

## 1. Суть
В `main.ts` offline, health-lost, failed refresh и смена generation вызывают широкий clearPrivateEvidence. Транспортная ошибка, отзыв доступа и reset пользовательского сценария смешаны.

## 2. Что сделать
Разделить transient disconnect и действительную потерю авторизации. В текущей вкладке сохранять пользовательский черновик и ссылку на уже запущенную операцию; после reconnect повторно разрешить чтение и продолжить наблюдение, не перезапускать исследование.

## 3. Документация
[Канон §7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [Execution contract §5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'clearPrivateEvidence' -- apps/eliotr-pwa/src/main.ts
```

## 4. Как сделать
В существующих panel lifecycle handlers выделить presentation intent и авторизованный response. Источник/цитаты при недоступной проверке скрывать по действующей privacy policy; не создавать offline cache. Черновик держать в памяти вкладки, без неявного localStorage/IndexedDB. При logout/revoke очищать приватное состояние; поздний ответ старого запроса отбрасывать. Reconnect читает status старого operation ID, не выполняет POST run.

## 5. Критерии выполнения
- Network toggle/HTTP 503 не теряют введённый вопрос и связь с run.
- После reconnect нет нового paid run и повторного upload.
- Logout/401/revoke и foreign late response не восстанавливают приватный контент.
- Нет неявной записи исходников или черновиков на диск; privacy-тесты сохранены.
- Короткий browser regression через existing harness, exact SHA/results.
