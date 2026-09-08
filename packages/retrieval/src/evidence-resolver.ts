import {
  EvidenceHandleSchema,
  type CitationResolutionReceipt,
  type EvidenceAnchor,
  type EvidenceHandle,
  type LocatorCandidate,
  type ResolvedEvidence,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import { validateEvidenceResolution } from "@eliotr/domain";

export interface EvidenceResolutionContext {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly credential_generation: string;
}

export interface EvidenceResolver {
  resolveCandidate(
    candidate: LocatorCandidate,
    scope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveHandle(
    handle: EvidenceHandle,
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveCitationSet(
    handleRefs: readonly VersionedRef[],
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<{
    readonly receipt: CitationResolutionReceipt;
    readonly resolved_evidence: readonly ResolvedEvidence[];
  }>;
}

export interface ExactEvidenceResolutionPort {
  resolveCandidate(
    candidate: LocatorCandidate,
    scope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveHandle(
    handle: EvidenceHandle,
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveCitationSet(
    handleRefs: readonly VersionedRef[],
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<{
    readonly receipt: CitationResolutionReceipt;
    readonly resolved_evidence: readonly ResolvedEvidence[];
  }>;
}

export function createEvidenceResolver(port: ExactEvidenceResolutionPort): EvidenceResolver {
  return {
    resolveCandidate: (candidate, scope, context) => port.resolveCandidate(candidate, scope, context),
    resolveHandle: (handle, scope, context) => port.resolveHandle(handle, scope, context),
    resolveCitationSet: (refs, scope, context) => port.resolveCitationSet(refs, scope, context),
  };
}

export const EVIDENCE_RESOLUTION_CHECKS = [
  "current authorization",
  "source owner generation",
  "purge and terminal state",
  "exact admitted source revision digest",
  "native or normalized coordinate map",
  "excerpt SHA-256 and UTF-8 byte length",
  "frozen ScopeSnapshot binding",
  "durable resolution receipt",
] as const;

// Q2 exact/literal verification over bounded pinned R2 ranges.
//
// Pure deterministic layer above the R2 content port (`content-store.ts` owns
// pinning, bounded seek, cancellation and typed-precision rejection). This
// module performs no R2, D1, network, clock or embedded-index access: the
// caller supplies the pinned admitted authority, the materialized excerpt and,
// when independent re-slicing is required, a bounded window of pinned object
// bytes. Unknown wire fields fail closed via the strict contract schemas.

export const EXACT_VERIFICATION_BOUNDS = {
  max_excerpt_bytes: 256 * 1024,
  max_scan_bytes: 4 * 1024 * 1024,
  max_probes: 64,
  max_probe_bytes: 8 * 1024,
  max_regex_patterns: 8,
  max_pattern_length: 512,
  max_regex_matches: 64,
} as const;

export type ExactVerificationErrorCode =
  | "EXACT_FORGED_HANDLE"
  | "EXACT_SCOPE_MISMATCH"
  | "EXACT_OWNER_GENERATION_MISMATCH"
  | "EXACT_SOURCE_NOT_LIVE"
  | "EXACT_RESIDENCY_MISMATCH"
  | "EXACT_REVISION_MISMATCH"
  | "EXACT_CURRENT_BYTE_SUBSTITUTION"
  | "EXACT_RANGE_INVALID"
  | "EXACT_LENGTH_MISMATCH"
  | "EXACT_DIGEST_MISMATCH"
  | "EXACT_COORDINATE_MAP_MISSING"
  | "EXACT_COORDINATE_MAP_CORRUPT"
  | "EXACT_PRECISION_UNSUPPORTED"
  | "EXACT_REVOKED_MID_READ"
  | "EXACT_PROBE_ABSENT"
  | "EXACT_TOKENIZER_FALLBACK_REQUIRED"
  | "EXACT_REGEX_INVALID"
  | "EXACT_REGEX_UNBOUNDED";

export class ExactVerificationError extends Error {
  public readonly code: ExactVerificationErrorCode;

  public constructor(code: ExactVerificationErrorCode, message: string) {
    super(message);
    this.name = "ExactVerificationError";
    this.code = code;
  }
}

export interface PinnedSourceAuthority {
  readonly source_revision_ref: string;
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
  readonly content_sha256: string;
  readonly object_residency_key_digest: string;
  readonly purge_state: "LIVE" | "QUARANTINED" | "PURGE_REQUESTED" | "REDACTED" | "RETENTION_BLOCKED";
}

export interface PinnedExcerptMaterialization {
  readonly exact_excerpt: string;
  readonly excerpt_sha256: string;
  readonly excerpt_byte_length: number;
  readonly source_object_size: number;
  readonly source_object_sha256: string;
}

export interface AdmittedCoordinateMap {
  readonly map_ref: string;
  readonly entries: Readonly<Record<string, { readonly start: number; readonly end: number }>>;
}

export interface ReviewedProjectionTable {
  readonly table_ref: string;
  readonly reviewer_ref: string;
  readonly token_byte_ranges: Readonly<Record<string, ReadonlyArray<{ readonly start: number; readonly end: number }>>>;
}

export interface ReusableVerificationReceipt {
  readonly handle_id: string;
  readonly handle_revision: number;
  readonly excerpt_sha256: string;
  readonly scope_snapshot_digest: string;
  readonly receipt_digest: string;
}

export interface BoundedRegexProbe {
  readonly pattern: string;
  readonly flags?: "" | "i";
}

export interface VerifyPinnedExactInput {
  readonly handle: unknown;
  readonly scope: ScopeSnapshot;
  readonly source: PinnedSourceAuthority;
  readonly materialized: PinnedExcerptMaterialization;
  readonly pinned_object_bytes?: Uint8Array;
  readonly coordinate_map?: AdmittedCoordinateMap | null;
  readonly exact_probes?: readonly string[];
  readonly regex_probes?: readonly BoundedRegexProbe[];
  readonly tokenizer?: { readonly id: string };
  readonly reviewed_projection_table?: ReviewedProjectionTable | null;
  readonly prior_receipts?: readonly ReusableVerificationReceipt[];
  readonly revoked_mid_read?: boolean;
}

export interface ExactProbeMatch {
  readonly probe: string;
  readonly byte_offsets: readonly number[];
}

export interface BoundedRegexMatch {
  readonly pattern: string;
  readonly match_count: number;
  readonly byte_offsets: readonly number[];
}

export interface ExactVerificationReceipt {
  readonly handle_id: string;
  readonly handle_revision: number;
  readonly anchor_byte_range: { readonly start: number; readonly end: number };
  readonly probe_matches: readonly ExactProbeMatch[];
  readonly regex_matches: readonly BoundedRegexMatch[];
  readonly reused_receipt_digest: string | null;
  readonly tokenizer_fallback_table_ref: string | null;
  readonly scope_snapshot_digest: string;
  readonly source_revision_ref: string;
}

const SUPPORTED_TOKENIZERS = new Set(["unicode-code-point-v1", "utf8-byte-v1"]);
const SHA256_HEX = /^[a-f0-9]{64}$/u;

function failExact(code: ExactVerificationErrorCode, message: string): never {
  throw new ExactVerificationError(code, message);
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeFatal(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    failExact("EXACT_RANGE_INVALID", `${label} cuts through UTF-8 boundaries`);
  }
}

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}

function requireByteRange(start: number, end: number, objectSize: number): { start: number; end: number } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    failExact("EXACT_RANGE_INVALID", "normalized byte range is invalid");
  }
  if (end - start > EXACT_VERIFICATION_BOUNDS.max_excerpt_bytes) {
    failExact("EXACT_RANGE_INVALID", "evidence excerpt exceeds the hard byte limit");
  }
  if (end > objectSize) {
    failExact("EXACT_RANGE_INVALID", "evidence anchor exceeds the admitted source object");
  }
  return { start, end };
}

function locateLineRange(
  bytes: Uint8Array,
  startLine: number,
  endLine: number,
  objectSize: number,
): { start: number; end: number } {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    failExact("EXACT_RANGE_INVALID", "normalized line range is invalid");
  }
  if (bytes.byteLength > EXACT_VERIFICATION_BOUNDS.max_scan_bytes) {
    failExact("EXACT_RANGE_INVALID", "pinned window exceeds the hard line-scan bound");
  }
  let line = 1;
  let start: number | undefined = startLine === 1 ? 0 : undefined;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const end = index + 1;
    if (start !== undefined && end - start > EXACT_VERIFICATION_BOUNDS.max_excerpt_bytes) {
      failExact("EXACT_RANGE_INVALID", "requested evidence lines exceed the hard excerpt byte limit");
    }
    if (bytes[index] !== 10) continue;
    if (line === endLine && start !== undefined) return requireByteRange(start, end, objectSize);
    line += 1;
    if (line === startLine) start = end;
  }
  // No trailing LF: the final line ends at the object end. A final LF does not
  // create a nonempty extra line, mirroring the R2 content port.
  if (start === undefined || line !== endLine) {
    failExact("EXACT_RANGE_INVALID", "requested lines do not exist in the admitted source object");
  }
  return requireByteRange(start, bytes.byteLength, objectSize);
}

function coordinateKeyFor(anchor: EvidenceAnchor): string | null {
  if (anchor.kind === "table_cell") return `table:${anchor.table_id}:${anchor.row}:${anchor.column}`;
  if (anchor.kind === "page_region") return `page:${anchor.page}:${anchor.bbox.join(",")}`;
  if (anchor.kind === "code_range") {
    return `code:${anchor.commit_sha}:${anchor.path}:${anchor.start_line}:${anchor.end_line}`;
  }
  return null;
}

function resolveAnchorToRange(
  anchor: EvidenceAnchor,
  coordinateMap: AdmittedCoordinateMap | null | undefined,
  objectSize: number,
  pinnedBytes: Uint8Array | undefined,
): { start: number; end: number } {
  if (anchor.kind === "normalized_byte_range") return requireByteRange(anchor.start, anchor.end, objectSize);
  if (anchor.kind === "normalized_line_range") {
    if (pinnedBytes === undefined) {
      failExact("EXACT_RANGE_INVALID", "line anchors require the bounded pinned byte window for re-slicing");
    }
    return locateLineRange(pinnedBytes, anchor.start_line, anchor.end_line, objectSize);
  }
  const key = coordinateKeyFor(anchor);
  if (key === null) failExact("EXACT_PRECISION_UNSUPPORTED", "unknown anchor precision");
  if (coordinateMap === undefined || coordinateMap === null) {
    // Missing maps narrow precision; coordinates are never fabricated.
    failExact("EXACT_COORDINATE_MAP_MISSING", "coordinate anchor requires its admitted map");
  }
  if (typeof coordinateMap.map_ref !== "string" || coordinateMap.map_ref.length === 0) {
    failExact("EXACT_COORDINATE_MAP_CORRUPT", "admitted coordinate map reference is invalid");
  }
  const entry = coordinateMap.entries[key];
  if (entry === undefined) {
    failExact("EXACT_COORDINATE_MAP_CORRUPT", "admitted coordinate map has no entry for this anchor");
  }
  return requireByteRange(entry.start, entry.end, objectSize);
}

function verifyExactProbes(excerpt: string, probes: readonly string[]): readonly ExactProbeMatch[] {
  if (probes.length > EXACT_VERIFICATION_BOUNDS.max_probes) {
    failExact("EXACT_RANGE_INVALID", "exact probe set exceeds its bound");
  }
  return probes.map((probe) => {
    if (typeof probe !== "string" || probe.length === 0) {
      failExact("EXACT_PROBE_ABSENT", "empty probes never match pinned evidence");
    }
    const width = utf8Bytes(probe).byteLength;
    if (width > EXACT_VERIFICATION_BOUNDS.max_probe_bytes) {
      failExact("EXACT_RANGE_INVALID", "a single exact probe exceeds its byte bound");
    }
    const offsets: number[] = [];
    let from = 0;
    for (;;) {
      const found = excerpt.indexOf(probe, from);
      if (found === -1) break;
      offsets.push(utf8Bytes(excerpt.slice(0, found)).byteLength);
      from = found + probe.length;
      if (offsets.length > EXACT_VERIFICATION_BOUNDS.max_regex_matches) {
        failExact("EXACT_RANGE_INVALID", "exact probe matches exceed their bound");
      }
    }
    if (offsets.length === 0) failExact("EXACT_PROBE_ABSENT", "exact probe is absent from pinned bytes");
    return { probe, byte_offsets: offsets };
  });
}

function verifyRegexProbes(excerpt: string, probes: readonly BoundedRegexProbe[]): readonly BoundedRegexMatch[] {
  if (probes.length > EXACT_VERIFICATION_BOUNDS.max_regex_patterns) {
    failExact("EXACT_REGEX_UNBOUNDED", "regex probe set exceeds its bound");
  }
  return probes.map((probe) => {
    if (probe.pattern.length === 0 || probe.pattern.length > EXACT_VERIFICATION_BOUNDS.max_pattern_length) {
      failExact("EXACT_REGEX_INVALID", "regex pattern length is outside its bound");
    }
    if (probe.flags !== undefined && probe.flags !== "" && probe.flags !== "i") {
      failExact("EXACT_REGEX_INVALID", "regex probe carries unsupported flags");
    }
    let expression: RegExp;
    try {
      expression = new RegExp(probe.pattern, `gu${probe.flags ?? ""}`);
    } catch {
      failExact("EXACT_REGEX_INVALID", "regex pattern does not compile");
    }
    // Bounded normalized scan: the excerpt itself is already capped at
    // 256 KiB, matches are capped, and only the pinned excerpt is scanned —
    // never an unbounded SQL table or a whole-document allocation.
    const offsets: number[] = [];
    expression.lastIndex = 0;
    for (;;) {
      const match = expression.exec(excerpt);
      if (match === null) break;
      if (match[0].length === 0) {
        expression.lastIndex += 1;
        continue;
      }
      offsets.push(utf8Bytes(excerpt.slice(0, match.index)).byteLength);
      if (offsets.length > EXACT_VERIFICATION_BOUNDS.max_regex_matches) {
        failExact("EXACT_REGEX_UNBOUNDED", "regex matches exceed the bounded scan limit");
      }
      if (!expression.global) break;
    }
    return { pattern: probe.pattern, match_count: offsets.length, byte_offsets: offsets };
  });
}

function requireTokenizer(
  tokenizer: { readonly id: string } | undefined,
  table: ReviewedProjectionTable | null | undefined,
  excerptByteLength: number,
): string | null {
  if (tokenizer === undefined) return null;
  if (SUPPORTED_TOKENIZERS.has(tokenizer.id)) return null;
  // Unsupported tokenizers fall back to a reviewed projection table, never to
  // a native embedded index (no such path exists in this module).
  if (table === undefined || table === null) {
    failExact("EXACT_TOKENIZER_FALLBACK_REQUIRED", "unsupported tokenizer requires its reviewed projection table");
  }
  if (table.table_ref.length === 0 || table.reviewer_ref.length === 0) {
    failExact("EXACT_TOKENIZER_FALLBACK_REQUIRED", "reviewed projection table is not attributable");
  }
  for (const ranges of Object.values(table.token_byte_ranges)) {
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end <= range.start || range.end > excerptByteLength) {
        failExact("EXACT_TOKENIZER_FALLBACK_REQUIRED", "reviewed projection table entry is out of bounds");
      }
    }
  }
  return table.table_ref;
}

