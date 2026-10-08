import {
  AtlasNodeSchema,
  DocumentMapRevisionSchema,
  EvidenceHandleSchema,
  IdentifierSchema,
  ScopeSnapshotSchema,
  SourceCardSchema,
  VersionedRefSchema,
  type DocumentMapRevision,
  type EvidenceHandle,
  type ProjectAtlasRevision,
  type ScopeSnapshot,
  type SourceCard,
  type VersionedRef,
} from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";
import { readOrientationScope, type OrientationView } from "./orientation-api.js";

const MAX_SOURCE_REFS = 4096;
const MAX_SECTIONS = 4096;
const MAX_METADATA_DEPTH = 16;
const MAX_METADATA_NODES = 16_384;
const FORBIDDEN_METADATA_KEYS = new Set([
  "authorization_receipt_ref", "citation_resolution_receipt", "counterevidence_handles",
  "evidence_handle", "evidence_resolution_receipt", "exact_support_handles",
  "publication_eligible", "resolved_evidence", "verification_receipt_ref",
]);

export type NavigationExpansionTarget =
  | { readonly kind: "ATLAS_NODE"; readonly projectRef: VersionedRef; readonly nodeId: string }
  | { readonly kind: "SOURCE_CARD"; readonly sourceRevisionRef: string }
  | { readonly kind: "DOCUMENT_MAP"; readonly sourceRevisionRef: string }
  | { readonly kind: "SECTION"; readonly sourceRevisionRef: string; readonly sectionRef: string };

export interface NavigationSection {
  readonly section_ref: string;
  readonly source_revision_ref: string;
  readonly label: string;
  readonly parent_section_ref?: string;
  readonly normalized_start_byte?: number;
  readonly normalized_end_byte?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface NavigationOnlySupport {
  readonly kind: "NAVIGATION_ONLY";
  readonly publication_eligible: false;
  readonly reason_code: string;
}

export interface EvidenceHandleCandidateSupport {
  readonly kind: "EVIDENCE_HANDLE_CANDIDATE";
  readonly publication_eligible: false;
  readonly reason_code: "EXACT_EVIDENCE_RESOLUTION_REQUIRED";
  readonly handle_ref: VersionedRef;
}

export type NavigationSupport = NavigationOnlySupport | EvidenceHandleCandidateSupport;

export type NavigationExpansionResult =
  | {
    readonly kind: "ATLAS_NODE";
    readonly atlas_ref: VersionedRef;
    readonly node: ProjectAtlasRevision["nodes"][number];
    readonly source_cards: readonly SourceCard[];
    readonly source_revision_refs: readonly string[];
    readonly support: NavigationOnlySupport;
  }
  | {
    readonly kind: "SOURCE_CARD";
    readonly source_card: SourceCard;
    readonly document_map_ref?: VersionedRef;
    readonly support: NavigationOnlySupport;
  }
  | {
    readonly kind: "DOCUMENT_MAP";
    readonly source_card: SourceCard;
    readonly document_map: DocumentMapRevision;
    readonly sections: readonly NavigationSection[];
    readonly support: NavigationOnlySupport;
  }
  | {
    readonly kind: "SECTION";
    readonly document_map_ref: VersionedRef;
    readonly section: NavigationSection;
    readonly evidence_handle?: EvidenceHandle;
    readonly support: NavigationSupport;
  };

function mismatch(message = "Invalid Corpus Lens expansion response"): never {
  throw new ApiRequestError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message });
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) mismatch();
  const allowed = new Set([...required, ...optional]);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(object, key))) mismatch();
  return object;
}

function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) mismatch();
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success || parsed.data !== parsed.data.trim()) mismatch(`${label} is invalid`);
  return parsed.data;
}

function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) mismatch(`${label} is invalid`);
  return value;
}

function ref(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) mismatch(`${label} is invalid`);
  return parsed.data;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function scopeRef(scope: ScopeSnapshot): VersionedRef {
  return { id: scope.snapshot_id, revision: scope.revision };
}

function parseScope(value: unknown): ScopeSnapshot {
  const parsed = ScopeSnapshotSchema.safeParse(value);
  if (!parsed.success) mismatch("scope snapshot is invalid");
  const members = parsed.data.member_source_revision_refs;
  if (new Set(members).size !== members.length || members.some((member, index) =>
    member !== [...members].sort()[index])) mismatch("scope snapshot members are not canonical");
  return parsed.data;
}

