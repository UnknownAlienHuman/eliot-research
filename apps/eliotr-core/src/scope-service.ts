import { createD1ScopeSnapshotStore } from "@eliotr/cloudflare-evidence";
import {
  IdentifierSchema, PositiveIntegerSchema, ScopeExpressionSchema, ScopeSnapshotSchema, Sha256Schema,
  type ScopeExpression, type ScopeSnapshot,
} from "@eliotr/contracts";
import {
  inspectScopeExpression, normalizeScopeExpression, resolveDeterministicScopeSnapshotDraft,
  scopeExpressionAtoms, scopeExpressionIdentity, scopeSnapshotIdentityPayload, scopeSnapshotDigestPayload,
  type DeterministicScopeAtom,
  type DeterministicScopeAtomResolution, type DeterministicScopeMember,
} from "@eliotr/domain";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SCOPE_DEPTH = 32;
const MAX_SCOPE_ATOMS = 256;
const MAX_SELECTED_SOURCE_IDS = 1_000;
const DEFAULT_MAX_SNAPSHOT_MEMBERS = 50_000;
const MAX_SNAPSHOT_MEMBERS = 50_000;
const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;
const MAX_RESOLUTION_MEMBER_ROWS = 200_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MEMBER_POLICY_CLOSURE_PARTICIPANT = "member-policy-closure";

export class ScopeServiceError extends Error {
  public readonly code: string;
  public readonly reason_codes: readonly string[];
  public constructor(code: string, message: string, reasonCodes?: readonly string[]) {
    super(message);
    this.name = "ScopeServiceError";
    this.code = code;
    this.reason_codes = [...(reasonCodes ?? [code])];
  }
}

function fail(code: string, message: string, reasonCodes?: readonly string[]): never {
  throw new ScopeServiceError(code, message, reasonCodes);
}

export interface ScopeAuthorityRequest {
  readonly expression: ScopeExpression;
  readonly canonical_expression: string;
  readonly member_source_revision_refs: readonly string[];
  readonly member_policy_closure_refs: Readonly<Record<string, string>>;
  readonly observed_at: string;
  readonly client_fence_ref?: string;
}

export interface ScopeAuthorityClosure {
  readonly policy_authority_ref: string;
  readonly disclosure_closure_digest: string;
  readonly purge_ledger_revision: number;
  readonly client_fence_valid: boolean;
  readonly denied_source_revision_refs: readonly string[];
}

export type ScopePersistenceOutcome = "CREATED" | "REPLAY" | "CONFLICT";

export interface ScopeRepository {
  resolveAtom(atom: DeterministicScopeAtom, observedAt: string): Promise<DeterministicScopeAtomResolution>;
  /** Must bind every member policy closure and deny only requested member revisions. */
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
  readonly participant_generations: Readonly<Record<string, string>>;
  readonly member_source_revision_refs: readonly string[];
  readonly source_owner_generations: Readonly<Record<string, string>>;
  readonly authority: ScopeAuthorityClosure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareText);
  const canonical = [...expected].sort(compareText);
  if (!sameArray(actual, canonical)) fail("SCOPE_RESOLUTION_FAILED", `${label} contains unknown or missing fields`);
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(compareText); }
function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("SCOPE_CANONICAL_VALUE_INVALID", "scope canonical JSON requires safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(compareText);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("SCOPE_CANONICAL_VALUE_INVALID", "scope canonical JSON contains a non-JSON value");
}

function requireCanonicalSize(value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_CANONICAL_BYTES) {
    fail("SCOPE_SNAPSHOT_TOO_LARGE", "scope snapshot exceeds the canonical byte ceiling");
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCanonicalIdentifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success || parsed.data !== parsed.data.trim()) {
    fail("SCOPE_IDENTIFIER_INVALID", `${label} is not a canonical identifier`);
  }
  return parsed.data;
}

