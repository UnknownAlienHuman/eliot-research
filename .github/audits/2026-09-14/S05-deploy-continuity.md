# S05 — продолжение Research при совместимой выкладке

База `a2aca1277b0edbbed04de66e0d44e383e1b815ef`; уточнённое PR-задание, не реализация. ER-24/26 и ER-13. Область: deployment authority → Workflow currentness, не переделка JWT.

## 1. Суть
`research-deployment-authority.mjs` retire-ит старую deployment generation, а `research_workflow_current` требует её ACTIVE. Поэтому даже PWA-only change обрывает исполняемый run. Нельзя лечить это постоянным git ID или удалением всех generation checks.

## 2. Что сделать
Разделить две сущности: точный build ID для диагностики/provenance и совместимость исполнения для разрешения продолжить старый run. **Выбранное решение:** сравнение воспроизводимого fingerprint backend, а не whitelist SHA и не новый version manager. В первой реализации доказанно совместимы только идентичные backend execution inputs; неизвестная совместимость не угадывается.

## 3. Документация / grep
[Канон §7 и §7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [языковой контракт §2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'research_workflow_current' -- infra/d1/core/migrations/0020_research_workflow_checkpoints.sql
git grep -n -F 'synchronizeResearchDeploymentAuthority' -- scripts
```

## 4. Как сделать
1. В существующем deployment builder вычислить fingerprint из детерминированных backend module bytes до подстановки build ID, compatibility_date/flags, binding topology/resource identities, поддерживаемых handler generations, применённого SQL-schema manifest и несекретных frozen configuration refs. PWA assets, документацию и время сборки исключить. Secret values не хешировать/публиковать; фактическая credential authority проверяется отдельно.
2. В existing deployment record/manifest добавить fingerprint (поле предлагаемое). `DEPLOYMENT_GENERATION` и старые run/receipt bytes сохранить. Currentness связывает исходный deployment run с текущим ACTIVE deployment через равный доказанный fingerprint; только deployment-предикат меняется. Все scope/purge/policy/principal/allowed_use/cancel predicates остаются.
3. Workflow dispatch использует записанный handler и execution provenance, а не заменяет их новым env ID. Создание новых runs относится к текущему build. Изменить согласованно `research-workflow.ts`, `research-session.ts`, deployment synchronizer и versioned status decoder; не исправлять только SQL view.
4. Переход для legacy `git-*`: fingerprint привязывать только по сохранённым/прочитанным точным deployed artifacts и конфигурации. Нет доказательства — старый run остаётся сохранённым с явной incompatible/needs-migration причиной, а его read-only история доступна через #198/#199. Не переписывать старые receipts и не восстанавливать REVOKED authority.
5. При backend-change несовпавший fingerprint означает отсутствие автоматического продолжения. Поддержку конкретного старого handler доказывать versioned transition tests до разрешения этого upgrade; не разрешать arbitrary schema changes. Откат A←B с теми же execution inputs работает по тому же сравнению. Миграции только additive.

## 5. Критерии выполнения
- A→PWA-only B и B→A: прежний operation ID, checkpoints/output hashes; status и дальнейшие шаги работают. Два сборочных прогона одних inputs дают один fingerprint.
- Изменение backend handler/schema/resource identity/config generation меняет fingerprint и не продолжает неизвестную семантику молча; run не удаляется.
- Legacy transition имеет positive evidence-backed и negative unknown case; retired/revoked grants не воскрешаются.
- Выполненные provider effects не повторяются; ещё не выполненные законные стадии допускаются по обычному бюджету.
- Revoke/purge/cancel действуют при обоих builds. Локальные D1/R2/Workflow tests и exact SHA приложены; native deployment/rollback qualification выполняется отдельно на разрешённой цели.
