from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


contract_path = Path("packages/cloudflare-ai/src/ai-search-provisioning-contract.ts")
contract = contract_path.read_text(encoding="utf-8")
contract = replace_once(
    contract,
    '''  readonly rewrite_query: false;
  readonly cache: false;
  readonly chunk_size: number;
''',
    '''  readonly rewrite_query: false;
  readonly cache: false;
  readonly chunk: true;
  readonly chunk_size: number;
''',
    "create request chunk field",
)
contract = replace_once(
    contract,
    '''    rewrite_query: false,
    cache: false,
    chunk_size: spec.chunk_size,
''',
    '''    rewrite_query: false,
    cache: false,
    chunk: true,
    chunk_size: spec.chunk_size,
''',
    "create request chunk policy",
)
contract_path.write_text(contract, encoding="utf-8")


orchestration_path = Path("packages/cloudflare-ai/src/ai-search-provisioning.ts")
orchestration = orchestration_path.read_text(encoding="utf-8")
orchestration = replace_once(
    orchestration,
    '''    !readback.enable ||
    readback.cache ||
    readback.rewrite_query ||
''',
    '''    !readback.enable ||
    !readback.chunk ||
    readback.cache ||
    readback.rewrite_query ||
''',
    "chunk readback policy",
)
orchestration = replace_once(
    orchestration,
    '      "AI Search instance enable, cache, rewrite, gateway, or score policy differs",\n',
    '      "AI Search instance enable, chunk, cache, rewrite, gateway, or score policy differs",\n',
    "chunk mismatch message",
)
orchestration_path.write_text(orchestration, encoding="utf-8")


test_path = Path("infra/ai-search/ai-search-provisioning.test.mjs")
test = test_path.read_text(encoding="utf-8")
test = replace_once(
    test,
    '''    cache: false,
    cache_threshold: "close_enough",
    cache_ttl: 172800,
''',
    '''    cache: false,
    cache_threshold: "close_enough",
    cache_ttl: 172800,
    chunk: true,
''',
    "runtime chunk fixture",
)
test = replace_once(
    test,
    '''    custom_metadata: metadata(),
    last_activity: timestamp,
''',
    '''    custom_metadata: metadata(),
    metadata: { created_from_aisearch_wizard: false },
    last_activity: timestamp,
''',
    "runtime metadata fixture",
)
test = replace_once(
    test,
    '''      rewrite_query: false,
      cache: false,
      chunk_size: 512,
''',
    '''      rewrite_query: false,
      cache: false,
      chunk: true,
      chunk_size: 512,
''',
    "create chunk assertion",
)
test = replace_once(
    test,
    '''      info({ rewrite_query: true }),
      info({ ai_gateway_id: "wrong-retrieval-gateway" }),
''',
    '''      info({ rewrite_query: true }),
      info({ chunk: false }),
      info({ ai_gateway_id: "wrong-retrieval-gateway" }),
''',
    "chunk mismatch negative",
)
test = replace_once(
    test,
    '''  it("strictly decodes standalone list and info fixtures", () => {
''',
    '''  it("normalizes the official paused and optional built-in source shape", () => {
    const runtimeShape = info({
      type: undefined,
      source: undefined,
      enable: undefined,
      paused: false,
      hybrid_search_enabled: true,
      created_by: "cloudflare",
      modified_by: "cloudflare",
      engine_version: 2,
    });
    expect(decodeAiSearchInstanceInfo(runtimeShape)).toMatchObject({
      type: null,
      source: null,
      enable: true,
      chunk: true,
    });
    const withoutPagination = listPage();
    delete withoutPagination.result_info;
    expect(decodeAiSearchInstanceListPage(withoutPagination, 1)).toMatchObject({
      total_count: 1,
    });
  });

  it("rejects contradictory compatibility fields and unbounded provider metadata", () => {
    expectSyncCode(
      () => decodeAiSearchInstanceInfo(info({ enable: true, paused: true })),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
    expectSyncCode(
      () => decodeAiSearchInstanceInfo(info({ hybrid_search_enabled: false })),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
    const oversizedMetadata = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]),
    );
    expectSyncCode(
      () => decodeAiSearchInstanceInfo(info({ metadata: oversizedMetadata })),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
  });

  it("strictly decodes standalone list and info fixtures", () => {
''',
    "runtime shape negative corpus",
)
test = replace_once(
    test,
    '''      score_threshold: AI_SEARCH_SCORE_THRESHOLD,
      custom_metadata: metadata(),
''',
    '''      score_threshold: AI_SEARCH_SCORE_THRESHOLD,
      chunk: true,
      custom_metadata: metadata(),
''',
    "standalone chunk assertion",
)
test_path.write_text(test, encoding="utf-8")


doc_path = Path("docs/agent-work/ER-16-ai-search-and-model-gateway-adapters.md")
doc = doc_path.read_text(encoding="utf-8")
doc = replace_once(
    doc,
    '''The provider contract was rechecked against the official Workers Binding and REST create schemas on
2026-09-03. The implementation pins the binding's `list`/`get`/`create` surface, the 64-character
instance-ID ceiling, the five custom-metadata slots, immutable embedding-model behavior and the REST
chunk-overlap ceiling rather than relying on undocumented defaults.
''',
    '''The provider contract was rechecked against the official Workers Binding, generated runtime types
and REST create schemas on 2026-09-03. The implementation pins the binding's `list`/`get`/`create`
surface, the 64-character instance-ID ceiling, the five custom-metadata slots, immutable embedding-model
behavior and the REST chunk-overlap ceiling rather than relying on undocumented defaults. Strict
readback accepts both documented `enable` and generated-runtime `paused` state, optional built-in
`type`/`source`, the compatibility `hybrid_search_enabled` flag, explicit chunk state and bounded
provider metadata; contradictory compatibility fields still fail closed.
''',
    "runtime shape documentation",
)
doc_path.write_text(doc, encoding="utf-8")
