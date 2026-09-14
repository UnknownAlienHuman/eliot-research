# S21 — не выдавать технические checkpoints за выполненные исследования

База `a2aca127`; F06. Это прозрачность реального pipeline, не требование создать 18 агентов.

## 1. Суть
Восемь stages попадают в deterministicWorkflowStageBytes, возвращающий hash/operation/stage/attempt. Название COUNTER_SEARCH или PLAN в receipt само по себе не доказывает соответствующую работу. При этом orientation/retrieval частично выполняются в других местах — не объявлять весь продукт пустым.

## 2. Что сделать
Связать presentation/trace выполненных stages с реальными handlers и артефактами. Отдельно обозначить технический checkpoint, работу, объединённую с другим stage, и невыполненное обязательство.

## 3. Документация
[Канон §7.4 и §7.7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'An implementation may merge adjacent inexpensive stages.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'A summary, score, model agreement, or completed Workflow step' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'deterministicWorkflowStageBytes' -- apps/eliotr-core/src packages/cloudflare-workflows/src
```

## 4. Как сделать
В existing stage factory/trace/status определить фактического исполнителя и supporting output refs. Не менять 18 checkpoint IDs и исторические receipts ради косметики. Не создавать параллельный реестр: производить описание из существующей assembly. Если требуемое protocol obligation не реализовано, status должен честно назвать его, не повысить grade/disposition. Отдельный S22 реализует counter-search.

## 5. Критерии выполнения
- Technical PLAN/COUNTER_SEARCH не отображаются как содержательно выполненные без соответствующего результата.
- Объединённые этапы с реальной работой не теряют credit/trace.
- ENGINE_COMPLETED не превращается автоматически в исследовательскую полноту.
- Контрольная замена meaningful handler на technical bytes обнаруживается тестом.
- Exact SHA/tests и актуальная gap/status запись, без нового framework.
