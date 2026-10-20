from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    found = text.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} matches, found {found}: {old[:100]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


# Server: retain an exact total while bounding detailed rows on the wire.
replace(
    "packages/cloudflare-navigation/src/source-revision-freshness.ts",
    "const SOURCE_PAGE_SIZE = 64;\n",
    "const SOURCE_PAGE_SIZE = 64;\nconst SOURCE_FRESHNESS_DETAIL_LIMIT = 64;\n",
)
replace(
    "packages/cloudflare-navigation/src/source-revision-freshness.ts",
    '''  readonly checked_at: string;
  readonly changed_sources: readonly {
''',
    '''  readonly checked_at: string;
  readonly changed_source_count: number;
  readonly changed_sources_truncated: boolean;
  readonly changed_sources: readonly {
''',
)
replace(
    "packages/cloudflare-navigation/src/source-revision-freshness.ts",
    '''  return {
    state: changedSources.length === 0 ? "CURRENT_REVISIONS" : "PREVIOUS_REVISIONS",
    checked_at: authorization.navigation.timestamp(),
    changed_sources: changedSources,
  };
''',
    '''  return {
    state: changedSources.length === 0 ? "CURRENT_REVISIONS" : "PREVIOUS_REVISIONS",
    checked_at: authorization.navigation.timestamp(),
    changed_source_count: changedSources.length,
    changed_sources_truncated: changedSources.length > SOURCE_FRESHNESS_DETAIL_LIMIT,
    changed_sources: changedSources.slice(0, SOURCE_FRESHNESS_DETAIL_LIMIT),
  };
''',
)

# Public server/client shapes.
replace(
    "packages/interfaces/src/semantic-api.ts",
    '''    readonly checked_at?: string;
    readonly changed_sources: readonly {
''',
    '''    readonly checked_at?: string;
    readonly changed_source_count: number;
    readonly changed_sources_truncated: boolean;
    readonly changed_sources: readonly {
''',
)
for path, interface_name in (
    ("packages/owner-api-client/src/studio/wiki-types.ts", "WikiSourceFreshness"),
    ("apps/eliotr-pwa/src/wiki-api.ts", "WikiSourceFreshness"),
    ("packages/owner-api-client/src/evidence/report/manifest.ts", "ResearchSourceFreshness"),
    ("packages/pwa-research-workspace/src/research-run-api.ts", "ResearchSourceFreshness"),
):
    replace(
        path,
        f'''export interface {interface_name} {{
  readonly state: ''',
        f'''export interface {interface_name} {{
  readonly state: ''',
    )
    replace(
        path,
        '''  readonly checked_at?: string;
  readonly changed_sources: readonly ''',
        '''  readonly checked_at?: string;
  readonly changed_source_count: number;
  readonly changed_sources_truncated: boolean;
  readonly changed_sources: readonly ''',
    )

# Strict Wiki decoder in the owner client.
replace(
    "packages/owner-api-client/src/studio/wiki-read.ts",
    '''const RISK_CLASSES: readonly WikiProposalRiskClass[] = [
  'D0_MECHANICAL', 'D1_LOW_RISK_ADDITIVE', 'D2_ANALYTICAL', 'D3_AUTHORITY_SENSITIVE',
];
''',
    '''const RISK_CLASSES: readonly WikiProposalRiskClass[] = [
  'D0_MECHANICAL', 'D1_LOW_RISK_ADDITIVE', 'D2_ANALYTICAL', 'D3_AUTHORITY_SENSITIVE',
];
const MAX_SOURCE_FRESHNESS_DETAILS = 64;
const MAX_SOURCE_FRESHNESS_COUNT = 4_096;
''',
)
replace(
    "packages/owner-api-client/src/studio/wiki-read.ts",
    '''  function sourceFreshness(value: unknown): WikiSourceFreshness {
    const data = record(value, ['state', 'changed_sources'], ['checked_at']);
    if (!Array.isArray(data.changed_sources) || data.changed_sources.length > 64) invalid('source_freshness.changed_sources is invalid');
    if (data.state === 'UNKNOWN') {
      if (Object.hasOwn(data, 'checked_at') || data.changed_sources.length !== 0) {
        invalid('unknown source freshness cannot claim an observation');
      }
      return { state: 'UNKNOWN', changed_sources: [] };
    }
    if (data.state !== 'CURRENT_REVISIONS' && data.state !== 'PREVIOUS_REVISIONS') invalid('source_freshness.state is invalid');
    const checkedAt = timestamp(data.checked_at, 'source_freshness.checked_at');
    const seen = new Set<string>();
    const changedSources = data.changed_sources.map((entry, index) => {
      const row = record(entry, ['source_id', 'saved_revision_ref', 'head_revision_ref']);
      const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
      const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
      const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
      if (seen.has(sourceId)) invalid('source_freshness.changed_sources contains duplicate sources');
      seen.add(sourceId);
      if (data.state === 'CURRENT_REVISIONS' && savedRevision !== headRevision) invalid('current source revisions do not match');
      if (data.state === 'PREVIOUS_REVISIONS' && savedRevision === headRevision) invalid('previous source revisions must differ');
      return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
    });
    if (data.state === 'CURRENT_REVISIONS' && changedSources.length !== 0) invalid('current source revisions must have no changed sources');
    if (data.state === 'PREVIOUS_REVISIONS' && changedSources.length === 0) invalid('previous source revisions must identify a changed source');
    return { state: data.state as WikiSourceFreshnessState, checked_at: checkedAt, changed_sources: changedSources };
  }
''',
    '''  function sourceFreshness(value: unknown): WikiSourceFreshness {
    const data = record(value,
      ['state', 'changed_source_count', 'changed_sources_truncated', 'changed_sources'], ['checked_at']);
    if (typeof data.changed_source_count !== 'number' || !Number.isSafeInteger(data.changed_source_count) ||
        data.changed_source_count < 0 || data.changed_source_count > MAX_SOURCE_FRESHNESS_COUNT ||
        typeof data.changed_sources_truncated !== 'boolean' || !Array.isArray(data.changed_sources) ||
        data.changed_sources.length > MAX_SOURCE_FRESHNESS_DETAILS ||
        data.changed_source_count < data.changed_sources.length ||
        data.changed_sources_truncated !== (data.changed_source_count > data.changed_sources.length)) {
      invalid('source_freshness summary is invalid');
    }
    const changedSourceCount = data.changed_source_count;
    const changedSourcesTruncated = data.changed_sources_truncated;
    if (data.state === 'UNKNOWN') {
      if (Object.hasOwn(data, 'checked_at') || changedSourceCount !== 0 || changedSourcesTruncated ||
          data.changed_sources.length !== 0) invalid('unknown source freshness cannot claim an observation');
      return { state: 'UNKNOWN', changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] };
    }
    if (data.state !== 'CURRENT_REVISIONS' && data.state !== 'PREVIOUS_REVISIONS') invalid('source_freshness.state is invalid');
    const checkedAt = timestamp(data.checked_at, 'source_freshness.checked_at');
    const seen = new Set<string>();
    const changedSources = data.changed_sources.map((entry, index) => {
      const row = record(entry, ['source_id', 'saved_revision_ref', 'head_revision_ref']);
      const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
      const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
      const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
      if (seen.has(sourceId)) invalid('source_freshness.changed_sources contains duplicate sources');
      seen.add(sourceId);
      if (data.state === 'CURRENT_REVISIONS' && savedRevision !== headRevision) invalid('current source revisions do not match');
      if (data.state === 'PREVIOUS_REVISIONS' && savedRevision === headRevision) invalid('previous source revisions must differ');
      return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
    });
    if (data.state === 'CURRENT_REVISIONS' && (changedSourceCount !== 0 || changedSourcesTruncated || changedSources.length !== 0)) {
      invalid('current source revisions must have no changed sources');
    }
    if (data.state === 'PREVIOUS_REVISIONS' && (changedSourceCount < 1 || changedSources.length < 1)) {
      invalid('previous source revisions must identify a changed source');
    }
    return { state: data.state as WikiSourceFreshnessState, checked_at: checkedAt,
      changed_source_count: changedSourceCount, changed_sources_truncated: changedSourcesTruncated,
      changed_sources: changedSources };
  }
''',
)
replace(
    "packages/owner-api-client/src/studio/wiki-read.ts",
    "{ state: 'UNKNOWN' as const, changed_sources: [] as const }",
    "{ state: 'UNKNOWN' as const, changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] as const }",
)

# Strict Wiki decoder in the retiring PWA client.
replace(
    "apps/eliotr-pwa/src/wiki-api.ts",
    '''const RISK_CLASSES: readonly WikiProposalRiskClass[] = [
  "D0_MECHANICAL", "D1_LOW_RISK_ADDITIVE", "D2_ANALYTICAL", "D3_AUTHORITY_SENSITIVE",
];
''',
    '''const RISK_CLASSES: readonly WikiProposalRiskClass[] = [
  "D0_MECHANICAL", "D1_LOW_RISK_ADDITIVE", "D2_ANALYTICAL", "D3_AUTHORITY_SENSITIVE",
];
const MAX_SOURCE_FRESHNESS_DETAILS = 64;
const MAX_SOURCE_FRESHNESS_COUNT = 4_096;
''',
)
replace(
    "apps/eliotr-pwa/src/wiki-api.ts",
    '''function sourceFreshness(value: unknown): WikiSourceFreshness {
  const data = record(value, ["state", "changed_sources"], ["checked_at"]);
  if (!Array.isArray(data.changed_sources) || data.changed_sources.length > 64) invalid("source_freshness.changed_sources is invalid");
  if (data.state === "UNKNOWN") {
    if (Object.hasOwn(data, "checked_at") || data.changed_sources.length !== 0) {
      invalid("unknown source freshness cannot claim an observation");
    }
    return { state: "UNKNOWN", changed_sources: [] };
  }
  if (data.state !== "CURRENT_REVISIONS" && data.state !== "PREVIOUS_REVISIONS") invalid("source_freshness.state is invalid");
  const checkedAt = timestamp(data.checked_at, "source_freshness.checked_at");
  const seen = new Set<string>();
  const changedSources = data.changed_sources.map((entry, index) => {
    const row = record(entry, ["source_id", "saved_revision_ref", "head_revision_ref"]);
    const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
    const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
    const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
    if (seen.has(sourceId)) invalid("source_freshness.changed_sources contains duplicate sources");
    seen.add(sourceId);
    if (data.state === "CURRENT_REVISIONS" && savedRevision !== headRevision) invalid("current source revisions do not match");
    if (data.state === "PREVIOUS_REVISIONS" && savedRevision === headRevision) invalid("previous source revisions must differ");
    return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
  });
  if (data.state === "CURRENT_REVISIONS" && changedSources.length !== 0) invalid("current source revisions must have no changed sources");
  if (data.state === "PREVIOUS_REVISIONS" && changedSources.length === 0) invalid("previous source revisions must identify a changed source");
  return { state: data.state, checked_at: checkedAt, changed_sources: changedSources };
}
''',
    '''function sourceFreshness(value: unknown): WikiSourceFreshness {
  const data = record(value,
    ["state", "changed_source_count", "changed_sources_truncated", "changed_sources"], ["checked_at"]);
  if (typeof data.changed_source_count !== "number" || !Number.isSafeInteger(data.changed_source_count) ||
      data.changed_source_count < 0 || data.changed_source_count > MAX_SOURCE_FRESHNESS_COUNT ||
      typeof data.changed_sources_truncated !== "boolean" || !Array.isArray(data.changed_sources) ||
      data.changed_sources.length > MAX_SOURCE_FRESHNESS_DETAILS ||
      data.changed_source_count < data.changed_sources.length ||
      data.changed_sources_truncated !== (data.changed_source_count > data.changed_sources.length)) {
    invalid("source_freshness summary is invalid");
  }
  const changedSourceCount = data.changed_source_count;
  const changedSourcesTruncated = data.changed_sources_truncated;
  if (data.state === "UNKNOWN") {
    if (Object.hasOwn(data, "checked_at") || changedSourceCount !== 0 || changedSourcesTruncated ||
        data.changed_sources.length !== 0) invalid("unknown source freshness cannot claim an observation");
    return { state: "UNKNOWN", changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] };
  }
  if (data.state !== "CURRENT_REVISIONS" && data.state !== "PREVIOUS_REVISIONS") invalid("source_freshness.state is invalid");
  const checkedAt = timestamp(data.checked_at, "source_freshness.checked_at");
  const seen = new Set<string>();
  const changedSources = data.changed_sources.map((entry, index) => {
    const row = record(entry, ["source_id", "saved_revision_ref", "head_revision_ref"]);
    const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
    const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
    const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
    if (seen.has(sourceId)) invalid("source_freshness.changed_sources contains duplicate sources");
    seen.add(sourceId);
    if (data.state === "CURRENT_REVISIONS" && savedRevision !== headRevision) invalid("current source revisions do not match");
    if (data.state === "PREVIOUS_REVISIONS" && savedRevision === headRevision) invalid("previous source revisions must differ");
    return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
  });
  if (data.state === "CURRENT_REVISIONS" && (changedSourceCount !== 0 || changedSourcesTruncated || changedSources.length !== 0)) {
    invalid("current source revisions must have no changed sources");
  }
  if (data.state === "PREVIOUS_REVISIONS" && (changedSourceCount < 1 || changedSources.length < 1)) {
    invalid("previous source revisions must identify a changed source");
  }
  return { state: data.state, checked_at: checkedAt, changed_source_count: changedSourceCount,
    changed_sources_truncated: changedSourcesTruncated, changed_sources: changedSources };
}
''',
)
replace(
    "apps/eliotr-pwa/src/wiki-api.ts",
    "{ state: \"UNKNOWN\" as const, changed_sources: [] as const }",
    "{ state: \"UNKNOWN\" as const, changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] as const }",
)

# Research report decoders share the same bounded summary contract.
for path, quote in (
    ("packages/owner-api-client/src/evidence/report/manifest.ts", "'"),
    ("packages/pwa-research-workspace/src/research-run-api.ts", '"'),
):
    old_const = "  const MAX_SOURCE_FRESHNESS_SOURCES = 64;" if quote == "'" else "const MAX_SOURCE_FRESHNESS_SOURCES = 64;"
    indent = "  " if quote == "'" else ""
    replace(path, old_const,
        f"{indent}const MAX_SOURCE_FRESHNESS_DETAILS = 64;\n{indent}const MAX_SOURCE_FRESHNESS_COUNT = 4_096;")

replace(
    "packages/owner-api-client/src/evidence/report/manifest.ts",
    '''  const sourceFreshness = (value: unknown): ResearchSourceFreshness => {
    const data = record(value, ['state', 'checked_at', 'changed_sources']);
    if (data.state !== 'CURRENT_REVISIONS' && data.state !== 'PREVIOUS_REVISIONS') {
      invalid('source_freshness.state is invalid');
    }
    const checkedAt = isoTimestamp(data.checked_at, 'source_freshness.checked_at');
    if (!Array.isArray(data.changed_sources) || data.changed_sources.length > MAX_SOURCE_FRESHNESS_SOURCES) {
      invalid('source_freshness.changed_sources is invalid');
    }
    const seen = new Set<string>();
    const changedSources = (data.changed_sources as unknown[]).map((item: unknown, index: number) => {
      const row = record(item, ['source_id', 'saved_revision_ref', 'head_revision_ref']);
      const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
      const savedRevision = identifier(
        row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
      const headRevision = identifier(
        row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
      if (seen.has(sourceId)) invalid('source_freshness.changed_sources contains duplicate sources');
      seen.add(sourceId);
      if (data.state === 'CURRENT_REVISIONS' && savedRevision !== headRevision) {
        invalid('current source revisions do not match');
      }
      if (data.state === 'PREVIOUS_REVISIONS' && savedRevision === headRevision) {
        invalid('previous source revisions must differ');
      }
      return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
    });
    if (data.state === 'CURRENT_REVISIONS' && changedSources.length !== 0) {
      invalid('current source revisions must have no changed sources');
    }
    if (data.state === 'PREVIOUS_REVISIONS' && changedSources.length === 0) {
      invalid('previous source revisions must identify a changed source');
    }
    return { state: data.state as ResearchSourceFreshnessState, checked_at: checkedAt, changed_sources: changedSources };
  };
''',
    '''  const sourceFreshness = (value: unknown): ResearchSourceFreshness => {
    const data = record(value,
      ['state', 'checked_at', 'changed_source_count', 'changed_sources_truncated', 'changed_sources']);
    if (data.state !== 'CURRENT_REVISIONS' && data.state !== 'PREVIOUS_REVISIONS' ||
        typeof data.changed_source_count !== 'number' || !Number.isSafeInteger(data.changed_source_count) ||
        data.changed_source_count < 0 || data.changed_source_count > MAX_SOURCE_FRESHNESS_COUNT ||
        typeof data.changed_sources_truncated !== 'boolean' || !Array.isArray(data.changed_sources) ||
        data.changed_sources.length > MAX_SOURCE_FRESHNESS_DETAILS ||
        data.changed_source_count < data.changed_sources.length ||
        data.changed_sources_truncated !== (data.changed_source_count > data.changed_sources.length)) {
      invalid('source_freshness summary is invalid');
    }
    const checkedAt = isoTimestamp(data.checked_at, 'source_freshness.checked_at');
    const changedSourceCount = data.changed_source_count;
    const changedSourcesTruncated = data.changed_sources_truncated;
    const seen = new Set<string>();
    const changedSources = (data.changed_sources as unknown[]).map((item: unknown, index: number) => {
      const row = record(item, ['source_id', 'saved_revision_ref', 'head_revision_ref']);
      const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
      const savedRevision = identifier(
        row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
      const headRevision = identifier(
        row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
      if (seen.has(sourceId)) invalid('source_freshness.changed_sources contains duplicate sources');
      seen.add(sourceId);
      if (data.state === 'CURRENT_REVISIONS' && savedRevision !== headRevision) {
        invalid('current source revisions do not match');
      }
      if (data.state === 'PREVIOUS_REVISIONS' && savedRevision === headRevision) {
        invalid('previous source revisions must differ');
      }
      return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
    });
    if (data.state === 'CURRENT_REVISIONS' && (changedSourceCount !== 0 || changedSourcesTruncated || changedSources.length !== 0)) {
      invalid('current source revisions must have no changed sources');
    }
    if (data.state === 'PREVIOUS_REVISIONS' && (changedSourceCount < 1 || changedSources.length < 1)) {
      invalid('previous source revisions must identify a changed source');
    }
    return { state: data.state as ResearchSourceFreshnessState, checked_at: checkedAt,
      changed_source_count: changedSourceCount, changed_sources_truncated: changedSourcesTruncated,
      changed_sources: changedSources };
  };
''',
)
replace(
    "packages/owner-api-client/src/evidence/report/manifest.ts",
    "{ state: 'UNKNOWN' as const, changed_sources: [] as const }",
    "{ state: 'UNKNOWN' as const, changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] as const }",
)
replace(
    "packages/pwa-research-workspace/src/research-run-api.ts",
    '''function sourceFreshness(value: unknown): ResearchSourceFreshness {
  const data = record(value, ["state", "checked_at", "changed_sources"]);
  if (data.state !== "CURRENT_REVISIONS" && data.state !== "PREVIOUS_REVISIONS") invalid("source_freshness.state is invalid");
  const checkedAt = isoTimestamp(data.checked_at, "source_freshness.checked_at");
  if (!Array.isArray(data.changed_sources) || data.changed_sources.length > MAX_SOURCE_FRESHNESS_SOURCES) invalid("source_freshness.changed_sources is invalid");
  const seen = new Set<string>();
  const changedSources = data.changed_sources.map((value, index) => {
    const row = record(value, ["source_id", "saved_revision_ref", "head_revision_ref"]);
    const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
    const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
    const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
    if (seen.has(sourceId)) invalid("source_freshness.changed_sources contains duplicate sources");
    seen.add(sourceId);
    if (data.state === "CURRENT_REVISIONS" && savedRevision !== headRevision) invalid("current source revisions do not match");
    if (data.state === "PREVIOUS_REVISIONS" && savedRevision === headRevision) invalid("previous source revisions must differ");
    return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
  });
  if (data.state === "CURRENT_REVISIONS" && changedSources.length !== 0) invalid("current source revisions must have no changed sources");
  if (data.state === "PREVIOUS_REVISIONS" && changedSources.length === 0) invalid("previous source revisions must identify a changed source");
  return { state: data.state, checked_at: checkedAt, changed_sources: changedSources };
}
''',
    '''function sourceFreshness(value: unknown): ResearchSourceFreshness {
  const data = record(value,
    ["state", "checked_at", "changed_source_count", "changed_sources_truncated", "changed_sources"]);
  if (data.state !== "CURRENT_REVISIONS" && data.state !== "PREVIOUS_REVISIONS" ||
      typeof data.changed_source_count !== "number" || !Number.isSafeInteger(data.changed_source_count) ||
      data.changed_source_count < 0 || data.changed_source_count > MAX_SOURCE_FRESHNESS_COUNT ||
      typeof data.changed_sources_truncated !== "boolean" || !Array.isArray(data.changed_sources) ||
      data.changed_sources.length > MAX_SOURCE_FRESHNESS_DETAILS ||
      data.changed_source_count < data.changed_sources.length ||
      data.changed_sources_truncated !== (data.changed_source_count > data.changed_sources.length)) {
    invalid("source_freshness summary is invalid");
  }
  const checkedAt = isoTimestamp(data.checked_at, "source_freshness.checked_at");
  const changedSourceCount = data.changed_source_count;
  const changedSourcesTruncated = data.changed_sources_truncated;
  const seen = new Set<string>();
  const changedSources = data.changed_sources.map((value, index) => {
    const row = record(value, ["source_id", "saved_revision_ref", "head_revision_ref"]);
    const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
    const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
    const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
    if (seen.has(sourceId)) invalid("source_freshness.changed_sources contains duplicate sources");
    seen.add(sourceId);
    if (data.state === "CURRENT_REVISIONS" && savedRevision !== headRevision) invalid("current source revisions do not match");
    if (data.state === "PREVIOUS_REVISIONS" && savedRevision === headRevision) invalid("previous source revisions must differ");
    return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
  });
  if (data.state === "CURRENT_REVISIONS" && (changedSourceCount !== 0 || changedSourcesTruncated || changedSources.length !== 0)) {
    invalid("current source revisions must have no changed sources");
  }
  if (data.state === "PREVIOUS_REVISIONS" && (changedSourceCount < 1 || changedSources.length < 1)) {
    invalid("previous source revisions must identify a changed source");
  }
  return { state: data.state, checked_at: checkedAt, changed_source_count: changedSourceCount,
    changed_sources_truncated: changedSourcesTruncated, changed_sources: changedSources };
}
''',
)
replace(
    "packages/pwa-research-workspace/src/research-run-api.ts",
    "{ state: \"UNKNOWN\" as const, changed_sources: [] as const }",
    "{ state: \"UNKNOWN\" as const, changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] as const }",
)

# Server's direct UNKNOWN Wiki read.
replace(
    "packages/cloudflare-wiki/src/wiki-service.ts",
    'source_freshness: { state: "UNKNOWN", changed_sources: [] },',
    'source_freshness: { state: "UNKNOWN", changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] },',
)

# Current and legacy presentation surfaces expose the exact total and partial-detail status.
replace(
    "packages/ui/src/features/studio/StudioFeature.tsx",
    '''  readonly changed_source: string;
  readonly saved_revision: string;
''',
    '''  readonly changed_source: string;
  readonly changed_source_count: string;
  readonly changed_source_sample: string;
  readonly saved_revision: string;
''',
)
replace(
    "packages/ui/src/features/studio/StudioFeature.tsx",
    '''      <ul className="er-studio-live__changes">
        {freshness.changed_sources.map((change) => (
''',
    '''      <p>{copy.changed_source_count}: {freshness.changed_source_count}.</p>
      {freshness.changed_sources_truncated ? (
        <p>{copy.changed_source_sample}: {freshness.changed_sources.length}.</p>
      ) : null}
      <ul className="er-studio-live__changes">
        {freshness.changed_sources.map((change) => (
''',
)
replace(
    "packages/ui/src/features/studio/StudioFeature.tsx",
    '''  changed_source: "The revision each source had when this page was written, next to the current one.",
  saved_revision: "Saved revision",
''',
    '''  changed_source: "The revision each source had when this page was written, next to the current one.",
  changed_source_count: "Changed sources",
  changed_source_sample: "Detailed rows shown",
  saved_revision: "Saved revision",
''',
)
replace(
    "packages/ui/src/features/studio/StudioFeature.tsx",
    '''  changed_source: "Версия каждого источника на момент написания страницы рядом с текущей.",
  saved_revision: "Сохранённая версия",
''',
    '''  changed_source: "Версия каждого источника на момент написания страницы рядом с текущей.",
  changed_source_count: "Изменённых источников",
  changed_source_sample: "Показано подробных строк",
  saved_revision: "Сохранённая версия",
''',
)
replace(
    "apps/eliotr-pwa/src/wiki-panel.ts",
    '''  add("Source freshness", freshness.state);
  add("Freshness checked", freshness.checked_at ?? "not recorded");
  const term = document.createElement("dt"); term.textContent = "Changed sources";
''',
    '''  add("Source freshness", freshness.state);
  add("Freshness checked", freshness.checked_at ?? "not recorded");
  add("Changed source count", String(freshness.changed_source_count));
  if (freshness.changed_sources_truncated) {
    add("Changed source details", `Showing first ${String(freshness.changed_sources.length)} of ${String(freshness.changed_source_count)}`);
  }
  const term = document.createElement("dt"); term.textContent = "Changed source details";
''',
)
replace(
    "packages/pwa-research-workspace/src/research-run-view.ts",
    '''  add("Source freshness", freshness.state);
  add("Freshness checked", freshness.checked_at ?? "not recorded");
  add("Changed sources", freshness.changed_sources.length === 0
''',
    '''  add("Source freshness", freshness.state);
  add("Freshness checked", freshness.checked_at ?? "not recorded");
  add("Changed source count", String(freshness.changed_source_count));
  if (freshness.changed_sources_truncated) {
    add("Changed source details", `Showing first ${String(freshness.changed_sources.length)} of ${String(freshness.changed_source_count)}`);
  }
  add("Changed source details", freshness.changed_sources.length === 0
''',
)

# Typed fixtures most frequently reused by the current React path.
for path in (
    "apps/eliotr-web/src/app/InboxStudioSelectionRegression.stories.tsx",
    "apps/eliotr-web/src/query/studio.test.ts",
):
    replace(path,
        'source_freshness: { state: "CURRENT_REVISIONS", checked_at: stamp, changed_sources: [] },',
        'source_freshness: { state: "CURRENT_REVISIONS", checked_at: stamp, changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] },')

# Common single-line UNKNOWN fixtures in strict decoder tests.
for path in (
    "packages/owner-api-client/src/studio/wiki-read.test.ts",
    "apps/eliotr-core/test/wiki-service.test.ts",
):
    text = Path(path).read_text(encoding="utf-8")
    text = text.replace(
        "source_freshness: { state: 'UNKNOWN', changed_sources: [] },",
        "source_freshness: { state: 'UNKNOWN', changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] },",
    ).replace(
        'source_freshness: { state: "UNKNOWN", changed_sources: [] },',
        'source_freshness: { state: "UNKNOWN", changed_source_count: 0, changed_sources_truncated: false, changed_sources: [] },',
    )
    Path(path).write_text(text, encoding="utf-8")