function parseMetadata(value: unknown): Readonly<Record<string, unknown>> {
  const counters = { nodes: 0 };
  const walk = (candidate: unknown, depth: number): void => {
    counters.nodes += 1;
    if (depth > MAX_METADATA_DEPTH || counters.nodes > MAX_METADATA_NODES) mismatch("navigation metadata exceeds its bounds");
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) mismatch("navigation metadata contains an invalid number");
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_SECTIONS) mismatch("navigation metadata array exceeds its bounds");
      candidate.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (typeof candidate !== "object") mismatch("navigation metadata is not JSON");
    for (const [key, item] of Object.entries(candidate)) {
      if (FORBIDDEN_METADATA_KEYS.has(key)) mismatch("navigation metadata carries evidence authority");
      walk(item, depth + 1);
    }
  };
  walk(value, 0);
  if (value === null || typeof value !== "object" || Array.isArray(value)) mismatch("navigation metadata is not an object");
  return value as Readonly<Record<string, unknown>>;
}

function parseSection(value: unknown, sourceRevisionRef: string): NavigationSection {
  const row = record(value, ["section_ref", "source_revision_ref", "label", "metadata"],
    ["parent_section_ref", "normalized_start_byte", "normalized_end_byte"]);
  const source = identifier(row.source_revision_ref, "section source_revision_ref");
  if (source !== sourceRevisionRef) mismatch("section source revision does not match the requested source");
  const startPresent = Object.hasOwn(row, "normalized_start_byte");
  const endPresent = Object.hasOwn(row, "normalized_end_byte");
  if (startPresent !== endPresent) mismatch("section byte range is incomplete");
  let start: number | undefined;
  let end: number | undefined;
  if (startPresent) {
    if (!Number.isSafeInteger(row.normalized_start_byte) || !Number.isSafeInteger(row.normalized_end_byte) ||
        Number(row.normalized_start_byte) < 0 || Number(row.normalized_end_byte) <= Number(row.normalized_start_byte)) {
      mismatch("section byte range is invalid");
    }
    start = Number(row.normalized_start_byte); end = Number(row.normalized_end_byte);
  }
  const parent = Object.hasOwn(row, "parent_section_ref")
    ? identifier(row.parent_section_ref, "section parent_section_ref") : undefined;
  return {
    section_ref: identifier(row.section_ref, "section_ref"),
    source_revision_ref: source,
    label: text(row.label, "section label"),
    ...(parent === undefined ? {} : { parent_section_ref: parent }),
    ...(start === undefined || end === undefined ? {} : { normalized_start_byte: start, normalized_end_byte: end }),
    metadata: parseMetadata(row.metadata),
  };
}

function parseSourceCard(value: unknown, expectedSourceRevisionRef?: string): SourceCard {
  const parsed = SourceCardSchema.safeParse(value);
  if (!parsed.success || (expectedSourceRevisionRef !== undefined && parsed.data.source_revision_ref !== expectedSourceRevisionRef)) {
    mismatch("source card is invalid or points to another source");
  }
  return parsed.data;
}

function parseSupport(value: unknown, handle?: EvidenceHandle): NavigationSupport {
  const kind = record(value, ["kind"], ["publication_eligible", "reason_code", "handle_ref"]).kind;
  if (kind === "NAVIGATION_ONLY") {
    const row = record(value, ["kind", "publication_eligible", "reason_code"]);
    if (row.publication_eligible !== false) mismatch("navigation support is publication eligible");
    return { kind, publication_eligible: false, reason_code: text(row.reason_code, "support reason") };
  }
  if (kind === "EVIDENCE_HANDLE_CANDIDATE") {
    const row = record(value, ["kind", "publication_eligible", "reason_code", "handle_ref"]);
    if (row.publication_eligible !== false || row.reason_code !== "EXACT_EVIDENCE_RESOLUTION_REQUIRED") mismatch("evidence candidate support is invalid");
    const handleRef = ref(row.handle_ref, "support handle_ref");
    if (handle === undefined || !sameRef(handle.handle_ref, handleRef)) mismatch("support handle does not match evidence candidate");
    return { kind, publication_eligible: false, reason_code: "EXACT_EVIDENCE_RESOLUTION_REQUIRED", handle_ref: handleRef };
  }
  mismatch("navigation support kind is invalid");
}

