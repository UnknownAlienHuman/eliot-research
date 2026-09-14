# S39 — найденный URL проходит capture/admission до использования как evidence

База a2aca127; ER-05/14/16/29/37, inputs #227, branch integration #229.

## 1. Суть
DEEP/web_discovery требует controlled acquisition, а не цитаты из snippets. Готовые raw/normalized admission и provider ports уже существуют; их надо соединить с ACQUIRE_AND_CAPTURE.

## 2. Что сделать
Candidate→разрешённый provider capture→immutable R2 bytes/metadata→existing normalized qualification/admission→новая manifest revision. Начальный case: разрешённая публичная HTML страница и её изменившаяся ревизия. corpus_only не выполняет эту ветвь.

## 3. Документация / grep
[Канон §7.9 и §19.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'A newly mentioned URL or identifier is an untrusted' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'uncaptured web result used as evidence' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Reuse source acquisition/admission contracts, R2 capture, immutable import и outbox; не создавать crawler/index service. Provider/route/disclosure выбираются из approved protocol/AllowedReferenceManifest, не из source instructions. До каждого fetch и redirect проверить допустимую destination; loopback/private/link-local/credentials-bearing targets и неподтверждённые redirects отказаны. При изменении content hash — новая SourceRevision, старая не мутирует. Source metadata/URL/timestamp/quality/provenance сохраняются, auth страницы/пустой/усечённый контент не становится admitted evidence. Expensive preprocessing checkpoint-ится существующим attempt и budget, unknown не повторяется вслепую. Новые источники после EvidenceFreeze требуют reopen, не скрытое расширение scope. Native page/region claims только с qualified map.

## 5. Критерии выполнения
Snippet/незахваченный URL не попадает в synthesis; captured bytes→admitted revision→exact citation реально проходят. Redirect/private target/prompt-injection/foreign namespace/partial provider outcome отказаны до canonical writes. Duplicate/lost response не создаёт двойной SourceRevision; изменённая страница сохраняет обе версии. Corpus-only делает0 network acquisition calls. HTTP/provider-control+D1/R2 chain tests, exact SHA; real provider qualification отдельно.
