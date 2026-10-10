# S83 — Port structural projection transforms to Rust

Baseline `a2aca127`; ER-05/38/40. Target eliotr-projection-core. Inputs are admitted normalized bytes and qualified maps, not raw PDF. Preserve accepted navigation/index behavior from #240/#244.

## 1. Problem

Deterministic segmentation and coordinate transforms belong in the kernel; managed searching and projection effects remain in TS/Cloudflare. Migration must not introduce an embedded search or document-parsing engine.

## 2. Required change

Port pure structural segmentation, byte-range/coordinate-map validation, and deterministic projection-item construction used by the current projector. Leave D1/R2/Queue/AI Search effects in existing adapters.

## 3. Documentation and exact search anchors

[Language ownership matrix](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'Structural projection algorithms' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```

## 4. Implementation approach

Extract bounded inputs of bytes, base offset, qualified map, and generation from existing builders; return items/maps/typed gaps. Handle UTF-8 boundaries and overlap correctly for chunked input. Local chunk offsets must not become absolute source offsets by accident.

Missing native-coordinate maps retain an explicit precision limitation; model-generated coordinates are not verified observations. Reuse S78 canonical/identity primitives. Do not add tokenizer, embedding, or BM25 implementations. Existing TS/D1 generation stores still validate item-set identity and channel activation. Pure crates receive no platform handles, files, or hidden clock.

## 5. Acceptance criteria

- [ ] TS/native/Wasm agree on item/map/ID bytes for prose, code, tables, Unicode, chunk boundaries, and reordered inputs.
- [ ] Corrupt maps, invalid ranges, parent cycles, foreign revisions, and oversized inputs fail without fabricated precision.
- [ ] Actual import→projector→exact-locator regressions remain correct; inactive or incomplete generations never serve as complete.
- [ ] Property/mutation checks and applicable Rust gates pass; allocation/CPU are measured and effects are not duplicated.
- [ ] Record exact SHA and results. Actual runtime switching is S89, not implied by pure-code tests.