function preflightScopeExpression(value: unknown): void {
  type Frame = { readonly phase: "ENTER"; readonly value: unknown; readonly depth: number } |
    { readonly phase: "EXIT"; readonly value: object };
  let atoms = 0;
  let selected = 0;
  const active = new WeakSet<object>();
  const pending: Frame[] = [{ phase: "ENTER", value, depth: 1 }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.phase === "EXIT") { active.delete(frame.value); continue; }
    if (frame.depth > MAX_SCOPE_DEPTH) fail("SCOPE_EXPRESSION_TOO_DEEP", "scope expression exceeds its depth ceiling");
    if (!isRecord(frame.value)) {
      atoms += 1;
    } else {
      const objectValue: object = frame.value;
      if (active.has(objectValue)) fail("SCOPE_EXPRESSION_CYCLIC", "scope expression contains a cycle");
      active.add(objectValue);
      pending.push({ phase: "EXIT", value: objectValue });
      const kind = frame.value.kind;
      if (kind === "UNION" || kind === "INTERSECT" || kind === "EXCEPT") {
        pending.push(
          { phase: "ENTER", value: frame.value.right, depth: frame.depth + 1 },
          { phase: "ENTER", value: frame.value.left, depth: frame.depth + 1 },
        );
      } else {
        atoms += 1;
        if (kind === "SELECTED_SOURCES" && Array.isArray(frame.value.source_ids)) selected += frame.value.source_ids.length;
      }
    }
    if (atoms > MAX_SCOPE_ATOMS) fail("SCOPE_ATOM_LIMIT", "scope expression exceeds its atom ceiling");
    if (selected > MAX_SELECTED_SOURCE_IDS) {
      fail("SCOPE_SELECTED_SOURCE_LIMIT", "scope expression selects too many source IDs");
    }
  }
}

function parseExpression(value: unknown): ScopeExpression {
  preflightScopeExpression(value);
  const parsed = ScopeExpressionSchema.safeParse(value);
  if (!parsed.success) fail("SCOPE_EXPRESSION_INVALID", "scope expression failed strict validation");
  const metrics = inspectScopeExpression(parsed.data);
  if (metrics.depth > MAX_SCOPE_DEPTH) fail("SCOPE_EXPRESSION_TOO_DEEP", "scope expression exceeds its depth ceiling");
  if (metrics.atom_count > MAX_SCOPE_ATOMS) fail("SCOPE_ATOM_LIMIT", "scope expression exceeds its atom ceiling");
  if (metrics.selected_source_count > MAX_SELECTED_SOURCE_IDS) {
    fail("SCOPE_SELECTED_SOURCE_LIMIT", "scope expression selects too many source IDs");
  }
  return normalizeScopeExpression(parsed.data);
}

function parseAtomResolution(raw: unknown, maximumMembers: number): DeterministicScopeAtomResolution {
  if (!isRecord(raw) || !Array.isArray(raw.members)) {
    fail("SCOPE_RESOLUTION_FAILED", "scope atom resolution has an invalid shape");
  }
  exactKeys(raw, ["atom_generation_ref", "members"], "scope atom resolution");
  if (raw.members.length > maximumMembers) fail("SCOPE_MEMBER_LIMIT", "scope atom resolution exceeds the member ceiling");
  const members: DeterministicScopeMember[] = raw.members.map((member) => {
    if (!isRecord(member)) fail("SCOPE_RESOLUTION_FAILED", "scope atom member has an invalid shape");
    exactKeys(member, ["source_revision_ref", "source_owner_generation", "policy_closure_ref"], "scope atom member");
    return {
      source_revision_ref: parseCanonicalIdentifier(member.source_revision_ref, "source_revision_ref"),
      source_owner_generation: parseCanonicalIdentifier(member.source_owner_generation, "source_owner_generation"),
      policy_closure_ref: parseCanonicalIdentifier(member.policy_closure_ref, "policy_closure_ref"),
    };
  });
  return {
    atom_generation_ref: parseCanonicalIdentifier(raw.atom_generation_ref, "atom_generation_ref"),
    members,
  };
}

function sortedRecord(entries: readonly (readonly [string, string])[]): Readonly<Record<string, string>> {
  const output = new Map<string, string>();
  for (const [key, value] of entries) {
    const prior = output.get(key);
    if (prior !== undefined && prior !== value) {
      fail("SCOPE_GENERATION_CONFLICT", "scope generation authority conflicts for one identity");
    }
    output.set(key, value);
  }
  return Object.fromEntries([...output.entries()].sort(([left], [right]) => compareText(left, right)));
}

