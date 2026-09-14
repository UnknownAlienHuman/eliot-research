# S37 — выполнить исследовательские ветви, а не только записать их имена

База a2aca127; ER-08/09/10/16, inputs #227/#228. Counter-search implementation #214 переиспользуется, не дублируется.

## 1. Суть
Branch scheduling остаётся открытым в текущем gap-register. Отдельные model synthesis/audit уже работают; нужен исполнитель независимых задач SUPPORT/COUNTER/ALTERNATIVE/CHRONOLOGY/IMPLEMENTATION/LITERATURE/SOURCE_AUDIT по выбранному профилю.

## 2. Что сделать
Добавить ограниченное выполнение branches в existing ResearchWorkflow и W1 ledger, с реальными READ_AND_EXTRACT/ANALYZE результатами. Вызывать только branches, необходимые протоколу; сначала fixture SUPPORT+COUNTER. Переиспользовать чистые branch prompts, resolved EvidencePack, W3 attempt/reservation и R2 outputs.

## 3. Документация / grep
[Канон §7.7–7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.8. Research branches' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'Each expensive model call has a durable checkpoint.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Deterministic branch ID = existing investigation/protocol revision+branch role+input identity. Каждый expensive call отдельный step/attempt, не цикл платных запросов внутри одного retryable step. Параллелизм только существующего execution envelope (канон default2/max4/nested0), не новые квоты. Lead chat не копировать в branches, только bounded relevant context и reference manifest. После каждого branch сохранять candidate claims/evidence refs/unknowns/lineage; RECONCILE собирает результат детерминированно, сохраняет dissent и missing branches. W1 mutation сериализуется CAS, network вне transaction. Deadline/cancel прекращает новые dispatch, готовые результаты не теряются. Provider UNKNOWN не означает новую branch attempt.

## 5. Критерии выполнения
Две независимые branches действительно исполняются и входят в freeze; disjoint prompts не содержат чужой приватный scope. Failure одной branch оставляет explicit debt/coverage, не false all-complete. Crash/retry/concurrent callback не дублируют outputs/charges; поздняя ветвь после freeze требует reopen. Все selected branch roles маршрутизируются к реальному handler, недоступная обязательная роль явно блокирует её obligation. W1/W2/W3+R2 tests и factory readback с exact SHA; нового swarm/agent framework нет.
