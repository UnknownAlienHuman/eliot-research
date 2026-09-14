# S48 — DocumentMap/parent/neighbor приводят к точному месту источника

База a2aca127; ER-06/07/31/39. Normalized map и table-cell adapter уже есть; gap остаётся в native page/region/code и полном source-span navigation. Reuse existing navigation-expand-service и Evidence resolver.

## 1. Суть
Section preview — навигация, не доказательство исходной координаты. Нельзя приписывать page/line/region обычному Markdown без карты преобразования.

## 2. Что сделать
Завершить qualified coordinate-map adapters и structural expansion source→section→parent/neighbor→exact open/verify. Каждый поддержанный native anchor должен независимо отображаться в записанный normalized/source region. Неподдержанные precision kinds дают typed limitation с доступным exact normalized span.

## 3. Документация / grep
[Канон §6.7 и §19.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'resolves the native/normalized anchor through the recorded coordinate map' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Use imported qualified maps from existing bundle contracts; native processing stays with external producer, not PDF/OCR engine in Worker. Validate revision/map/offset/length/hash, UTF-8 versus codepoint units, table/line/page parent identities before/after R2 reads. Parent expansion не пересекает authorisation boundary, invalid neighbor not guessed. Map is immutable by source/parser generation; head changed cannot rebind old citation. UI target Evidence Rail uses resolved handle, not DOM position/preview text. Дописать missing adapters по одному типу внутри текущего package; общая карта/reader одна.

## 5. Критерии выполнения
RU emoji/CRLF/nested table/code/page fixtures reproduce exact source bytes and native anchors where maps supplied. Missing/corrupt/foreign/stale map refuses unsupported precision rather than useful normalized access. Unauthorized neighbor, mid-read purge/revoke и new head не дают подмены. Library→Lens→section→citation actual HTTP/D1/R2/browser test и SHA; native producer qualification отдельно.
