# S10 — реальное право машинного клиента на Research проекта

База `a2aca127`; F09. Первый из небольших headless checkpoints; #93/#95 остаются общими темами, не дублировать их целиком.

## 1. Суть
Верифицированный service token получает `trusted_agent`, но owner-only сервисы требуют `owner_pwa`. Нельзя исправить это подменой класса или пересылкой браузерного JWT. Нужна явная проектная авторизация машинного principal.

## 2. Что сделать
Подключить проверенного service principal к существующей policy/grant модели одного проекта: read/query/run и бюджет там, где действие платное. В этом PR реализовать и протестировать только решение авторизации и получение допустимого scope, без MCP и всех endpoint-ов.

## 3. Документация
[Канон §0 и §7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Trusted agents and optional client adapters use the direct semantic API.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.9. Reference firewall, evidence freeze, and claim audit' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Использовать Cloudflare Access verifier, `AuthenticatedRequestContext`, существующие scope/policy stores. Найти уже имеющиеся principal/project bindings и расширить минимально, не строить OAuth server/RBAC framework. Principal берётся из verified auth, проект и права — из серверной политики, не доверенного body. Проверять ту же policy до и после внешнего чтения. Изменение auth helper не должно автоматически включить все owner routes.

## 5. Критерии выполнения
- Установленный service principal получает ровно разрешённый scope; owner flow не меняется.
- Другой project/action/principal отказан до writes/model calls.
- Отзыв существующей policy/grant немедленно учитывается; новый токен сам не расширяет scope.
- Test через настоящий HTTP auth boundary и D1, не только вызов helper с готовым owner context.
- Нет браузерного JWT, пароля, provider key или фиктивного owner_pwa у агента; exact SHA/tests приложены.
