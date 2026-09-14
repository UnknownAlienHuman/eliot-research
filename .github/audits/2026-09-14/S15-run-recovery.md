# S15 — восстановить тот же run после временного отказа чтения

База `a2aca127`; F10/F11. Это один recovery case, не универсальный retry engine.

## 1. Суть
Все стандартные стадии выполняются с retries.limit=0. Это защищает неопределённые платные эффекты от слепого повторения, но оставляет безопасные read/settlement отказы без завершённого пользовательского восстановления.

## 2. Что сделать
Реализовать recovery одного run, у которого SYNTHESIZE уже сохранён, а следующий неплатный read/verify шаг прерван временной ошибкой. Повторно использовать прежние instance/operation/checkpoints.

## 3. Документация
[Канон §7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [Execution contract §3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F 'A lost ACK is UNKNOWN' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'recoverStartedAttempt' -- apps/eliotr-core/src packages/cloudflare-research/src
```

## 4. Как сделать
Переиспользовать existing W2/W3 readback и recoverStartedAttempt. Различить safe read retry, committed output recovery и unknown model outcome. Expose минимальную recover/resume-операцию в текущем run API, если её действительно нет. Не заменять operation ID и не вызывать новую модель для ремонта stored output. Сбой integrity/auth/cancel не retry-ить как transient.

## 5. Критерии выполнения
- Инъекция временной ошибки после сохранённой synthesis затем recovery завершают тот же run.
- Счётчик платных попыток и исходный output hash не меняются.
- Lost recovery ACK/repeated request сходятся к одному результату.
- UNKNOWN provider effect остаётся неопределённым до доказуемого readback; revoke/cancel/corruption отказаны.
- Tests показывают persisted rows/objects, не только mock counters; exact SHA/commands приложены.