/** Verify a pinned handle against bounded admitted bytes without re-reading R2.
 *
 * Rejects (never substitutes) when the current source bytes changed under an
 * old handle: the materialized revision digest must equal the presented
 * authority digest, and the re-sliced excerpt digest/length must equal the
 * handle. Prior open/verify receipts are reused only on exact digest match.
 */
export async function verifyPinnedExactEvidence(input: VerifyPinnedExactInput): Promise<ExactVerificationReceipt> {
  const parsed = EvidenceHandleSchema.safeParse(input.handle);
  if (!parsed.success) failExact("EXACT_FORGED_HANDLE", "evidence handle fails strict contract validation");
  const handle = parsed.data;
  if (handle.terminal_state !== "LIVE" || input.revoked_mid_read === true) {
    failExact("EXACT_REVOKED_MID_READ", "evidence handle is revoked or terminal; no bytes are returned");
  }
  if (
    handle.scope_snapshot_ref.id !== input.scope.snapshot_id ||
    handle.scope_snapshot_ref.revision !== input.scope.revision
  ) {
    failExact("EXACT_SCOPE_MISMATCH", "evidence handle is bound to another ScopeSnapshot");
  }
  if (!input.scope.member_source_revision_refs.includes(handle.source_revision_ref)) {
    failExact("EXACT_SCOPE_MISMATCH", "SourceRevision is outside the frozen ScopeSnapshot");
  }
  if (input.scope.source_owner_generations[handle.source_revision_ref] !== input.source.source_owner_generation) {
    failExact("EXACT_OWNER_GENERATION_MISMATCH", "ScopeSnapshot owner generation is stale");
  }
  if (
    handle.source_namespace_id !== input.source.source_namespace_id ||
    handle.source_owner_generation !== input.source.source_owner_generation ||
    handle.object_residency_key_digest !== input.source.object_residency_key_digest
  ) {
    failExact("EXACT_OWNER_GENERATION_MISMATCH", "evidence source authority changed under the pinned handle");
  }
  if (input.source.purge_state !== "LIVE") {
    failExact("EXACT_SOURCE_NOT_LIVE", "SourceRevision is not live under the pinned handle");
  }
  if (handle.source_revision_ref !== input.source.source_revision_ref) {
    // The head advanced while resolving an old handle: reject, never follow.
    failExact("EXACT_REVISION_MISMATCH", "admitted revision moved under the pinned handle");
  }
  if (input.materialized.source_object_sha256 !== input.source.content_sha256) {
    failExact("EXACT_CURRENT_BYTE_SUBSTITUTION", "materialized bytes are not the admitted revision");
  }
  if (!SHA256_HEX.test(input.materialized.excerpt_sha256) || !SHA256_HEX.test(input.materialized.source_object_sha256)) {
    failExact("EXACT_DIGEST_MISMATCH", "materialized digests are malformed");
  }
  if (
    !Number.isSafeInteger(input.materialized.excerpt_byte_length) ||
    input.materialized.excerpt_byte_length < 1 ||
    input.materialized.excerpt_byte_length > EXACT_VERIFICATION_BOUNDS.max_excerpt_bytes ||
    !Number.isSafeInteger(input.materialized.source_object_size) ||
    input.materialized.source_object_size < 1
  ) {
    failExact("EXACT_LENGTH_MISMATCH", "materialized lengths are outside their bounds");
  }
  if (utf8Bytes(input.materialized.exact_excerpt).byteLength !== input.materialized.excerpt_byte_length) {
    failExact("EXACT_LENGTH_MISMATCH", "excerpt text is not the declared UTF-8 byte length");
  }
  const excerptDigest = await sha256HexBytes(utf8Bytes(input.materialized.exact_excerpt));
  if (excerptDigest !== input.materialized.excerpt_sha256 || excerptDigest !== handle.excerpt_sha256) {
    failExact("EXACT_DIGEST_MISMATCH", "pinned excerpt digest differs from the admitted handle");
  }
  if (input.materialized.excerpt_byte_length !== handle.excerpt_byte_length) {
    failExact("EXACT_LENGTH_MISMATCH", "pinned excerpt length differs from the admitted handle");
  }

  const range = resolveAnchorToRange(
    handle.anchor,
    input.coordinate_map,
    input.materialized.source_object_size,
    input.pinned_object_bytes,
  );
  if (input.pinned_object_bytes !== undefined) {
    if (input.pinned_object_bytes.byteLength > EXACT_VERIFICATION_BOUNDS.max_scan_bytes) {
      failExact("EXACT_RANGE_INVALID", "pinned byte window exceeds the hard scan bound");
    }
    const window = input.pinned_object_bytes.slice(range.start, range.end);
    if (window.byteLength !== input.materialized.excerpt_byte_length) {
      failExact("EXACT_CURRENT_BYTE_SUBSTITUTION", "pinned window does not reproduce the admitted excerpt");
    }
    const windowText = decodeFatal(window, "pinned window");
    if (windowText !== input.materialized.exact_excerpt) {
      // Bytes changed mid-resolution: reject the pinned revision, never
      // substitute the current bytes.
      failExact("EXACT_CURRENT_BYTE_SUBSTITUTION", "pinned window bytes changed under the admitted handle");
    }
  }

  const probeMatches = verifyExactProbes(input.materialized.exact_excerpt, input.exact_probes ?? []);
  const regexMatches = verifyRegexProbes(input.materialized.exact_excerpt, input.regex_probes ?? []);
  const fallbackTableRef = requireTokenizer(
    input.tokenizer,
    input.reviewed_projection_table,
    input.materialized.excerpt_byte_length,
  );

  const domainCheck = validateEvidenceResolution(handle, {
    authorized: true,
    currentOwnerGeneration: input.source.source_owner_generation,
    currentPurgeState: input.source.purge_state,
    sourceRevisionRef: input.source.source_revision_ref,
    sourceRevisionDigest: input.source.content_sha256,
    objectResidencyKeyDigest: input.source.object_residency_key_digest,
    excerptDigest: input.materialized.excerpt_sha256,
    excerptByteLength: input.materialized.excerpt_byte_length,
    scopeSnapshotId: input.scope.snapshot_id,
    scopeSnapshotRevision: input.scope.revision,
    scopeMember: true,
    coordinateMapPresent: handle.coordinate_map_ref !== undefined,
  });
  if (!domainCheck.ok) failExact("EXACT_DIGEST_MISMATCH", `domain recheck failed: ${domainCheck.error.message}`);

  let reused: string | null = null;
  for (const receipt of input.prior_receipts ?? []) {
    if (
      receipt.handle_id === handle.handle_ref.id &&
      receipt.handle_revision === handle.handle_ref.revision &&
      receipt.excerpt_sha256 === handle.excerpt_sha256 &&
      receipt.scope_snapshot_digest === input.scope.digest
    ) {
      reused = receipt.receipt_digest;
      break;
    }
  }

  return {
    handle_id: handle.handle_ref.id,
    handle_revision: handle.handle_ref.revision,
    anchor_byte_range: range,
    probe_matches: probeMatches,
    regex_matches: regexMatches,
    reused_receipt_digest: reused,
    tokenizer_fallback_table_ref: fallbackTableRef,
    scope_snapshot_digest: input.scope.digest,
    source_revision_ref: input.source.source_revision_ref,
  };
}
