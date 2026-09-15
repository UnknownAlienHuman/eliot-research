# S87 — Rust family: federation fence/candidate/disposition

База a2aca127; ER-22/41/40. Target `eliotr-federation-core`; актуальный wire/execution path #252/#253 — reference. Независимый peer protocol не заменять внутренним Research DTO.

## 1. Суть
Transport COMPLETED не усиливает исследовательский результат. Проверка shared credentials/fence/manifest и candidate mapping остаётся обязательной независимо от языка реализации.

## 2. Что сделать
Перенести pure request admissibility, fence/bridge/reference-manifest compatibility и internal→wire completion mapping. HTTP signing/authentication, status storage, bundle streaming и foreign-provider invocation остаются TypeScript.

## 3. Документация / grep
[Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), [канон§11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'K4.federation fence/candidate mapping' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Как сделать
Existing versioned schemas и explicit verified principal/fence/bridge/grant/source refs; поля вне манифеста не разрешаются совпадением названий. Preserve native research disposition и unknowns, no stronger mapping. Peer result — untrusted candidate до canonical admission, нельзя превращать receipt JSON от клиента в proof исполнения. Отдельные W2 run/W3 model identities сохраняются, ложную SQL-находку аудита не «исправлять». Не добавлять клиентскую БД/ELIOT package/runtime RPC или обратные task-authority writes. Общий byte codec не использовать как единственный независимый wire oracle.

## 5. Критерии выполнения
- TS/native/Wasm outcomes/errors совпадают для approved/foreign/stale/unknown-version/manifest substitution и всех mappings dispositions.
- Transport COMPLETED/ACK не усиливает PARTIAL/INCONCLUSIVE/UNKNOWN, candidate не admitted автоматически.
- Mutation проверки fence или усиления disposition обнаруживается; independent client #253 продолжает работать.
- Pure Rust gates/fixtures/SHA, actual caller shadow/promotion в S89. Никакого нового federation service.