function recordWithout(record: Readonly<Record<string, string>>, omittedKey: string): Readonly<Record<string, string>> {
  return sortedRecord(Object.entries(record).filter(([key]) => key !== omittedKey));
}
function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
async function participantKey(atom: DeterministicScopeAtom): Promise<string> {
  return `participant-${(await sha256Hex(`eliotr.scope.participant.v1\0${scopeExpressionIdentity(atom)}`)).slice(0, 48)}`;
}
async function memberPolicyClosureGeneration(policyClosures: Readonly<Record<string, string>>): Promise<string> {
  return `policy-closure-${(await sha256Hex(`eliotr.scope.member-policy-closure.v1\0${canonicalJson(policyClosures)}`)).slice(0, 48)}`;
}

function parseAuthority(raw: unknown, members: readonly string[], maximumMembers: number): ScopeAuthorityClosure {
  if (!isRecord(raw) || typeof raw.client_fence_valid !== "boolean" || !Array.isArray(raw.denied_source_revision_refs)) {
    fail("SCOPE_AUTHORITY_INVALID", "scope authority closure has an invalid shape");
  }
  const expectedKeys = [
    "policy_authority_ref", "disclosure_closure_digest", "purge_ledger_revision",
    "client_fence_valid", "denied_source_revision_refs",
  ];
  if (!sameArray(Object.keys(raw).sort(compareText), expectedKeys.sort(compareText))) {
    fail("SCOPE_AUTHORITY_INVALID", "scope authority closure contains unknown or missing fields");
  }
  if (raw.denied_source_revision_refs.length > maximumMembers) {
    fail("SCOPE_AUTHORITY_INVALID", "scope authority deny set exceeds the member ceiling");
  }
  const purge = PositiveIntegerSchema.safeParse(raw.purge_ledger_revision);
  const disclosure = Sha256Schema.safeParse(raw.disclosure_closure_digest);
  if (!purge.success || !disclosure.success) {
    fail("SCOPE_AUTHORITY_INVALID", "scope authority generation or digest is invalid");
  }
  const parsedDenied = raw.denied_source_revision_refs.map((value) =>
    parseCanonicalIdentifier(value, "denied_source_revision_ref"));
  if (new Set(parsedDenied).size !== parsedDenied.length) {
    fail("SCOPE_AUTHORITY_INVALID", "scope authority deny set contains duplicate revisions");
  }
  const denied = uniqueSorted(parsedDenied);
  const memberSet = new Set(members);
  if (denied.some((revision) => !memberSet.has(revision))) {
    fail("SCOPE_AUTHORITY_INVALID", "scope authority denied an unrelated source revision");
  }
  return {
    policy_authority_ref: parseCanonicalIdentifier(raw.policy_authority_ref, "policy_authority_ref"),
    disclosure_closure_digest: disclosure.data,
    purge_ledger_revision: purge.data,
    client_fence_valid: raw.client_fence_valid,
    denied_source_revision_refs: denied,
  };
}