function parseExpansionData(value: unknown, scope: ScopeSnapshot, target?: NavigationExpansionTarget): NavigationExpansionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).kind !== "string") {
    mismatch("expansion result kind is invalid");
  }
  const data = value as Record<string, unknown>;
  const targetScope = scopeRef(scope);
  if (data.kind === "ATLAS_NODE") {
    const row = record(value, ["kind", "atlas_ref", "node", "source_cards", "source_revision_refs", "support"]);
    if (target?.kind !== undefined && target.kind !== "ATLAS_NODE") mismatch("expansion kind does not match request");
    const node = AtlasNodeSchema.safeParse(row.node);
    if (!node.success) mismatch("atlas node is invalid");
    const annotations = parseMetadata(node.data.annotations);
    if (annotations.navigation_authority !== "NAVIGATION_ONLY") mismatch("atlas node is not navigation-only");
    if (target?.kind === "ATLAS_NODE" && node.data.node_id !== target.nodeId) {
      mismatch("atlas node does not match request");
    }
    const sourceRefs = boundedArray(row.source_revision_refs, MAX_SOURCE_REFS).map((item) => identifier(item, "source revision ref"));
    if (new Set(sourceRefs).size !== sourceRefs.length) mismatch("atlas source refs are duplicated");
    const cards = boundedArray(row.source_cards, MAX_SOURCE_REFS).map((item) => parseSourceCard(item));
    if (cards.some((card) => !sourceRefs.includes(card.source_revision_ref))) mismatch("atlas card is outside source refs");
    const support = parseSupport(row.support);
    if (support.kind !== "NAVIGATION_ONLY") mismatch("atlas support is not navigation-only");
    return { kind: "ATLAS_NODE", atlas_ref: ref(row.atlas_ref, "atlas_ref"), node: node.data, source_cards: cards, source_revision_refs: sourceRefs, support };
  }
  if (data.kind === "SOURCE_CARD") {
    const row = record(value, ["kind", "source_card", "support"], ["document_map_ref"]);
    if (target?.kind !== undefined && target.kind !== "SOURCE_CARD") mismatch("expansion kind does not match request");
    const sourceCard = parseSourceCard(row.source_card, target?.kind === "SOURCE_CARD" ? target.sourceRevisionRef : undefined);
    const mapRef = Object.hasOwn(row, "document_map_ref") ? ref(row.document_map_ref, "document_map_ref") : undefined;
    const support = parseSupport(row.support);
    if (support.kind !== "NAVIGATION_ONLY") mismatch("source card support is not navigation-only");
    return { kind: "SOURCE_CARD", source_card: sourceCard, ...(mapRef === undefined ? {} : { document_map_ref: mapRef }), support };
  }
  if (data.kind === "DOCUMENT_MAP") {
    const row = record(value, ["kind", "source_card", "document_map", "sections", "support"]);
    if (target?.kind !== undefined && target.kind !== "DOCUMENT_MAP") mismatch("expansion kind does not match request");
    const sourceRef = target?.kind === "DOCUMENT_MAP" ? target.sourceRevisionRef : undefined;
    const sourceCard = parseSourceCard(row.source_card, sourceRef);
    const map = DocumentMapRevisionSchema.safeParse(row.document_map);
    if (!map.success || map.data.source_revision_ref !== sourceCard.source_revision_ref) mismatch("document map is invalid or mismatched");
    const sections = boundedArray(row.sections, MAX_SECTIONS).map((item) => parseSection(item, map.data.source_revision_ref));
    const sectionRefs = new Set<string>();
    for (const section of sections) {
      if (sectionRefs.has(section.section_ref)) mismatch("document map repeats a section");
      sectionRefs.add(section.section_ref);
    }
    const support = parseSupport(row.support);
    if (support.kind !== "NAVIGATION_ONLY") mismatch("document map support is not navigation-only");
    return { kind: "DOCUMENT_MAP", source_card: sourceCard, document_map: map.data, sections, support };
  }
  if (data.kind === "SECTION") {
    const row = record(value, ["kind", "document_map_ref", "section", "support"], ["evidence_handle"]);
    if (target?.kind !== undefined && target.kind !== "SECTION") mismatch("expansion kind does not match request");
    const sourceRef = target?.kind === "SECTION" ? target.sourceRevisionRef : identifier((row.section as Record<string, unknown>)?.source_revision_ref, "section source revision");
    const section = parseSection(row.section, sourceRef);
    if (target?.kind === "SECTION" && section.section_ref !== target.sectionRef) mismatch("section does not match request");
    let handle: EvidenceHandle | undefined;
    if (Object.hasOwn(row, "evidence_handle")) {
      const parsed = EvidenceHandleSchema.safeParse(row.evidence_handle);
      if (!parsed.success || parsed.data.terminal_state !== "LIVE" || parsed.data.source_revision_ref !== section.source_revision_ref ||
          !sameRef(parsed.data.scope_snapshot_ref, targetScope)) mismatch("section evidence candidate is invalid");
      handle = parsed.data;
      if (section.normalized_start_byte !== undefined && handle.anchor.kind === "normalized_byte_range" &&
          (handle.anchor.start !== section.normalized_start_byte || handle.anchor.end !== section.normalized_end_byte)) mismatch("section evidence does not match section bytes");
    }
    const support = parseSupport(row.support, handle);
    if (handle === undefined && support.kind !== "NAVIGATION_ONLY") mismatch("section support claims an absent evidence candidate");
    return { kind: "SECTION", document_map_ref: ref(row.document_map_ref, "document_map_ref"), section, ...(handle === undefined ? {} : { evidence_handle: handle }), support };
  }
  mismatch("expansion result kind is invalid");
}

