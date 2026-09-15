# S88 — настоящий product ABI и M5 differential shadow

База a2aca127; ER-40/24/00. Текущий kernel-wasm экспортирует только CI self-tests, это не product ABI. Можно начать с готовой canonical identity family, не ждать все S79–S87.

## 1. Суть
Нужен реальный caller из TypeScript Worker в portable deterministic kernel. Embedded-vector success не доказывает runtime marshalling, memory bounds и отсутствие двойных эффектов.

## 2. Что сделать
В existing kernel shell добавить canonical UTF-8 byte-in/byte-out ABI и один общий TS adapter. Сначала shadow без смены production owner; сравнивать решения на одних observed facts, side effects выполнять только один раз после принятия решения.

## 3. Документация / grep
[Language§6/§8.3/§10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F '## 6. TypeScript ↔ Rust/Wasm ABI' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```
[Cloudflare Rust/Wasm glue](https://developers.cloudflare.com/workers/languages/rust/), проверено2026-09-14: импорт .wasm даёт precompiled Module; generated glue надо инициализировать соответствующим образом, а не fetch/compile arbitrary bytes.

## 4. Как сделать
Выбран путь: wasm-bindgen byte-array boundary (`&[u8]`→`Vec<u8>`) в shell, generated glue над precompiled module в existing TS Worker; не миграция Worker в workers-rs. Закрепить согласованные crate/CLI версии в существующем toolchain/lock, не auto-download latest при запуске. Разрешённые product exports — ровно named exports §6.3; domain families направляются через existing versioned operation envelope. Новая product export требует нормативного изменения, технические memory/glue exports не считать domain API. Перед allocation валидировать protocol/version/digest/size, после вызова — output bounds/schema/digest; mutable pointers/Cloudflare objects не пересекают boundary. Вызов синхронный на immutable input, trap инвалидирует instance и текущую операцию, не запускает permissive fallback. Mismatch записывается content-free и блокирует соответствующую mutation; TS остаётся reference до S89. Не держать второй набор source bytes в global cache.

## 5. Критерии выполнения
- Actual workerd вызывает compiled Wasm на runtime input, не только embedded tests; native/TS/Wasm совпадают по result/error/bytes.
- Invalid version/digest/size/truncation/trap/repeated invocation не утекли/не corrupt-ят следующую операцию; память ограничена и освобождается.
- Shadow не удваивает model/network/D1 effects, mismatch не публикует authoritative output.
- Измерены compressed Wasm+glue, startup/heap и p50/p95 CPU against TS; нет второго Worker/RPC. Existing Rust/Worker gates и exact SHA, performance/rollback входы для S89.
