# S93 — Golden Corpus как реальный promotion gate, а не набор зарегистрированных кейсов

**Статус:** исполнимое задание; этот файл не меняет evaluator/runtime.
**Проверенная база Eliot:** `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`, 2026-10-08.
**Цель:** измерять retrieval, exact evidence, неизвестность, claim support и качество отдельных ASK/BRIEF/COMPARE/FACT_CHECK/DEEP_RESEARCH/REPORT outputs. Один общий pass/fail и LLM judge не являются достаточной приёмкой.

## 1. Подтверждённые разрывы

### 1.1. `acceptable_unknowns` сейчас декоративно

`GoldenCase` и corpus JSON содержат `acceptable_unknowns`, но `ObservedExtraction` не содержит unknowns, а `adjudicateGoldenCase` это поле не читает. Кейс может вернуть произвольную неизвестность и пройти gate, если atoms/handles/coverage совпали.

Дополнительно parser допускает пустую строку внутри `acceptable_unknowns`.

### 1.2. Теряются причины отказа

`adjudicateGoldenCase` формирует конкретные failures, но `evaluateGoldenRun` сохраняет только `passed` и synthetic `diagnostics_ref`. В результате immutable run result не объясняет, какие atoms/handles/coverage/collapses провалены.

Missing observation также превращается только в `missing-observation-*`, а не в typed failure.

### 1.3. Смешаны retrieval product и Research execution product

`GoldenCase.expected_product` имеет тип `QueryProduct` (`FAST_SEARCH`, `LOCATE`, `RESEARCH` и т. п.). Он не различает `ASK`, `BRIEF`, `COMPARE`, `FACT_CHECK`, `DEEP_RESEARCH`, `REPORT`.

`tests/integration/browser/s92-products.mjs` отдельно проверяет enum/ledger admission, но не фактическое product execution. Поэтому существующий Golden Corpus не является per-product quality gate.

### 1.4. Нет воспроизводимой run identity

Текущий `GoldenRunResult` не связывает результат с corpus/case digest, retrieval policy, model/prompt/schema generations, code SHA, cache mode, cost и latency. Такой результат нельзя надёжно сравнить с другим запуском или использовать для promotion.

## 2. Что читать

- `docs/architecture/ELIOT_RESEARCH.md`: §§6.12, 7.8–7.12, 8.5, 19.
- `packages/testkit/src/golden.ts`: parser, `ObservedExtraction`, `adjudicateGoldenCase`, `evaluateGoldenRun`, promotion gate.
- `packages/testkit/src/golden.test.ts`.
- `tests/golden-corpus/manifest.json`, `case.schema.json`, `cases/**`.
- `packages/contracts/src/retrieval.ts`: physical query products.
- `packages/contracts/src/research.ts`: Research execution products and claim-audit dispositions.
- `tests/integration/browser/s92-products.mjs`: admission-only boundary.
- R02/#242, R03/#325, R04/#214, S41/#233: outputs/receipts that evaluator consumes.

## 3. CODE — checkpoint A: исправить deterministic evaluator

Изменить `packages/testkit/src/golden.ts` и focused tests:

```ts
interface ObservedExtraction {
  atoms: readonly string[];
  forbidden: readonly string[];
  handles: readonly VersionedRef[];
  unknowns: readonly string[];
  coverage: string;
}

interface GoldenRunResult {
  // existing fields
  observed_unknowns: readonly string[];
  failures: readonly GoldenFailureCode[];
}
```

Минимальная семантика:

- observed unknowns — exact bounded strings;
- каждый observed unknown обязан находиться в `acceptable_unknowns`;
- допустимый unknown не обязан появляться;
- duplicate/empty/malformed unknown не нормализуется молча;
- missing observation получает `MISSING_OBSERVATION:<case_id>`;
- verdict failures сохраняются в result bytes, а не только превращаются в synthetic diagnostics ref.

Новые deterministic codes:

```text
UNEXPECTED_UNKNOWN
DUPLICATE_UNKNOWN
MALFORMED_UNKNOWN
MISSING_OBSERVATION
```

Не использовать fuzzy/embedding matching для unknown identity. Если нужны варианты формулировки, case v2 должен перечислять canonical unknown ID и отдельные accepted surface forms.

Этот checkpoint допускается отдельным маленьким source PR. Он не требует model/provider calls.

## 4. CODE — checkpoint B: Golden Corpus protocol v2

Не ломать v1 corpus files. Добавить v2 schema/loader с явным разделением:

```yaml
expected_query_product: RESEARCH
expected_execution_product: ASK | BRIEF | COMPARE | FACT_CHECK | DEEP_RESEARCH | REPORT
partition: DEVELOPMENT | HOLDOUT
required_atoms: []
forbidden_collapses: []
required_evidence_handles: []
acceptable_unknowns:
  - unknown_id:
    accepted_surface_forms: []
coverage_requirement:
source_family_requirements:
latency_budget:
cost_budget:
```

`expected_execution_product` входит в case/result identity. V1 `expected_product` остаётся retrieval product и читается прежним decoder.

Не автоматически переводить все v1 cases в product-specific PASS. Сначала назначить продукт вручную и проверить fixture intent.

## 5. CODE — checkpoint C: immutable evaluation receipts

Добавить versioned run manifest, предлагаемые paths:

- `packages/testkit/src/golden-run-manifest.ts` **(NEW)**;
- `packages/contracts/src/evaluation.ts` **(NEW, если receipt должен быть cross-package wire contract)**.