async function resolveState(
  repository: ScopeRepository, rawExpression: unknown, observedAt: string,
  clientFenceRef: string | undefined, maximumMembers: number,
): Promise<ResolvedScopeState> {
  const expression = parseExpression(rawExpression);
  const cache = new Map<string, Promise<DeterministicScopeAtomResolution>>();
  let resolutionMemberRows = 0;
  const resolver = {
    resolve(atom: DeterministicScopeAtom): Promise<DeterministicScopeAtomResolution> {
      const identity = scopeExpressionIdentity(atom);
      const cached = cache.get(identity);
      if (cached !== undefined) return cached;
      const pending = (async () => {
        try {
          const parsed = parseAtomResolution(await repository.resolveAtom(atom, observedAt), maximumMembers);
          resolutionMemberRows += parsed.members.length;
          if (resolutionMemberRows > MAX_RESOLUTION_MEMBER_ROWS) {
            fail("SCOPE_RESOLUTION_ROW_LIMIT", "scope atom resolutions exceed the total row ceiling");
          }
          return parsed;
        } catch (error) {
          if (error instanceof ScopeServiceError) throw error;
          fail("SCOPE_RESOLUTION_FAILED", "scope atom resolution failed");
        }
      })();
      cache.set(identity, pending);
      return pending;
    },
  };

  let draft;
  try { draft = await resolveDeterministicScopeSnapshotDraft(expression, resolver); }
  catch (error) {
    if (error instanceof ScopeServiceError) throw error;
    fail("SCOPE_RESOLUTION_FAILED", "deterministic scope evaluation failed");
  }
  if (draft.members.length > maximumMembers) fail("SCOPE_MEMBER_LIMIT", "resolved scope exceeds the member ceiling");

  const participantEntries: [string, string][] = [];
  for (const atom of scopeExpressionAtoms(expression)) {
    participantEntries.push([await participantKey(atom), (await resolver.resolve(atom)).atom_generation_ref]);
  }
  const resolvedMembers = [...draft.members].sort((left, right) => compareText(left.source_revision_ref, right.source_revision_ref));
  const memberRefs = resolvedMembers.map((member) => member.source_revision_ref);
  const ownerGenerations = sortedRecord(resolvedMembers.map((member) =>
    [member.source_revision_ref, member.source_owner_generation] as const));
  const policyClosures = sortedRecord(resolvedMembers.map((member) =>
    [member.source_revision_ref, member.policy_closure_ref] as const));
  participantEntries.push([MEMBER_POLICY_CLOSURE_PARTICIPANT, await memberPolicyClosureGeneration(policyClosures)]);
  const participantGenerations = sortedRecord(participantEntries);

  let rawAuthority: ScopeAuthorityClosure;
  try {
    rawAuthority = await repository.resolveAuthorityClosure({
      expression, canonical_expression: draft.canonical_expression,
      member_source_revision_refs: memberRefs, member_policy_closure_refs: policyClosures,
      observed_at: observedAt,
      ...(clientFenceRef === undefined ? {} : { client_fence_ref: clientFenceRef }),
    });
  } catch (_error) {
    fail("SCOPE_AUTHORITY_UNAVAILABLE", "scope authority closure could not be resolved");
  }
  return {
    expression, participant_generations: participantGenerations,
    member_source_revision_refs: memberRefs, source_owner_generations: ownerGenerations,
    authority: parseAuthority(rawAuthority, memberRefs, maximumMembers),
  };
}

function snapshotMaterial(snapshot: ScopeSnapshot): Omit<ScopeSnapshot, "snapshot_id" | "digest"> {
  return {
    revision: snapshot.revision, resolved_scope_expression: snapshot.resolved_scope_expression,
    participant_generations: snapshot.participant_generations,
    member_source_revision_refs: [...snapshot.member_source_revision_refs],
    source_owner_generations: snapshot.source_owner_generations,
    policy_authority_ref: snapshot.policy_authority_ref,
    disclosure_closure_digest: snapshot.disclosure_closure_digest,
    purge_ledger_revision: snapshot.purge_ledger_revision,
    ...(snapshot.client_fence_ref === undefined ? {} : { client_fence_ref: snapshot.client_fence_ref }),
    created_at: snapshot.created_at, expires_at: snapshot.expires_at,
  };
}

async function expectedSnapshotIdentity(
  material: Omit<ScopeSnapshot, "snapshot_id" | "digest">,
): Promise<Pick<ScopeSnapshot, "snapshot_id" | "digest">> {
  const identityMaterial = scopeSnapshotIdentityPayload(material);
  const identityJson = canonicalJson(identityMaterial);
  requireCanonicalSize(identityJson);
  const snapshotId = `scope-${(await sha256Hex(identityJson)).slice(0, 48)}`;
  const digestJson = canonicalJson(scopeSnapshotDigestPayload({ snapshot_id: snapshotId, ...material }));
  requireCanonicalSize(digestJson);
  return { snapshot_id: snapshotId, digest: await sha256Hex(digestJson) };
}

