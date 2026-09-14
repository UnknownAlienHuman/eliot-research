# S05 — совместимый deployment не должен обрывать Research run

База `a2aca127`; F01. Тема #92, развёртывание #96. PR-задание, не исправление.

## 1. Суть
`synchronizeResearchDeploymentAuthority` переводит прежнюю deployment generation в RETIRED. View `research_workflow_current` требует ACTIVE generation исходного run. Поэтому выкладка даже совместимого изменения исключает старый run из current authority. Это не удаление результата, но блокировка продолжения/чтения через current-only пути.

## 2. Что сделать
Обеспечить продолжение одного существующего run после совместимой выкладки без смены его operation ID, frozen inputs и receipts. Сначала поддержать сценарий изменения PWA при неизменных backend contracts; несовместимые изменения должны останавливаться явно.

## 3. Документация
[ELIOT_RESEARCH §7, §7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '### 7.7.2. ResearchWorkflow' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'synchronizeResearchDeploymentAuthority' -- scripts
```

## 4. Как сделать
Разделить provenance исходного execution и текущую совместимость runtime в существующих `research-deployment-authority.mjs`, `research-workflow.ts` и currentness-проверках. Использовать уже имеющиеся handler/schema/config generations, не считать любой git SHA новой несовместимой authority. Сделать минимальное additive schema изменение только при необходимости. Не менять исторические run/receipts и не удалять проверки purge, policy, cancellation, principal. Не создавать новый deployment manager или общую систему версий.

## 5. Критерии выполнения
- Run на A переживает совместимый B: прежние ID, checkpoints, hashes; статус и продолжение доступны.
- Завершённый платный шаг не выполняется второй раз.
- Несовместимый handler/schema даёт явную причину, не ложный COMPLETED и не потерянный run.
- Реальный revoke/purge останавливает работу и после совместимого deployment.
- Regression выполняется на локальном Worker/D1/R2; exact SHA и результаты сохранены. Live deployment требует отдельного штатного запуска, не делается ради написания задания.
