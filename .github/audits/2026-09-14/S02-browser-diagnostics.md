# S02 — Сохранить первопричину падения owner browser acceptance

P1. ER-27; общий tooling — ER-00. Родитель #98. База `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Аудит F13/F20. Независимо от S01 по коду; выполнять последовательно. Это только паспорт задачи; не исправление и не разрешение deployment. Код — узким изменением main, без worktree.

## 1. Суть

В `tests/integration/browser/owner-e2e.mjs`, `preserveWorkerFailure`, новая Error содержит только safe class и runtime snapshot. Исходное expected/actual и содержательный assertion теряются. CI указывает на вызов raw-upload helper около строки 6037, но не сохраняет точную причину. `unknown:61` не означает 61 ошибку приложения.

## 2. Что сделать

Сохранить безопасную диагностическую идентичность исходного assertion, этап, точное место, ограниченные expected/actual для явно разрешённых тестовых значений. Сохранить наблюдаемую цепочку причины так, чтобы formatter/test runner не вывел токены или исходный документ. Не менять приложение, timeout, retries или успешность теста.

## 3. Документация / grep

[Execution contract §5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md): `## 5. What a good result is` — before/after, expected/actual, отсутствие секретов.

```sh
git grep -n -F '## 5. What a good result is' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'preserveWorkerFailure' -- tests/integration/browser/owner-e2e.mjs
```

## 4. Как сделать

Расширить существующий диагностический wrapper и его tests, не строить новый logger. Добавить стабильный ID проверки или phase; ограничить глубину cause, длину строк и allowlist полей. Не помещать необработанный Error в cause, если стандартный runner напечатает его целиком. На синтетических assertion и nested errors доказать сохранение причины; на секретных/больших значениях — redaction. Повторить исходный raw-upload сценарий один раз на том же коде и сохранить уже точный отказ для S03.

## 5. Критерии выполнения

- [ ] Из вывода можно однозначно определить исходный assertion и безопасные expected/actual либо причину их redaction.
- [ ] Token/cookie/Authorization, URL с токеном и приватное содержимое не появляются в логе, stack/cause или test artifacts.
- [ ] Ошибка остаётся ошибкой; exit code не становится нулевым; cleanup выполняется.
- [ ] Не увеличены timeout и retries, не удалены проверки raw-upload.
- [ ] Приложены focused tests, exact SHA и фактический диагноз последнего воспроизведения. S03 исправляет поведение отдельно.
