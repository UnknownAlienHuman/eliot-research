# S26 — один понятный Research экран: источники → вопрос → ответ → цитата

База `a2aca127`; F19. Только Research view, не переписывание всего PWA.

## 1. Суть
Перед вводом вопроса показаны Recent work, configuration и технические статусы; главное действие уходит за первый экран. Интерфейс заставляет изучать внутреннюю архитектуру.

## 2. Что сделать
Перестроить существующий Research view: слева компактный выбор источников, в центре вопрос/ответ, справа точная цитата при выборе. Поле вопроса и основное действие доступны сразу. Конфигурацию/схемы/proof expiry убрать с основного пути в existing Connections/details.

## 3. Документация
[Канон §0 и §7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Chat is an interface to an Investigation.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'apps/eliotr-pwa' -- AGENTS.md
```

## 4. Как сделать
Переставить/переиспользовать existing panels в `main.ts`/Research panel/CSS. Не менять backend, не ставить новый UI framework и не имитировать отсутствующие функции. Recent work сделать компактной историей, technical states спрятать под details. При blocked run показать одну понятную причину и действие; готовность не скрывать декоративным READY. Сохранить стабильные data-атрибуты и keyboard/accessible labels.

## 5. Критерии выполнения
- На 1440×900 поле вопроса, выбранный scope и основная кнопка видны без прокрутки.
- На узком экране источники/цитата доступны как раскрываемые панели, ввод не перекрыт.
- Клик citation открывает exact evidence, не tooltip без источника.
- Нет новых внешних сервисов/frameworks и дублированных forms; API-запросы прежние.
- Browser test проходит выбор проекта→вопрос→ответ→цитата и blocked state; приложены скриншоты и exact SHA.
