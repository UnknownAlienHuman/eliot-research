# S39 / R07 — Cloudflare web discovery без скрытого повторного платного вызова

Проверено 2026-10-08; source baseline `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. Дополнение к #231, не runtime patch. Исходные S39 admission, capture и negative criteria сохраняются. Первый результат — одна разрешённая публичная страница до admitted revision и exact citation; не crawler всего Интернета.

## Читать и переиспользовать

- Архитектура Eliot §§7.9/19.3, ER-29 acquisition/admission; existing failure-model. Post-freeze additions идут через explicit reopen/revision.
- [Cloudflare Web Search binding](https://developers.cloudflare.com/web-search/how-to-use/), обновлено 2026-10-02: `env.AI.websearch({ gatewayId, query, provider, limit, byokAlias })` возвращает `Response`. Параметры provider/gateway/BYOK выбирает сервер, не модель.
- [First-party `createAIWebSearch` и `createHTTPWebSearch`](https://github.com/cloudflare/agents/blob/000d076d535b8bf53ac66b2c86c4c83c5a95d8c7/packages/agents/src/websearch/source.ts#L100-L189); [его `abortable`, `readResponse`, `toWebSearchResponse`](https://github.com/cloudflare/agents/blob/000d076d535b8bf53ac66b2c86c4c83c5a95d8c7/packages/agents/src/websearch/source.ts#L284-L380).
- [Eliot `createRawCaptureService`](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-raw-ingest/src/raw-capture-owner-service.ts), [admission composition](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-core/src/raw-normalized-admission.ts): `requireOwner`, `ownerPort`, `createRawNormalizedAdmissionService`, `readRawMarkdownCandidate`.

## Что брать у донора, что НЕ брать

Брать разделение `WebSearchSource`/request/call-options и host-owned provider, а не три provider SDK. Native `websearch` уже нормализует провайдеров; по умолчанию использовать непосредственно binding и существующие Eliot bounded readers. Добавлять весь Agents SDK только ради одной функции не требуется.

В прочитанном first-party wrapper имеются несовместимые с Eliot упрощения: `response.text()` не ограничен размером; неправильные элементы молча отбрасываются; missing provider query заменяется отправленным query; request ID — пустой строкой, latency — нулём. В Eliot такие defaults не становятся наблюдаемыми provider facts. `retryable: true` означает возможность успеха повтора, НЕ разрешение повторить оплаченный effect.

Binding не принимает AbortSignal. `abortable` прекращает ожидание, но не отменяет уже запущенный search. Различать pre-dispatch cancellation и post-dispatch unknown. Promise.race не является доказательством физической отмены или отсутствия списания.

## CODE — три checkpoint

### A. Один native discovery adapter

НОВЫЙ небольшой `packages/platform-cloudflare/src/web-search.ts` либо эквивалентный модуль в уже существующей платформенной capability; не новый пакет/сервис. В `apps/eliotr-core/src/env.ts`/composition дать только необходимый typed binding. Проверять его доступность до reservation/dispatch; не маскировать неподдержанный runtime кастом.

До вызова проверить corpus-only policy, полномочия, cancellation, лимит query 1–1024 и results 1–10, existing spend reservation. Сохранять отдельно raw user query и фактически отправленную нормализованную строку. Не обрезать запрос silently. Явный BYOK alias не должен переходить на gateway credits при ошибке конфигурации.

Использовать `readResponseBodyWithinBytes`/существующий bounded HTTP reader с deadline и корректной non-awaited cancellation из #321. Не создавать пятый stream-reader. Проверить status/envelope/cardinality, finite timing и поля locator. Malformed response — typed failure; частично допустимый ответ разрешать только явной versioned policy с omitted-item reasons, не скрытым drop. Missing provider metadata — UNKNOWN/отсутствующее поле согласно выбранному контракту, не ноль и не выдуманная query.

Привязать query identity, provider/gateway, generation, limits, scope и разрешённый dispatch к текущему attempt contract. После timeout сохранять unknown dispatch; default automatic retry/fallback отсутствует. Если response появляется поздно, bounded cleanup/readback не запускает второй search и не объявляет rollback.

### B. Выбранный locator → raw capture → conversion

Переиспользовать `createRawCaptureService`, текущий R2/residency namespace и `packages/cloudflare-markdown/src/markdown-conversion.ts`. НОВЫЙ `packages/cloudflare-raw-ingest/src/web-capture.ts` допустим как узкий adapter выбранного capture primitive. Search snippet не записывать как оригинальный source.

Первый путь — разрешённый public static response/negotiated Markdown. Browser Run — только если статического capture недостаточно и выбранный native API позволяет применить нужный egress policy. Не обещать SSRF-защиту всего browser/subresource графа по regex исходного hostname. Redirect chain, private/link-local/loopback destination, MIME/bytes, login/captcha/partial response и credential forwarding должны иметь explicit policy. Неподдержанную гарантию не имитировать: соответствующий режим остаётся закрыт.

Captured bytes/digest, final URL, capture time и converted bytes/digest — разные значения. Conversion не повышает precision до original PDF/page coordinates без карты. Не буферизовать корпус и не добавлять самостоятельный crawler/poller.

### C. Admission и reuse существующего source pipeline

`createRawNormalizedAdmissionService` и `ownerPort` уже вызывают `prepareBundle`, `uploadBundlePart`, `completeBundleFile`, `commitBundle`, `getBundleStatus`, `getBundleRecovery`. Соединить новый capture с этим путём; не писать второй commit/admission service.

`requireOwner` реально допускает только owner_pwa. Для первого среза agent discovery/capture остаётся candidate-only, owner подтверждает admission. Не подделывать owner context. Machine admission требует отдельного авторизованного существующего grant path; browser capability сама его не даёт.

После admission использовать S52/#244 projection и R02/#242 exact retrieval. Frozen scope не расширяется автоматически. Если запрос corpus-only — ноль Search/Browser вызовов даже при отсутствии результатов.

## DOCS / результат / ограничения

В existing acquisition packet и §§7.9/19.3 записать discovery != capture != conversion != admission != evidence, provider facts != defaults, cancelled waiting != cancelled remote effect. Внешний аудит v9–v11 дополнить границами first-party wrapper.

Результат: один query имеет честный outcome/cost provenance; выбранная страница проходит сохранение и admission до exact citation. Нет model-controlled providers, silent no-hit, второго source store или доверия snippets.

## Приёмка после assembly

Corpus-only/pre-cancel/unsupported runtime — zero calls. Late response после abort — не повторный search. Malformed items/missing metadata/oversized response — не fabricated successful provider facts. Foreign project, redirected private target, captcha, changed bytes, lost capture/admission ACK, revoked permission и post-freeze addition не обходят guards. Существующие negative/replay tests расширить, не заменять mock-only успехом.

Во время code-first реализации: scoped `tsc -b` platform-cloudflare/cloudflare-raw-ingest/cloudflare-markdown/core, scoped ESLint; при SQL `pnpm d1:depth`. Runtime/native/cost/quality проверки пока PENDING. #231 не зависит от нового NotebookProject v2, K2, Basin или переписывания UI. Shared env/composition правит один integrator. Нет новых обсуждений, deployment, платных probe, backup или повторного historical uncertain run.