function snapshotPreflightReason(value: unknown, maximumMembers: number): string | null {
  if (!isRecord(value)) return null;
  try { preflightScopeExpression(value.resolved_scope_expression); }
  catch (_error) { return "SNAPSHOT_EXPRESSION_RESOURCE_LIMIT"; }
  if (Array.isArray(value.member_source_revision_refs) && value.member_source_revision_refs.length > maximumMembers) {
    return "SNAPSHOT_MEMBER_LIMIT";
  }
  if (isRecord(value.source_owner_generations) && Object.keys(value.source_owner_generations).length > maximumMembers) {
    return "SNAPSHOT_OWNER_GENERATION_LIMIT";
  }
  if (isRecord(value.participant_generations) && Object.keys(value.participant_generations).length > MAX_SCOPE_ATOMS + 1) {
    return "SNAPSHOT_PARTICIPANT_LIMIT";
  }
  return null;
}

async function integrityReasons(snapshot: ScopeSnapshot): Promise<string[]> {
  const reasons: string[] = [];
  if (canonicalJson(normalizeScopeExpression(snapshot.resolved_scope_expression)) !==
      canonicalJson(snapshot.resolved_scope_expression)) reasons.push("SNAPSHOT_EXPRESSION_NON_CANONICAL");
  const canonicalMembers = uniqueSorted(snapshot.member_source_revision_refs);
  if (!sameArray(snapshot.member_source_revision_refs, canonicalMembers)) reasons.push("SNAPSHOT_MEMBERS_NON_CANONICAL");
  if (!sameArray(uniqueSorted(Object.keys(snapshot.source_owner_generations)), canonicalMembers)) {
    reasons.push("SNAPSHOT_OWNER_GENERATIONS_MISMATCH");
  }
  if (snapshot.participant_generations[MEMBER_POLICY_CLOSURE_PARTICIPANT] === undefined) {
    reasons.push("SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING");
  }
  if (Date.parse(snapshot.expires_at) <= Date.parse(snapshot.created_at)) reasons.push("SNAPSHOT_INTERVAL_INVALID");
  try {
    const expected = await expectedSnapshotIdentity(snapshotMaterial(snapshot));
    if (expected.snapshot_id !== snapshot.snapshot_id) reasons.push("SNAPSHOT_ID_MISMATCH");
    if (expected.digest !== snapshot.digest) reasons.push("SNAPSHOT_DIGEST_MISMATCH");
  } catch (error) {
    reasons.push(error instanceof ScopeServiceError && error.code === "SCOPE_SNAPSHOT_TOO_LARGE"
      ? "SNAPSHOT_CANONICAL_SIZE_INVALID" : "SNAPSHOT_IDENTITY_INVALID");
  }
  return reasons;
}

function parseNow(now: () => number): number {
  let value: number;
  try { value = now(); }
  catch (_error) { fail("SCOPE_CLOCK_INVALID", "scope clock failed"); }
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    fail("SCOPE_CLOCK_INVALID", "scope clock returned an invalid instant");
  }
  return value;
}

function resolveOptions(options: ScopeServiceOptions): Required<ScopeServiceOptions> {
  const ttl = options.ttl_ms ?? DEFAULT_TTL_MS;
  const maximumMembers = options.max_snapshot_members ?? DEFAULT_MAX_SNAPSHOT_MEMBERS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) {
    fail("SCOPE_TTL_INVALID", "scope snapshot TTL is outside its allowed range");
  }
  if (!Number.isSafeInteger(maximumMembers) || maximumMembers <= 0 || maximumMembers > MAX_SNAPSHOT_MEMBERS) {
    fail("SCOPE_MEMBER_LIMIT_INVALID", "scope member ceiling is outside its allowed range");
  }
  return { now: options.now ?? Date.now, ttl_ms: ttl, max_snapshot_members: maximumMembers };
}

function currentness(current: boolean, reasons: readonly string[]): ScopeCurrentness {
  return { current, invalidation_reason_codes: uniqueSorted(reasons) };
}

