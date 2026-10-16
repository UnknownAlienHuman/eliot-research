/** Native Items are upserts. Reconcile their immutable identity before a Queue replay. */
export async function ensureProjectSearchItem(
  items: Pick<AiSearchItems, "list" | "upload">,
  key: string,
  document: string,
  metadata: Readonly<Record<string, string>>,
): Promise<void> {
  const page = await items.list({ key, source: "builtin", per_page: 5 });
  if (!Array.isArray(page.result) || page.result.length > 1 ||
      (page.result_info?.total_count !== undefined && page.result_info.total_count > 1)) {
    throw new ProjectSearchItemError("PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID");
  }
  const existing = page.result[0];
  // No second upload after a lost acknowledgement: the native collection is
  // the readback authority. It also owns indexing progress and retries.
  const item = existing ?? await items.upload(key, new Blob([document], { type: "text/markdown" }), {
    metadata: { ...metadata },
  });
  if (typeof item.id !== "string" || item.id.length === 0 || item.key !== key) {
    throw new ProjectSearchItemError("PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID");
  }
  // Upload acknowledgements may omit retained metadata while indexing is in
  // progress. This is not a successful readback: submit the remaining pages and
  // verify all canonical metadata only after the native item is completed.
  if (item.status === "queued" || item.status === "running" || item.status === "outdated") {
    throw new ProjectSearchItemError("PROJECT_SEARCH_INDEX_PENDING");
  }
  if (item.status !== "completed") throw new ProjectSearchItemError("PROJECT_SEARCH_INDEX_FAILED");
  if (item.metadata === null || typeof item.metadata !== "object" ||
      Object.entries(metadata).some(([field, value]) => item.metadata?.[field] !== value)) {
    throw new ProjectSearchItemError("PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID");
  }
}

export class ProjectSearchItemError extends Error {
  constructor(readonly code: "PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID" | "PROJECT_SEARCH_INDEX_PENDING" | "PROJECT_SEARCH_INDEX_FAILED") {
    super(code);
    this.name = "ProjectSearchItemError";
  }
}
