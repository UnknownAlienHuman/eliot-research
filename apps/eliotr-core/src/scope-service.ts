import {
  IdentifierSchema,
  PositiveIntegerSchema,
  ScopeExpressionSchema,
  ScopeSnapshotSchema,
  Sha256Schema,
  type ScopeExpression,
  type ScopeSnapshot,
} from "@eliotr/contracts";
import {
  inspectScopeExpression,
  normalizeScopeExpression,
  resolveDeterministicScopeSnapshotDraft,
  scopeExpressionAtoms,
  scopeExpressionIdentity,
  type DeterministicScopeAtom,
  type DeterministicScopeAtomResolution,
  type DeterministicScopeMember,
} from "@eliotr/domain";

const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_EXPRESSION_DEPTH = 32;
const MAX_SCOPE_ATOMS = 256;
const MAX_SELECTED_SOURCES = 1_000;
const MAX_SNAPSHOT_MEMBERS = 50_000;
const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

export class ScopeServiceError extends Error {
  public readonly code: string;
  public readonly reason_codes: readonly string[];

  public constructor(code: string, message: string, reasonCodes: readonly string[] = [code]) {
    super(message);
    this.name = "ScopeServiceError";
    this.code = code;
    this.reason_codes = reasonCodes;
  }
}

export interface ScopeAuthorityClosure {
  readonly policy_authority_ref: string;
  readonly disclosure_closure_digest: string;
  readonly purge_ledger_revision: number;
  readonly client_fence_valid: boolean;
  readonly denied_source_revision_refs: readonly string[];
}

export interface ScopeAuthorityRequest {
  readonly resolved_scope_expression: ScopeExpression;
  readonly canonical_expression: string;
  readonly member_source_revision_refs: readonly string[];
  readonly member_policy_closure_refs: Readonly<Record<string, string>>;
  readonly observed_at: string;
  readonly client_fence_ref?: string;
}

export type ScopePersistenceOutcome = "CREATED" | "REPLAY" | "CONFLICT";

export interface ScopeRepository {
  resolveAtom(
    atom: DeterministicScopeAtom,
    observedAt: string,
  ): Promise<DeterministicScopeAtomResolution>;
  resolveAuthorityClosure(request: ScopeAuthorityRequest): Promise<ScopeAuthorityClosure>;
  persistSnapshot(snapshot: ScopeSnapshot): Promise<ScopePersistenceOutcome>;
  readSnapshot(snapshotId: string, revision: number): Promise<ScopeSnapshot | null>;
}

export interface ScopeCurrentness {
  readonly current: boolean;
  readonly invalidation_reason_codes: readonly string[];
}

export interface ScopeService {
  freeze(expression: ScopeExpression, clientFenceRef?: string): Promise<ScopeSnapshot>;
  validateCurrent(snapshot: ScopeSnapshot): Promise<ScopeCurrentness>;
  requireCurrent(snapshot: ScopeSnapshot): Promise<ScopeSnapshot>;
}

export interface ScopeServiceOptions {
  readonly now?: () => number;
  readonly ttl_ms?: number;
  readonly max_snapshot_members?: number;
}

interface ResolvedScopeState {
  readonly expression: ScopeExpression;
  readonly canonical_expression: string;
  readonly participant_generations: Readonly<Record<string, string>>;
  readonly members: readonly DeterministicScopeMember[];
  readonly member_source_revision_refs: readonly string[];
  readonly source_owner_generations: Readonly<Record<string, string>>;
  readonly member_policy_closure_refs: Readonly<Record<string, string>>;
  readonly authority: ScopeAuthorityClosure;
}

