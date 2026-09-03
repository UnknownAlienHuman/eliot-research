from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


generation_path = Path("packages/cloudflare-ai/src/ai-search-generation.ts")
generation = generation_path.read_text(encoding="utf-8")
generation = replace_once(
    generation,
    'import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";\n',
    'import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";\n'
    'import { assertCloudflareAiSearchInstanceProfile } from "./ai-search-profile.js";\n',
    "generation profile import",
)
generation = replace_once(
    generation,
    "const MAX_AI_SEARCH_METADATA_FIELDS = 64;",
    "const MAX_AI_SEARCH_METADATA_FIELDS = 5;",
    "generation metadata ceiling",
)
generation = replace_once(
    generation,
    '''function normalizedAiSearchProfile(
  profile: AiSearchInstanceProfile,
): Readonly<Record<string, unknown>> {
  boundedIdentifier(profile.id, "profile.id");
''',
    '''function normalizedAiSearchProfile(
  profile: AiSearchInstanceProfile,
): Readonly<Record<string, unknown>> {
  try {
    assertCloudflareAiSearchInstanceProfile(profile);
  } catch (cause) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      cause instanceof Error ? cause.message : "AI Search profile is invalid",
    );
  }
  boundedIdentifier(profile.id, "profile.id");
''',
    "generation strict profile validation",
)
generation = replace_once(
    generation,
    '''}

function profileFingerprint(profile: AiSearchInstanceProfile): string {
''',
    '''}

export function validateAiSearchInstanceProfile(
  profile: AiSearchInstanceProfile,
): void {
  void normalizedAiSearchProfile(profile);
}

function profileFingerprint(profile: AiSearchInstanceProfile): string {
''',
    "generation public validator",
)
generation_path.write_text(generation, encoding="utf-8")


generation_test_path = Path("infra/ai-search/ai-search-generation.test.mjs")
generation_test = generation_test_path.read_text(encoding="utf-8")
generation_test = replace_once(
    generation_test,
    '''import {
  AiSearchGenerationError,
''',
    '''import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AiSearchGenerationError,
''',
    "generation test metadata import",
)
generation_test = replace_once(
    generation_test,
    '''    metadata_fields: [
      "canonical_section_id",
      "content_sha256",
      "projection_generation",
      "source_revision_ref",
    ],
''',
    '''    metadata_fields: [...AI_SEARCH_CUSTOM_METADATA_FIELDS],
''',
    "generation canonical metadata fixture",
)
generation_test = replace_once(
    generation_test,
    '''    expectCode(
      () =>
        declareAiSearchGeneration([], {
          namespace: "eliotr-production",
          profile: profile({
            metadata_fields: ["source_revision_ref", "source_revision_ref"],
          }),
          expected_item_count: 2,
          declared_at: timestamp,
        }),
      "AI_SEARCH_PROFILE_INVALID",
    );
  });
''',
    '''    expectCode(
      () =>
        declareAiSearchGeneration([], {
          namespace: "eliotr-production",
          profile: profile({
            metadata_fields: ["source_revision_ref", "source_revision_ref"],
          }),
          expected_item_count: 2,
          declared_at: timestamp,
        }),
      "AI_SEARCH_PROFILE_INVALID",
    );
    expectCode(
      () =>
        declareAiSearchGeneration([], {
          namespace: "eliotr-production",
          profile: profile({ id: "Uppercase-Instance" }),
          expected_item_count: 2,
          declared_at: timestamp,
        }),
      "AI_SEARCH_PROFILE_INVALID",
    );
  });
''',
    "generation provider grammar negative",
)
generation_test_path.write_text(generation_test, encoding="utf-8")


provisioning_test_path = Path("infra/ai-search/ai-search-provisioning.test.mjs")
provisioning_test = provisioning_test_path.read_text(encoding="utf-8")
provisioning_test = replace_once(
    provisioning_test,
    'decodeAiSearchInstanceInfo(info(), "embedding-g2")',
    'decodeAiSearchInstanceInfo(info())',
    "provisioning decoder call",
)
provisioning_test_path.write_text(provisioning_test, encoding="utf-8")


doc_path = Path("docs/agent-work/ER-16-ai-search-and-model-gateway-adapters.md")
doc = doc_path.read_text(encoding="utf-8")
doc += '''

## Active implementation slice — namespace instance provisioning boundary

The `@eliotr/cloudflare-ai` package now exposes a narrow namespace port containing only `list`, `get`
and `create`; the provisioner has no `update` or `delete` capability. Before any provider mutation it
validates the real Cloudflare instance-ID grammar, the immutable vector/keyword/fusion profile, chunking,
and the exact five-field text metadata schema shared with projection upload and retrieval decoding.

Provisioning behavior is fail-closed:

- namespace listing is strictly decoded and bounded to 100 pages / 10,000 observed instances;
- duplicate IDs, unstable pagination totals, repeated pages and unknown response fields are rejected;
- an existing instance is accepted only after strict `info()` readback matches the desired built-in
  storage, embedding model, keyword/fusion settings, reranker, chunking, cache/rewrite policy and metadata;
- a missing instance is created once with cache and query rewriting disabled, then read back exactly;
- a lost create acknowledgement is reconciled through `get(id).info()` and produces
  `CREATE_RECONCILED` only on exact parity;
- an unresolved or mismatched post-create state produces `AI_SEARCH_PROVISIONING_CREATE_UNCERTAIN`;
- receipts bind canonical desired and observed configuration SHA-256 digests.

The executable corpus uses binding fixtures only. No namespace list, create, info, update, delete,
indexing, generation promotion or provider billing operation was executed against Cloudflare. Live
receipts and workload qualification remain `NOT EXECUTED`.
'''
doc_path.write_text(doc, encoding="utf-8")


readme_path = Path("packages/cloudflare-ai/README.md")
readme = readme_path.read_text(encoding="utf-8").rstrip()
readme += '''

The package contains deterministic immutable-generation governance and a narrow namespace-instance
provisioner. The provisioner can list, get, create and verify built-in instances, but intentionally owns
no update or delete capability and performs no implicit in-place reconfiguration.
'''
readme_path.write_text(readme + "\n", encoding="utf-8")