export function navigationExpansionBody(scope: ScopeSnapshot, target: NavigationExpansionTarget): string {
  const parsedScope = parseScope(scope);
  switch (target.kind) {
    case "ATLAS_NODE":
      return JSON.stringify({ kind: target.kind, scope_snapshot: parsedScope, project_ref: ref(target.projectRef, "project_ref"), node_id: identifier(target.nodeId, "node_id") });
    case "SOURCE_CARD":
      return JSON.stringify({ kind: target.kind, scope_snapshot: parsedScope, source_revision_ref: identifier(target.sourceRevisionRef, "source_revision_ref") });
    case "DOCUMENT_MAP":
      return JSON.stringify({ kind: target.kind, scope_snapshot: parsedScope, source_revision_ref: identifier(target.sourceRevisionRef, "source_revision_ref") });
    case "SECTION":
      return JSON.stringify({ kind: target.kind, scope_snapshot: parsedScope, source_revision_ref: identifier(target.sourceRevisionRef, "source_revision_ref"), section_ref: identifier(target.sectionRef, "section_ref") });
  }
  return mismatch("expansion target is invalid");
}

export function decodeNavigationExpansion(
  value: unknown,
  expectedDeploymentGeneration: string,
  scope: ScopeSnapshot,
  target?: NavigationExpansionTarget,
): NavigationExpansionResult {
  try {
    const envelope = record(value, ["data", "trace_id", "deployment_generation"]);
    const deployment = identifier(envelope.deployment_generation, "deployment_generation");
    if (deployment !== identifier(expectedDeploymentGeneration, "expected deployment generation")) {
      throw new ApiRequestError({ status: 409, code: "NAVIGATION_DEPLOYMENT_CHANGED", message: "Application changed; refresh the source view", retryable: true });
    }
    identifier(envelope.trace_id, "trace_id");
    return parseExpansionData(envelope.data, parseScope(scope), target);
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    mismatch();
  }
}

export async function expandNavigation(
  view: OrientationView,
  target: NavigationExpansionTarget,
  signal?: AbortSignal,
): Promise<NavigationExpansionResult> {
  const scope = await readOrientationScope(view, signal);
  const value = await requestApi("/api/v1/research/navigation/expand", {
    method: "POST",
    body: navigationExpansionBody(scope, target),
    headers: { "content-type": "application/json" },
    ...(signal ? { signal } : {}),
  });
  return decodeNavigationExpansion(value, view.generation, scope, target);
}