function fail(code: string, message: string, reasonCodes?: readonly string[]): never {
  throw new ScopeServiceError(code, message, reasonCodes);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("SCOPE_CANONICAL_VALUE_INVALID", "unsupported canonical number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") fail("SCOPE_CANONICAL_VALUE_INVALID", "unsupported canonical value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalSize(value: unknown): number {
  return encoder.encode(canonicalJson(value)).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sortedRecord(entries: readonly (readonly [string, string])[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of [...entries].sort(([left], [right]) => compareText(left, right))) {
    if (result[key] !== undefined && result[key] !== value) {
      fail("SCOPE_GENERATION_CONFLICT", `conflicting generation for ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function parseIdentifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("SCOPE_IDENTIFIER_INVALID", `${label} is invalid`);
  return parsed.data;
}

function parseAuthority(value: ScopeAuthorityClosure): ScopeAuthorityClosure {
  const policyAuthority = parseIdentifier(value.policy_authority_ref, "policy_authority_ref");
  const disclosureDigest = Sha256Schema.safeParse(value.disclosure_closure_digest);
  const purgeRevision = PositiveIntegerSchema.safeParse(value.purge_ledger_revision);
  if (!disclosureDigest.success || !purgeRevision.success || typeof value.client_fence_valid !== "boolean") {
    fail("SCOPE_AUTHORITY_INVALID", "scope authority closure is invalid");
  }
  if (!Array.isArray(value.denied_source_revision_refs)) {
    fail("SCOPE_AUTHORITY_INVALID", "denied source revisions are invalid");
  }
  const denied = value.denied_source_revision_refs.map((ref) =>
    parseIdentifier(ref, "denied source revision"),
  );
  if (new Set(denied).size !== denied.length) {
    fail("SCOPE_AUTHORITY_INVALID", "denied source revisions contain duplicates");
  }
  return {
    policy_authority_ref: policyAuthority,
    disclosure_closure_digest: disclosureDigest.data,
    purge_ledger_revision: purgeRevision.data,
    client_fence_valid: value.client_fence_valid,
    denied_source_revision_refs: [...denied].sort(compareText),
  };
}

function parseNow(now: () => number): number {
  const observed = now();
  if (!Number.isSafeInteger(observed) || observed < 0) {
    fail("SCOPE_CLOCK_INVALID", "scope clock returned an invalid instant");
  }
  return observed;
}

function validateOptions(options: ScopeServiceOptions): {
  readonly now: () => number;
  readonly ttl_ms: number;
  readonly max_snapshot_members: number;
} {
  const ttl = options.ttl_ms ?? DEFAULT_TTL_MS;
  const maxMembers = options.max_snapshot_members ?? MAX_SNAPSHOT_MEMBERS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) {
    fail("SCOPE_TTL_INVALID", `scope TTL must be 1-${MAX_TTL_MS} milliseconds`);
  }
  if (!Number.isSafeInteger(maxMembers) || maxMembers <= 0 || maxMembers > MAX_SNAPSHOT_MEMBERS) {
    fail("SCOPE_MEMBER_LIMIT_INVALID", `scope member limit must be 1-${MAX_SNAPSHOT_MEMBERS}`);
  }
  return { now: options.now ?? Date.now, ttl_ms: ttl, max_snapshot_members: maxMembers };
}

function parseExpression(value: unknown): ScopeExpression {
  const parsed = ScopeExpressionSchema.safeParse(value);
  if (!parsed.success) fail("SCOPE_EXPRESSION_INVALID", "scope expression failed strict validation");
  const metrics = inspectScopeExpression(parsed.data);
  if (metrics.depth > MAX_EXPRESSION_DEPTH) {
    fail("SCOPE_EXPRESSION_TOO_DEEP", `scope expression exceeds depth ${MAX_EXPRESSION_DEPTH}`);
  }
  if (metrics.atom_count > MAX_SCOPE_ATOMS) {
    fail("SCOPE_ATOM_LIMIT", `scope expression exceeds ${MAX_SCOPE_ATOMS} atoms`);
  }
  if (metrics.selected_source_count > MAX_SELECTED_SOURCES) {
    fail("SCOPE_SELECTED_SOURCE_LIMIT", `scope expression exceeds ${MAX_SELECTED_SOURCES} selected sources`);
  }
  return normalizeScopeExpression(parsed.data);
}

async function participantKey(atomIdentity: string): Promise<string> {
  const digest = await sha256Hex(`eliotr.scope.participant.v1\u0000${atomIdentity}`);
  return `participant-${digest.slice(0, 48)}`;
}

async function resolveState(
  repository: ScopeRepository,
  rawExpression: ScopeExpression,
  observedAt: string,
  clientFenceRef: string | undefined,
  maxMembers: number,
): Promise<ResolvedScopeState> {
  const expression = parseExpression(rawExpression);
  const atomCache = new Map<string, Promise<DeterministicScopeAtomResolution>>();
  const resolver = {
    resolve(atom: DeterministicScopeAtom): Promise<DeterministicScopeAtomResolution> {
      const identity = scopeExpressionIdentity(atom);
      const cached = atomCache.get(identity);
      if (cached !== undefined) return cached;
      const pending = repository.resolveAtom(atom, observedAt);
      atomCache.set(identity, pending);
      return pending;
    },
  };
  const draft = await resolveDeterministicScopeSnapshotDraft(expression, resolver);
  if (draft.members.length > maxMembers) {
    fail("SCOPE_MEMBER_LIMIT", `resolved scope exceeds ${maxMembers} members`);
  }
  const atoms = scopeExpressionAtoms(expression);
  await Promise.all(atoms.map((atom) => resolver.resolve(atom)));
  const participantEntries = await Promise.all(atoms.map(async (atom) => {
    const identity = scopeExpressionIdentity(atom);
    const resolution = await resolver.resolve(atom);
    return [await participantKey(identity), parseIdentifier(
      resolution.atom_generation_ref,
      "participant generation",
    )] as const;
  }));
  const participantGenerations = sortedRecord(participantEntries);
  const members = [...draft.members].sort((left, right) =>
    compareText(left.source_revision_ref, right.source_revision_ref),
  );
  const memberRefs = members.map((member) => member.source_revision_ref);
  const ownerGenerations = sortedRecord(members.map((member) => [
    member.source_revision_ref,
    member.source_owner_generation,
  ] as const));
  const policyClosures = sortedRecord(members.map((member) => [
    member.source_revision_ref,
    member.policy_closure_ref,
  ] as const));
  const authorityRequest: ScopeAuthorityRequest = {
    resolved_scope_expression: expression,
    canonical_expression: draft.canonical_expression,
    member_source_revision_refs: memberRefs,
    member_policy_closure_refs: policyClosures,
    observed_at: observedAt,
    ...(clientFenceRef === undefined ? {} : { client_fence_ref: clientFenceRef }),
  };
  const authority = parseAuthority(await repository.resolveAuthorityClosure(authorityRequest));
  return {
    expression,
    canonical_expression: draft.canonical_expression,
    participant_generations: participantGenerations,
    members,
    member_source_revision_refs: memberRefs,
    source_owner_generations: ownerGenerations,
    member_policy_closure_refs: policyClosures,
    authority,
  };
}

function snapshotMaterial(snapshot: Omit<ScopeSnapshot, "snapshot_id" | "digest">): object {
  return {
    protocol: "eliotr.scope-snapshot.v1",
    revision: snapshot.revision,
    resolved_scope_expression: snapshot.resolved_scope_expression,
    participant_generations: snapshot.participant_generations,
    member_source_revision_refs: snapshot.member_source_revision_refs,
    source_owner_generations: snapshot.source_owner_generations,
    policy_authority_ref: snapshot.policy_authority_ref,
    disclosure_closure_digest: snapshot.disclosure_closure_digest,
    purge_ledger_revision: snapshot.purge_ledger_revision,
    ...(snapshot.client_fence_ref === undefined ? {} : { client_fence_ref: snapshot.client_fence_ref }),
    created_at: snapshot.created_at,
    expires_at: snapshot.expires_at,
  };
}

async function expectedSnapshotIdentity(
  snapshot: Omit<ScopeSnapshot, "snapshot_id" | "digest">,
): Promise<{ readonly snapshot_id: string; readonly digest: string }> {
  const material = snapshotMaterial(snapshot);
  const identityDigest = await sha256Hex(canonicalJson(material));
  const snapshotId = `scope-${identityDigest.slice(0, 48)}`;
  const digest = await sha256Hex(canonicalJson({ snapshot_id: snapshotId, ...material }));
  return { snapshot_id: snapshotId, digest };
}

function withoutIdentity(snapshot: ScopeSnapshot): Omit<ScopeSnapshot, "snapshot_id" | "digest"> {
  const { snapshot_id: _snapshotId, digest: _digest, ...material } = snapshot;
  return material;
}

async function integrityReasons(snapshot: ScopeSnapshot): Promise<readonly string[]> {
  const expected = await expectedSnapshotIdentity(withoutIdentity(snapshot));
  const reasons: string[] = [];
  if (snapshot.snapshot_id !== expected.snapshot_id) reasons.push("SNAPSHOT_ID_MISMATCH");
  if (snapshot.digest !== expected.digest) reasons.push("SNAPSHOT_DIGEST_MISMATCH");
  return reasons;
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

// IMPLEMENTED_NOT_LIVE: ER-30 scope snapshots require ER-24 D1 composition and retained live receipts.
export function createScopeService(
  repository: ScopeRepository,
  rawOptions: ScopeServiceOptions = {},
): ScopeService {
  const options = validateOptions(rawOptions);

  async function validateCurrent(rawSnapshot: ScopeSnapshot): Promise<ScopeCurrentness> {
    const parsed = ScopeSnapshotSchema.safeParse(rawSnapshot);
    if (!parsed.success) {
      return { current: false, invalidation_reason_codes: ["SNAPSHOT_INVALID"] };
    }
    const snapshot = parsed.data;
    const reasons = [...await integrityReasons(snapshot)];
    const observedMs = parseNow(options.now);
    const observedAt = new Date(observedMs).toISOString();
    if (Date.parse(snapshot.expires_at) <= observedMs) reasons.push("SNAPSHOT_EXPIRED");

    const persisted = await repository.readSnapshot(snapshot.snapshot_id, snapshot.revision);
    if (persisted === null) {
      reasons.push("SNAPSHOT_NOT_PERSISTED");
    } else {
      const parsedPersisted = ScopeSnapshotSchema.safeParse(persisted);
      if (!parsedPersisted.success) {
        reasons.push("SNAPSHOT_PERSISTED_RECORD_INVALID");
      } else if (canonicalJson(parsedPersisted.data) !== canonicalJson(snapshot)) {
        reasons.push("SNAPSHOT_PERSISTED_RECORD_MISMATCH");
      }
    }

    try {
      const current = await resolveState(
        repository,
        snapshot.resolved_scope_expression,
        observedAt,
        snapshot.client_fence_ref,
        options.max_snapshot_members,
      );
      if (!sameRecord(current.participant_generations, snapshot.participant_generations)) {
        reasons.push("PARTICIPANT_GENERATION_STALE");
      }
      if (!sameArray(current.member_source_revision_refs, snapshot.member_source_revision_refs)) {
        reasons.push("SCOPE_MEMBERSHIP_CHANGED");
      }
      if (!sameRecord(current.source_owner_generations, snapshot.source_owner_generations)) {
        reasons.push("SOURCE_OWNER_GENERATION_STALE");
      }
      if (current.authority.policy_authority_ref !== snapshot.policy_authority_ref) {
        reasons.push("POLICY_AUTHORITY_STALE");
      }
      if (current.authority.disclosure_closure_digest !== snapshot.disclosure_closure_digest) {
        reasons.push("DISCLOSURE_CLOSURE_STALE");
      }
      if (current.authority.purge_ledger_revision !== snapshot.purge_ledger_revision) {
        reasons.push("PURGE_LEDGER_ADVANCED");
      }
      if (!current.authority.client_fence_valid) reasons.push("CLIENT_FENCE_STALE");
      if (current.authority.denied_source_revision_refs.length > 0) reasons.push("NEW_DENY_APPLIES");
    } catch (error) {
      reasons.push(error instanceof ScopeServiceError ? error.code : "SCOPE_RESOLUTION_FAILED");
    }
    const invalidationReasons = uniqueSorted(reasons);
    return { current: invalidationReasons.length === 0, invalidation_reason_codes: invalidationReasons };
  }

  return {
    async freeze(rawExpression, rawClientFenceRef) {
      const observedMs = parseNow(options.now);
      const observedAt = new Date(observedMs).toISOString();
      const clientFenceRef = rawClientFenceRef === undefined
        ? undefined
        : parseIdentifier(rawClientFenceRef, "client_fence_ref");
      const resolved = await resolveState(
        repository,
        rawExpression,
        observedAt,
        clientFenceRef,
        options.max_snapshot_members,
      );
      if (!resolved.authority.client_fence_valid) {
        fail("CLIENT_FENCE_STALE", "client fence is stale");
      }
      if (resolved.authority.denied_source_revision_refs.length > 0) {
        fail("SCOPE_DENIED", "resolved scope contains denied source revisions");
      }
      const material: Omit<ScopeSnapshot, "snapshot_id" | "digest"> = {
        revision: 1,
        resolved_scope_expression: resolved.expression,
        participant_generations: resolved.participant_generations,
        member_source_revision_refs: resolved.member_source_revision_refs,
        source_owner_generations: resolved.source_owner_generations,
        policy_authority_ref: resolved.authority.policy_authority_ref,
        disclosure_closure_digest: resolved.authority.disclosure_closure_digest,
        purge_ledger_revision: resolved.authority.purge_ledger_revision,
        ...(clientFenceRef === undefined ? {} : { client_fence_ref: clientFenceRef }),
        created_at: observedAt,
        expires_at: new Date(observedMs + options.ttl_ms).toISOString(),
      };
      const identity = await expectedSnapshotIdentity(material);
      const parsed = ScopeSnapshotSchema.safeParse({ ...material, ...identity });
      if (!parsed.success || canonicalSize(parsed.data) > MAX_CANONICAL_BYTES) {
        fail("SCOPE_SNAPSHOT_INVALID", "resolved scope snapshot is invalid or oversized");
      }
      const outcome = await repository.persistSnapshot(parsed.data);
      if (outcome === "CONFLICT") {
        fail("SCOPE_SNAPSHOT_CONFLICT", "snapshot identity is already bound to different bytes");
      }
      const readback = await repository.readSnapshot(parsed.data.snapshot_id, parsed.data.revision);
      const parsedReadback = ScopeSnapshotSchema.safeParse(readback);
      if (!parsedReadback.success || canonicalJson(parsedReadback.data) !== canonicalJson(parsed.data)) {
        fail("SCOPE_SNAPSHOT_READBACK_MISMATCH", "immutable snapshot readback did not match written bytes");
      }
      return parsedReadback.data;
    },

    validateCurrent,

    async requireCurrent(snapshot) {
      const currentness = await validateCurrent(snapshot);
      if (!currentness.current) {
        fail(
          "SCOPE_SNAPSHOT_STALE",
          "scope snapshot cannot authorize retrieval",
          currentness.invalidation_reason_codes,
        );
      }
      return ScopeSnapshotSchema.parse(snapshot);
    },
  };
}