```yaml
GoldenRunManifest:
  protocol:
  run_ref:
  code_sha:
  corpus_generation:
  corpus_manifest_sha256:
  case_set_sha256:
  partition:
  query_product:
  execution_product:
  retrieval_policy_generation:
  ai_search_generation:
  prompt_generations: []
  schema_generations: []
  model_route_fingerprints: []
  product_plan_generation:
  cache_mode: COLD | WARM
  started_at:
```

Каждый case result хранит:

- actual provider query/rank receipt;
- resolved/omitted handle refs;
- exact coverage disposition;
- claim-audit refs;
- typed failures;
- latency/cost counters;
- output/artifact digest.

Не хранить raw secret/provider payload. Evidence text остаётся в canonical stores; receipt ссылается на handles/digests.

## 6. Метрики — не сводить в один score

### Retrieval

- required-handle Recall@k;
- MRR/nDCG только там, где case содержит graded rank relevance;
- foreign/out-of-scope candidate count;
- duplicate rate;
- exact-resolution success and bounded-backfill exhaustion;
- provider candidate count vs resolved evidence count;
- represented source-family count.

### Answer / artifact

- required atom recall;
- forbidden collapse count — hard zero;
- unexpected unknown count — hard zero;
- claim support precision;
- supported-claim coverage;
- exact cited-span resolvability;
- citation-to-claim alignment;
- unsupported precision count;
- contradiction/counterevidence handling;
- completion disposition correctness.

### Operations

- provider/model calls;
- input/output tokens;
- D1 reads, R2 bytes when measured;
- p50/p95 latency;
- cost per successful deliverable;
- unknown external-effect count.

Hard failures не компенсируются средним score. Например, высокая atom recall не перекрывает foreign evidence или forbidden semantic collapse.

## 7. CODE — checkpoint D: promotion и regression workflow

Один evaluator runner принимает immutable manifest и уже сохранённые outputs. Он не запускает новый paid effect при повторном adjudication.

Promotion policy:

1. deterministic hard gates;
2. per-product metric thresholds;
3. separate cold/warm performance;
4. holdout cases after tuning is frozen;
5. optional secondary human/LLM review;
6. signed/immutable promotion receipt.

Development и holdout case IDs/digests не смешиваются. Не публиковать holdout expected answers в runtime prompts.

Изменение model/retrieval/prompt/schema/product-plan generation всегда создаёт новый run identity. Сравнение двух runs разрешено только при явно перечисленных отличиях.

## 8. Доноры

### Promptfoo

[`GradingResult`](https://github.com/promptfoo/promptfoo/blob/421e7959642c5d4cc1c983259a268de1c6f847b9/src/types/index.ts): отдельные `pass`, `score`, `reason`, named metrics/details. Брать структурированный per-assertion result и derived metrics. Не заменять deterministic Eliot oracle внешним JavaScript/LLM assertion и не подключать весь runtime как production dependency.

### ScholarQABench

[`citation_correctness_eval.py`](https://github.com/AkariAsai/ScholarQABench/blob/95e6fc52b0a8a0ce0a74956029991e3bb00c38b9/scripts/citation_correctness_eval.py): citation correctness рассматривается отдельно от общего answer quality. Брать разделение метрик; не переносить post-hoc URL citation authority вместо exact EvidenceHandle.

### DeepResearchGym

[`eval_quality_async.py`](https://github.com/Flitternie/deepresearchgym/blob/b9fed8bd69644c2bbd03044e1a7c4ee2e8029ab7/eval_quality_async.py): parallel evaluator execution and retained per-evaluator results. Брать bounded parallel evaluation and raw per-judge outcomes; не считать LLM rating ground truth и не усреднять несопоставимые failure classes.

### Собственный Eliot

`ClaimAuditItem`, `EvidenceHandle`, `CoverageReceipt`, provider/model receipts и Golden required atoms — первичная authority. Внешний harness может запускать/визуализировать eval, но не определяет canonical pass.

## 9. DOCS

Обновить §19 и Golden Corpus docs:

- v1 vs v2;
- query product vs execution product;
- development vs holdout;
- deterministic vs model/human evaluation;
- hard gates vs aggregate metrics;
- exact run identity and cache mode;
- NOT_EXECUTED/BLOCKED не равны PASS.

S92 docs должны честно называть текущие product tests admission/readiness checks до появления фактического ASK/BRIEF/COMPARE execution.

## 10. Приёмка

- Кейс с допустимым unknown проходит; тот же output с незаявленным unknown падает typed code.
- Empty/duplicate unknown не проходит parser/adjudication.
- Missing observation сохраняет typed failure в result.
- Failure details переживают serialization/readback.
- Один output не может быть одновременно засчитан как ASK и BRIEF без разных product identities.
- Изменение prompt/retrieval/model/product generation создаёт новый run.
- Holdout не читается tuning runner.
- Foreign/revoked/purged handle всегда hard failure.
- LLM judge outage не превращает deterministic failure в PASS.
- Report содержит per-case raw results, aggregate metrics, exact SHA/generations and remaining NOT_EXECUTED gates.

## 11. Проверки и границы

Code-first: `pnpm --filter @eliotr/testkit typecheck`, scoped ESLint, focused Golden test path. Corpus schema/fixture validation обязательно. Full product/browser/native quality runs выполняются после R02/R03/R04/S41 assembly и разрешённого controlled model run.

Не включать: новый vector DB, новый model router, production prompt optimization, скрытое auto-tuning на holdout, публикацию corpus evidence или blanket threshold waiver. Нет deployment/paid calls в документационном PR.