// IMPLEMENTED_NOT_LIVE: ER-30 scope snapshot persistence requires ER-24 D1 composition and retained live receipts.
export function createScopeService(repository: ScopeRepository, rawOptions: ScopeServiceOptions = {}): ScopeService {
  const options = resolveOptions(rawOptions);
  const validateCurrent = async (rawSnapshot: ScopeSnapshot): Promise<ScopeCurrentness> => {
    const preflight = snapshotPreflightReason(rawSnapshot, options.max_snapshot_members);
    if (preflight !== null) return currentness(false, [preflight]);
    const parsed = ScopeSnapshotSchema.safeParse(rawSnapshot);
    if (!parsed.success) return currentness(false, ["SNAPSHOT_INVALID"]);
    const snapshot = parsed.data;
    const reasons = await integrityReasons(snapshot);
    const observedMs = parseNow(options.now);
    if (observedMs >= Date.parse(snapshot.expires_at)) reasons.push("SNAPSHOT_EXPIRED");

    let persisted: ScopeSnapshot | null;
    try { persisted = await repository.readSnapshot(snapshot.snapshot_id, snapshot.revision); }
    catch (_error) { return currentness(false, [...reasons, "SNAPSHOT_READ_FAILED"]); }
    if (persisted === null) {
      reasons.push("SNAPSHOT_NOT_PERSISTED");
    } else {
      const persistedPreflight = snapshotPreflightReason(persisted, options.max_snapshot_members);
      const persistedParsed = persistedPreflight === null ? ScopeSnapshotSchema.safeParse(persisted) : null;
      if (persistedParsed === null || !persistedParsed.success) reasons.push("SNAPSHOT_PERSISTED_RECORD_INVALID");
      else if (canonicalJson(persistedParsed.data) !== canonicalJson(snapshot)) {
        reasons.push("SNAPSHOT_PERSISTED_RECORD_MISMATCH");
      }
    }
    if (reasons.length > 0) return currentness(false, reasons);

    let resolved: ResolvedScopeState;
    try {
      resolved = await resolveState(
        repository, snapshot.resolved_scope_expression, new Date(observedMs).toISOString(),
        snapshot.client_fence_ref, options.max_snapshot_members,
      );
    } catch (error) {
      return currentness(false, [error instanceof ScopeServiceError ? error.code : "SCOPE_RESOLUTION_FAILED"]);
    }
    if (snapshot.participant_generations[MEMBER_POLICY_CLOSURE_PARTICIPANT] !==
        resolved.participant_generations[MEMBER_POLICY_CLOSURE_PARTICIPANT]) {
      reasons.push("MEMBER_POLICY_CLOSURE_STALE");
    }
    if (!sameRecord(
      recordWithout(snapshot.participant_generations, MEMBER_POLICY_CLOSURE_PARTICIPANT),
      recordWithout(resolved.participant_generations, MEMBER_POLICY_CLOSURE_PARTICIPANT),
    )) reasons.push("PARTICIPANT_GENERATION_STALE");
    if (!sameArray(snapshot.member_source_revision_refs, resolved.member_source_revision_refs)) {
      reasons.push("SCOPE_MEMBERSHIP_CHANGED");
    }
    if (!sameRecord(snapshot.source_owner_generations, resolved.source_owner_generations)) {
      reasons.push("SOURCE_OWNER_GENERATION_STALE");
    }
    if (snapshot.policy_authority_ref !== resolved.authority.policy_authority_ref) reasons.push("POLICY_AUTHORITY_STALE");
    if (snapshot.disclosure_closure_digest !== resolved.authority.disclosure_closure_digest) {
      reasons.push("DISCLOSURE_CLOSURE_STALE");
    }
    if (snapshot.purge_ledger_revision !== resolved.authority.purge_ledger_revision) {
      reasons.push(resolved.authority.purge_ledger_revision > snapshot.purge_ledger_revision ?
        "PURGE_LEDGER_ADVANCED" : "PURGE_LEDGER_ROLLBACK");
    }
    if (snapshot.client_fence_ref !== undefined && !resolved.authority.client_fence_valid) {
      reasons.push("CLIENT_FENCE_STALE");
    }
    if (resolved.authority.denied_source_revision_refs.length > 0) reasons.push("NEW_DENY_APPLIES");
    return currentness(reasons.length === 0, reasons);
  };

  return {
    async freeze(rawExpression, rawClientFenceRef) {
      const observedMs = parseNow(options.now);
      if (observedMs + options.ttl_ms > MAX_DATE_MS) fail("SCOPE_CLOCK_INVALID", "scope expiry exceeds the date range");
      const observedAt = new Date(observedMs).toISOString();
      const clientFenceRef = rawClientFenceRef === undefined ? undefined :
        parseCanonicalIdentifier(rawClientFenceRef, "client_fence_ref");
      const resolved = await resolveState(
        repository, rawExpression, observedAt, clientFenceRef, options.max_snapshot_members,
      );
      if (clientFenceRef !== undefined && !resolved.authority.client_fence_valid) {
        fail("CLIENT_FENCE_STALE", "client fence is stale");
      }
      if (resolved.authority.denied_source_revision_refs.length > 0) {
        fail("SCOPE_DENIED", "resolved scope contains denied source revisions");
      }
      const material: Omit<ScopeSnapshot, "snapshot_id" | "digest"> = {
        revision: 1, resolved_scope_expression: resolved.expression,
        participant_generations: { ...resolved.participant_generations },
        member_source_revision_refs: [...resolved.member_source_revision_refs],
        source_owner_generations: { ...resolved.source_owner_generations },
        policy_authority_ref: resolved.authority.policy_authority_ref,
        disclosure_closure_digest: resolved.authority.disclosure_closure_digest,
        purge_ledger_revision: resolved.authority.purge_ledger_revision,
        ...(clientFenceRef === undefined ? {} : { client_fence_ref: clientFenceRef }),
        created_at: observedAt, expires_at: new Date(observedMs + options.ttl_ms).toISOString(),
      };
      const parsed = ScopeSnapshotSchema.safeParse({ ...material, ...await expectedSnapshotIdentity(material) });
      if (!parsed.success) fail("SCOPE_SNAPSHOT_INVALID", "resolved scope snapshot failed strict validation");
      requireCanonicalSize(canonicalJson(parsed.data));

      let outcome: ScopePersistenceOutcome;
      try { outcome = await repository.persistSnapshot(parsed.data); }
      catch (_error) { fail("SCOPE_PERSISTENCE_INVALID", "scope snapshot persistence failed"); }
      if (outcome !== "CREATED" && outcome !== "REPLAY" && outcome !== "CONFLICT") {
        fail("SCOPE_PERSISTENCE_INVALID", "scope repository returned an unknown persistence outcome");
      }
      if (outcome === "CONFLICT") fail("SCOPE_SNAPSHOT_CONFLICT", "scope snapshot conflicts with authority");

      let readback: ScopeSnapshot | null;
      try { readback = await repository.readSnapshot(parsed.data.snapshot_id, parsed.data.revision); }
      catch (_error) { fail("SCOPE_SNAPSHOT_READBACK_MISMATCH", "scope snapshot readback failed"); }
      const preflight = snapshotPreflightReason(readback, options.max_snapshot_members);
      const readbackParsed = preflight === null ? ScopeSnapshotSchema.safeParse(readback) : null;
      if (readbackParsed === null || !readbackParsed.success ||
          canonicalJson(readbackParsed.data) !== canonicalJson(parsed.data)) {
        fail("SCOPE_SNAPSHOT_READBACK_MISMATCH", "scope snapshot readback differs from persisted bytes");
      }
      return readbackParsed.data;
    },

    validateCurrent,

    async requireCurrent(snapshot) {
      const result = await validateCurrent(snapshot);
      if (!result.current) fail("SCOPE_SNAPSHOT_STALE", "scope snapshot is not current", result.invalidation_reason_codes);
      return ScopeSnapshotSchema.parse(snapshot);
    },
  };
}

/** Compose real snapshot storage without inventing a principal or mutable policy authority. */
export function createD1ScopeService(
  database: D1Database,
  authority: Pick<ScopeRepository, "resolveAtom" | "resolveAuthorityClosure">,
  options: ScopeServiceOptions = {},
): ScopeService {
  const storage = createD1ScopeSnapshotStore(database);
  return createScopeService({
    resolveAtom: (atom, observedAt) => authority.resolveAtom(atom, observedAt),
    resolveAuthorityClosure: (request) => authority.resolveAuthorityClosure(request),
    persistSnapshot: (snapshot) => storage.persistSnapshot(snapshot),
    readSnapshot: (id, revision) => storage.readSnapshot(id, revision),
  }, options);
}
