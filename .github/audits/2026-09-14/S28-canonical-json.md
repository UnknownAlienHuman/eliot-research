# S28 — удалить повторную сериализацию query digest внутри retrieval

База a2aca127; ER-04. Пара выбрана и перечитана, это не задание агенту искать произвольный дубль.

## 1. Суть
`packages/retrieval/src/service.ts:106` локальная canonicalJson и `packages/retrieval/src/query-codec.ts` canonicalRetrievalJson имеют одинаковую рекурсию: null/bool/string, safe integer через String, массив в порядке, object entries без undefined и lexical-sort ключей. Отличается публичный error mapping. `query-persistence.ts` уже оборачивает codec — его wrapper не считать третьим алгоритмом. `canonicalEvidenceJson` НЕ эквивалентен на произвольных числах/undefined и в эту замену не входит.

## 2. Что сделать
Service использует canonicalRetrievalJson из query-codec, сохраняя прежний RetrievalQueryError(RETRIEVAL_INPUT_INVALID, query digest input is not canonical) на отказе. Удалить локальную рекурсию, оставить только необходимую адаптацию ошибок. DTO и digest input поля не менять.

## 3. Документация / grep
[Языковой контракт §3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [код сервиса](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/retrieval/src/service.ts), [codec](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/retrieval/src/query-codec.ts).
```sh
git grep -n -F 'Canonical serialization rules' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
git grep -n -e 'function canonicalJson' -e 'function canonicalRetrievalJson' -- packages/retrieval/src/service.ts packages/retrieval/src/query-codec.ts
```

## 4. Как сделать
Сначала retained fixtures на реальные digest inputs raw_query/product/literals/requested_limit/scope_digest плюс permutation ключей, BMP/non-BMP/escapes, null,-0,safe-int extrema, nested arrays и undefined object field. Invalid fractional/NaN/Infinity/undefined root должны сохранить ошибку service boundary. Не объявлять sparse arrays/циклы/произвольные JS objects валидными wire inputs; отдельно проверить прежний отказ через parser, не нормализовать их в новые persisted bytes. query-codec импортирует service types через import type: сохранить type-only связь, не внести runtime cycle. TypeScript остаётся текущим authority до отдельной Rust promotion.

## 5. Критерии выполнения
- Старые request/result/trace fixtures дают byte-identical digests и IDs; replay прежних записей работает.
- Service error code/message/retryability прежние; codec error contract отдельно не меняется.
- Локальный recursive body удалён; query-persistence wrapper и evidence serializer не ошибочно удалены.
- Boundary/typecheck/retrieval tests проходят. Показаны фактические before/after, exact SHA и команды, не заявлено «удалены все 26 реализаций».
