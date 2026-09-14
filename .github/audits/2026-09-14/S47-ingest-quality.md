# S47 — приём PDF/Office/text с доказуемой extraction fidelity

База a2aca127; ER-05/14/29/37; reuse cloudflare-raw-ingest, cloudflare-markdown, raw-normalized-admission и SourceAdmissionDecision. #195 исправляет browser regression, не все форматы/качество.

## 1. Суть
Capture transport и успешный toMarkdown не равны пригодному admitted document. Большие/повреждённые/табличные источники должны давать корректный результат или явное ограничение, а не усечённое evidence.

## 2. Что сделать
Дописать недостающие переходы capture→conversion candidate→quality qualification→normalized bundle→admitted revision→projection outbox. Отдельно поддержать reuse уже нормализованного bundle, не гонять его через LLM повторно. Покрыть заявленные PDF/DOCX/HTML/TXT/Markdown/CSV/JSON и image inputs согласно реально доступной conversion precision.

## 3. Документация / grep
[Канон §19.1/19.3 и Slice1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'uncaptured web result used as evidence' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'SourceAdmissionDecision' -- docs/architecture/ELIOT_RESEARCH.md apps/eliotr-core/src
```

## 4. Как сделать
Зафиксировать byte length/hash/format/parser generation, coverage of text/structure и explicit omissions. Пустой/login/truncated/corrupt/unsupported parser result не promoted. Raw16MiB и materialized conversion8MiB — разные существующие bounds: UI заранее объясняет доступный путь; для larger preprocessing использовать approved external normalized-bundle producer, не целиком буферизовать в Worker и не добавлять Python/OCR engine. Original immutable bytes сохраняются, successful conversion не приписывает native page coordinates без map. Commit SourceRevision/admission/outbox одним existing guarded path, unknown effect reconciles прежний ID. Source taint/ownership/residency не теряется при normalization.

## 5. Критерии выполнения
Representative valid и degraded format fixtures проходят полный actual Worker/D1/R2 path; отказ не создаёт partially admitted source/outbox. Replay/lost ACK/restart создают ровно одну intended revision; changed bytes конфликтуют или новая explicit revision. Long input не молча обрезан, normalized bundle не повторно оплачивается. Native precision claim не превышает карту. Код/fixture acceptance и реальные extraction-quality receipts разделены; exact SHA/results.
