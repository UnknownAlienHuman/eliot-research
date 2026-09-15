# S83 — Rust family: structural projection transforms

База a2aca127; ER-05/38/40. Target `eliotr-projection-core`. Вход — утверждённые нормализованные bytes/maps, not raw PDF. Принятые navigation/index cases #240/#244 сохраняются.

## 1. Суть
Deterministic segment/anchor/map transforms относятся к Rust kernel; управляемый поиск и запись проекций — к TS/Cloudflare. Перенос не должен создать встроенный search или parsing engine.

## 2. Что сделать
Перенести чистую structural segmentation, byte-range/coordinate-map validation и deterministic projection-item construction, используемые текущим projector. D1/R2/Queue/AI Search effects остаются существующими adapters.

## 3. Документация / grep
[Language ownership matrix](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'Structural projection algorithms' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```

## 4. Как сделать
Из existing projection/navigation builders выделить вход bytes+base offset+qualified map+generation и выход items/maps/typed gaps. При chunked input учитывать UTF-8 boundaries/overlap, не выдавать локальный offset за абсолютный. Для native coordinates отсутствие map остаётся unsupported precision; model coordinates не становятся verified. Reuse identity/canonical helpers #270, не добавлять tokenization/embedding/BM25 implementation. Item-set identity и channel activation проверяет прежний TS/D1 generation store. Никаких Cloudflare handles/файлов/clock в pure crate.

## 5. Критерии выполнения
- TS/native/Wasm item/map/ID bytes совпадают на prose/code/table/Unicode fixtures, включая chunk boundaries и reordered inputs.
- Corrupt map, invalid ranges/parent cycles/foreign revision и over-limit input отказаны; native precision не изобретается.
- Actual imported source→projector→exact locator regression #244 сохраняется; inactive/partial generation не serving.
- Property/mutation tests и Rust gates проходят; измерены bounded allocation/CPU, effects не продублированы. Runtime switch S89, exact SHA/results.
