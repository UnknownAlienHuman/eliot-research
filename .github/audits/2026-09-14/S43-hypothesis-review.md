# S43 — HYPOTHESIS_REVIEW сохраняет проверяемые альтернативы

База a2aca127; ER-08/10/11; inputs #228/#229/#230/#232.

## 1. Суть
Список гипотез без predictions/falsifiers/альтернатив и scoped outcome не является продуктом HYPOTHESIS_REVIEW.

## 2. Что сделать
Установленный product profile читает persisted HypothesisCards, назначает discriminating checks existing obligations/branches, сохраняет support/counterevidence/alternatives и scoped status каждой гипотезы. Результат — section-versioned artifact с next probes, не новый knowledge graph.

## 3. Документация / grep
[Канон §7.6 и §7.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.6. HypothesisCard' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Existing card identities/W1 revision и model/audit/artifact adapters. Discriminating check обязан ссылаться на конкретную measurement/source/proof obligation и verifier; рассуждение модели не делает status supported/falsified authoritative само по себе. Сохранить origin/exposure lane; exploratory tuning на тех же данных не подтверждает confirmatory hypothesis. Поддержка при разных population/time/assumptions не автоматически противоречие. Unknown and failed probe видны; budget stop не удаляет проигравшую альтернативу. Новые результаты обновляют cards через #232, старые artifacts неизменны.

## 5. Критерии выполнения
Fixture с двумя rivals и неразрешённым confound сохраняет обе, predictions/falsifiers и next probe. Явное опровержение связано с точным span/измерением, не confidence score. Scoped unknown не стал universal false, discarded alternative не исчезла. Replay/cancel/reauth и source revision change безопасны. Actual branch→audit→artifact tests/SHA, не только schema test.
