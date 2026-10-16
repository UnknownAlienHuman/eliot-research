import { ChannelReadinessSchema, type ChannelReadiness } from "@eliotr/contracts";
import { PROJECT_SEARCH_INSTANCES, projectSearchFolderPrefix } from "@eliotr/cloudflare-ai/project-search";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";

interface ProjectSourceRow { readonly generation: number; readonly head_rev: string }
interface ProjectionRow {
  readonly item_key: string; readonly source_revision_ref: string; readonly canonical_section_id: string;
  readonly content_sha256: string; readonly instruction_taint: string; readonly projection_generation: string;
}
const MAX_ITEMS = 1024;

/** Native item readback for one owned project and admitted source. This never uploads or retries an effect. */
export async function readProjectSemanticReadiness(input: {
  readonly database: D1Database; readonly search_database: D1Database;
  readonly namespace: AiSearchNamespaceLike; readonly project_id: string;
  readonly source_id: string; readonly source_revision_ref: string;
  readonly principal_ref: string; readonly observed_at: string;
}): Promise<ChannelReadiness> {
  const channel = (state: ChannelReadiness["state"], reasons: readonly string[], proof?: string): ChannelReadiness =>
    ChannelReadinessSchema.parse({ source_revision_ref: input.source_revision_ref, channel: "semantic_ready", state,
      reason_codes: reasons, observed_at: input.observed_at,
      ...(proof === undefined ? {} : { generation: "project-search-v1", receipt_ref: proof }) });
  const projectSource = () => input.database.prepare(
    "SELECT p.generation,s.head_rev FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
    "JOIN project_source_membership m ON m.project_id=p.project_id AND m.source_id=?3 " +
    "JOIN source s ON s.source_id=m.source_id AND s.head_rev=?4 " +
    "WHERE p.project_id=?1 AND o.principal_ref=?2 AND m.membership_generation<=p.generation " +
    "AND julianday(m.valid_from)<=julianday(?5) " +
    "AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?5)) LIMIT 1",
  ).bind(input.project_id, input.principal_ref, input.source_id, input.source_revision_ref,
    new Date().toISOString()).first<ProjectSourceRow>();
  const before = await projectSource();
  if (before === null) throw new CatalogInputError("LIBRARY_PROJECT_NOT_FOUND", "Readable project source not found", 404);
  let readiness: ChannelReadiness;
  try {
    const rows = await input.search_database.prepare(
      "SELECT item_key,source_revision_ref,canonical_section_id,content_sha256,instruction_taint,projection_generation " +
      "FROM projection_item WHERE source_revision_ref=?1 AND active=1 ORDER BY item_key LIMIT ?2",
    ).bind(input.source_revision_ref, MAX_ITEMS + 1).all<ProjectionRow>();
    if (!rows.success || rows.results.length > MAX_ITEMS) throw new Error("Projection read is unavailable");
    if (rows.results.length === 0) readiness = channel("queued", ["PROJECT_SEARCH_SOURCE_NOT_READY"]);
    else {
    const prefix = await projectSearchFolderPrefix(input.project_id, "prose");
    const expected = new Map(rows.results.map(row => [`${prefix}${row.item_key}.md`, row]));
    const observed = new Map<string, AiSearchItemInfo>();
    const items = input.namespace.get(PROJECT_SEARCH_INSTANCES.prose).items;
    for (let page = 1; page <= Math.ceil(MAX_ITEMS / 50); page += 1) {
      const response = await items.list({ source: "builtin", per_page: 50, page,
        metadata_filter: JSON.stringify({ folder: { $gte: prefix, $lt: `${prefix.slice(0, -1)}0` },
          source_revision_ref: input.source_revision_ref.slice(0, 64) }) });
      if (!Array.isArray(response.result) || response.result.length > 50) throw new Error("Invalid native item page");
      for (const item of response.result) {
        if (!expected.has(item.key)) continue;
        if (observed.has(item.key)) throw new Error("Duplicate native item identity");
        observed.set(item.key, item);
      }
      const total = response.result_info?.total_count;
      if (response.result.length < 50 || (total !== undefined && page * 50 >= total)) break;
    }
    let pending = false, running = false, failed = false;
    for (const [key, row] of expected) {
      const item = observed.get(key);
      if (item === undefined) { pending = true; continue; }
      if (typeof item.id !== "string" || item.id.length === 0 || item.metadata === null ||
          typeof item.metadata !== "object" || Object.entries(row).some(([field, value]) =>
            field !== "item_key" && item.metadata?.[field] !== value)) {
        throw new Error("Native item metadata is not the current canonical section");
      }
      if (item.status === "running") running = true;
      else if (item.status === "queued" || item.status === "outdated") pending = true;
      else if (item.status !== "completed") failed = true;
    }
    if (failed) readiness = channel("failed", ["PROJECT_SEARCH_INDEX_FAILED"]);
    else if (running || pending) readiness = channel(running ? "running" : "queued", ["PROJECT_SEARCH_INDEX_PENDING"]);
    else {
      const bytes = new TextEncoder().encode(JSON.stringify([...observed.values()]
        .sort((a, b) => a.key.localeCompare(b.key)).map(item => ({ id: item.id, key: item.key, status: item.status, metadata: item.metadata }))));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const proof = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
      readiness = channel("ready", [], `native-items-readback:${proof}`);
    }
    }
  } catch {
    readiness = channel("degraded", ["PROJECT_SEARCH_READBACK_UNAVAILABLE"]);
  }
  const after = await projectSource();
  if (after === null || after.generation !== before.generation || after.head_rev !== before.head_rev) {
    throw new CatalogInputError("LIBRARY_PROJECT_CHANGED", "Project source changed while reading readiness", 409, true);
  }
  return readiness;
}
