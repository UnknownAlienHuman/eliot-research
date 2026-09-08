import type { EvidenceHandle, ResolvedEvidence, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import type { EvidenceMaterializerPort, EvidenceRegistryPort } from "@eliotr/retrieval";
import type { FailureInjector } from "./failure-injection.js";
import { NoopFailureInjector } from "./failure-injection.js";
import type { Clock } from "./clock.js";
import { FakeClock } from "./clock.js";
import { sha256Hex } from "./digest.js";

function key(ref: VersionedRef): string { return `${ref.id}@${ref.revision}`; }

export class InMemoryEvidenceRegistry implements EvidenceRegistryPort {
  private readonly handles = new Map<string, EvidenceHandle>();
  public seed(handle: EvidenceHandle): void { this.handles.set(key(handle.handle_ref), handle); }
  public async loadHandle(ref: VersionedRef): Promise<EvidenceHandle | null> { return this.handles.get(key(ref)) ?? null; }
  public async findOrCreateHandle(): Promise<EvidenceHandle> { throw new Error("test must seed exact evidence handles"); }
}

export class InMemoryEvidenceMaterializer implements EvidenceMaterializerPort {
  private readonly resolved = new Map<string, ResolvedEvidence>();
  public seed(value: ResolvedEvidence): void { this.resolved.set(key(value.handle.handle_ref), value); }
  public async materialize(handle: EvidenceHandle): Promise<ResolvedEvidence> {
    const value = this.resolved.get(key(handle.handle_ref));
    if (value === undefined) throw new Error(`missing materialized evidence ${key(handle.handle_ref)}`);
    return value;
  }
}

export class ScopeFixtureBuilder {
  public static empty(): ScopeSnapshot {
    return {
      snapshot_id: "scope-1", revision: 1, resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
      participant_generations: {}, member_source_revision_refs: [], source_owner_generations: {},
      policy_authority_ref: "policy-1", disclosure_closure_digest: "0".repeat(64), purge_ledger_revision: 1,
      digest: "1".repeat(64), created_at: "2026-08-28T00:00:00Z", expires_at: "2026-08-29T00:00:00Z",
    };
  }
}

export class LostAckError extends Error {
  public readonly code = "LOST_ACK_UNKNOWN";
  public constructor(message = "lost acknowledgement: settlement UNKNOWN, readback required") {
    super(message);
    this.name = "LostAckError";
  }
}

export class StaleGenerationError extends Error {
  public readonly code = "STALE_GENERATION";
  public constructor(message = "stale generation fence") {
    super(message);
    this.name = "StaleGenerationError";
  }
}

export class TamperDetectedError extends Error {
  public readonly code = "TAMPER_DETECTED";
  public constructor(message = "digest mismatch: tamper detected") {
    super(message);
    this.name = "TamperDetectedError";
  }
}

export class PartialWriteError extends Error {
  public readonly code = "PARTIAL_WRITE";
  public constructor(message = "partial write: first chunk persisted, receipt withheld") {
    super(message);
    this.name = "PartialWriteError";
  }
}

export class PurgeBlockedError extends Error {
  public readonly code = "PURGE_BLOCKED";
  public constructor(message = "purge blocked by legal hold") {
    super(message);
    this.name = "PurgeBlockedError";
  }
}

export interface FakeHarnessDeps {
  readonly clock?: Clock;
  readonly injector?: FailureInjector;
}

function depsClock(deps: FakeHarnessDeps | undefined): Clock {
  if (deps?.clock !== undefined) return deps.clock;
  return new FakeClock(new Date("2026-09-08T00:00:00.000Z"));
}

function depsInjector(deps: FakeHarnessDeps | undefined): FailureInjector {
  if (deps?.injector !== undefined) return deps.injector;
  return new NoopFailureInjector();
}

export interface D1Row {
  readonly value: string;
  readonly generation: string;
}

export class FakeD1Store {
  private readonly rows = new Map<string, D1Row>();
  private readonly clock: Clock;
  private readonly injector: FailureInjector;

  public constructor(deps?: FakeHarnessDeps) {
    this.clock = depsClock(deps);
    this.injector = depsInjector(deps);
  }

  public async insert(id: string, value: string, generation: string): Promise<void> {
    await this.injector.hit("BEFORE_INTENT_COMMIT");
    if (this.rows.has(id)) throw new Error(`D1_DUPLICATE:${id}`);
    this.rows.set(id, { value, generation });
  }

  public async compareAndSwap(id: string, expectedGeneration: string, value: string, nextGeneration: string): Promise<void> {
    await this.injector.hit("BEFORE_INTENT_COMMIT");
    const current = this.rows.get(id);
    if (current === undefined) throw new Error(`D1_MISSING:${id}`);
    if (current.generation !== expectedGeneration) {
      await this.injector.hit("STALE_OWNER_GENERATION");
      throw new StaleGenerationError(`stale generation for ${id}: expected ${expectedGeneration} observed ${current.generation}`);
    }
    this.rows.set(id, { value, generation: nextGeneration });
  }

  public async commitWithLostAck(id: string, value: string, generation: string): Promise<void> {
    this.rows.set(id, { value, generation });
    await this.injector.hit("AFTER_RECEIPT_BEFORE_ACK");
    throw new LostAckError(`lost ACK after commit of ${id} at ${this.clock.nowIso()}`);
  }

  public async read(id: string): Promise<D1Row | null> {
    await this.injector.hit("DURING_READBACK");
    return this.rows.get(id) ?? null;
  }

  public committedIds(): readonly string[] {
    return [...this.rows.keys()].sort();
  }
}

export interface R2Object {
  readonly content: string;
  readonly sha256: string;
  readonly generation: string;
}

export class FakeR2Store {
  private readonly objects = new Map<string, R2Object>();
  private readonly legalHold = new Set<string>();
  private readonly injector: FailureInjector;

  public constructor(deps?: FakeHarnessDeps) {
    this.injector = depsInjector(deps);
  }

  public async put(objectKey: string, content: string, generation: string): Promise<string> {
    await this.injector.hit("BEFORE_INTENT_COMMIT");
    const digest = await sha256Hex(content);
    this.objects.set(objectKey, { content, sha256: digest, generation });
    return digest;
  }

  public async putPartial(objectKey: string, firstChunk: string, _remaining: string, generation: string): Promise<never> {
    const digest = await sha256Hex(firstChunk);
    this.objects.set(objectKey, { content: firstChunk, sha256: `partial:${digest}`, generation });
    await this.injector.hit("AFTER_SIDE_EFFECT_BEFORE_RECEIPT");
    throw new PartialWriteError(`partial write of ${objectKey}: first chunk persisted`);
  }

  public tamper(objectKey: string, corrupted: string): void {
    const current = this.objects.get(objectKey);
    if (current === undefined) throw new Error(`R2_MISSING:${objectKey}`);
    this.objects.set(objectKey, { content: corrupted, sha256: current.sha256, generation: current.generation });
  }

  public async get(objectKey: string): Promise<R2Object> {
    await this.injector.hit("DURING_READBACK");
    const current = this.objects.get(objectKey);
    if (current === undefined) throw new Error(`R2_MISSING:${objectKey}`);
    if (current.sha256.startsWith("partial:")) {
      throw new PartialWriteError(`incomplete object ${objectKey}`);
    }
    const observed = await sha256Hex(current.content);
    if (observed !== current.sha256) {
      await this.injector.hit("DRIVE_ROW_TAMPERED");
      throw new TamperDetectedError(`tamper detected for ${objectKey}`);
    }
    return current;
  }

  public hold(objectKey: string): void {
    this.legalHold.add(objectKey);
  }

  public async delete(objectKey: string): Promise<void> {
    await this.injector.hit("BEFORE_INTENT_COMMIT");
    if (this.legalHold.has(objectKey)) {
      throw new PurgeBlockedError(`purge blocked for ${objectKey}`);
    }
    if (this.objects.delete(objectKey) === false) throw new Error(`R2_MISSING:${objectKey}`);
  }

  public storedKeys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }
}

export interface QueueReceipt {
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly acked: boolean;
}

export class FakeQueue {
  private readonly messages = new Map<string, { readonly payload: string; acked: boolean }>();
  private readonly injector: FailureInjector;
  private counter = 0;

  public constructor(deps?: FakeHarnessDeps) {
    this.injector = depsInjector(deps);
  }

  public async send(payload: string, idempotencyKey: string): Promise<QueueReceipt> {
    await this.injector.hit("AFTER_INTENT_BEFORE_QUEUE");
    const existing = this.messages.get(idempotencyKey);
    if (existing !== undefined) {
      return { messageId: `msg-${idempotencyKey}`, idempotencyKey, acked: existing.acked };
    }
    this.counter += 1;
    this.messages.set(idempotencyKey, { payload, acked: false });
    return { messageId: `msg-${idempotencyKey}-${String(this.counter)}`, idempotencyKey, acked: false };
  }

  public async ackWithLoss(idempotencyKey: string): Promise<never> {
    const current = this.messages.get(idempotencyKey);
    if (current === undefined) throw new Error(`QUEUE_MISSING:${idempotencyKey}`);
    this.messages.set(idempotencyKey, { payload: current.payload, acked: true });
    await this.injector.hit("AFTER_RECEIPT_BEFORE_ACK");
    throw new LostAckError(`lost ACK after ack of ${idempotencyKey}: settlement UNKNOWN`);
  }

  public async ack(idempotencyKey: string): Promise<void> {
    const current = this.messages.get(idempotencyKey);
    if (current === undefined) throw new Error(`QUEUE_MISSING:${idempotencyKey}`);
    this.messages.set(idempotencyKey, { payload: current.payload, acked: true });
  }

  public async readback(idempotencyKey: string): Promise<QueueReceipt | null> {
    await this.injector.hit("DURING_READBACK");
    const current = this.messages.get(idempotencyKey);
    if (current === undefined) return null;
    return { messageId: `msg-${idempotencyKey}`, idempotencyKey, acked: current.acked };
  }

  public pendingKeys(): readonly string[] {
    return [...this.messages.entries()].filter(([, value]) => !value.acked).map(([id]) => id).sort();
  }
}

export interface AiLocator {
  readonly candidateId: string;
  readonly sourceRevisionRef: string;
  readonly sectionRef: string;
  readonly generation: string;
}

export class FakeAiSearchIndex {
  private readonly entries = new Map<string, { readonly text: string; readonly generation: string }>();
  private readonly injector: FailureInjector;

  public constructor(deps?: FakeHarnessDeps) {
    this.injector = depsInjector(deps);
  }

  public async index(candidateId: string, text: string, generation: string): Promise<void> {
    if (candidateId.length === 0) throw new Error("EMPTY_CANDIDATE_ID");
    if (new TextEncoder().encode(text).length > 32 * 1024) throw new Error("OVERSIZED_INDEX_TEXT");
    this.entries.set(candidateId, { text, generation });
  }

  public async search(query: string, generation: string, limit = 20): Promise<readonly AiLocator[]> {
    if (query.trim().length === 0) throw new Error("EMPTY_QUERY");
    if (new TextEncoder().encode(query).length > 8 * 1024) throw new Error("OVERSIZED_QUERY");
    await this.injector.hit("DURING_READBACK");
    const out: AiLocator[] = [];
    for (const [candidateId, entry] of this.entries) {
      if (entry.generation !== generation) continue;
      if (entry.text.toLowerCase().includes(query.toLowerCase())) {
        const parts = candidateId.split(":");
        const source = parts[0] ?? candidateId;
        const section = parts[1] ?? "section-1";
        out.push({ candidateId, sourceRevisionRef: source, sectionRef: section, generation });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  public indexedIds(): readonly string[] {
    return [...this.entries.keys()].sort();
  }
}

export interface FakeModelInput {
  readonly routeRef: string;
  readonly promptGeneration: string;
  readonly evidenceDigest: string;
  readonly maxOutputBytes: number;
}

export interface FakeModelReceipt {
  readonly receiptRef: string;
  readonly outputSha256: string;
}

export class FakeModelGateway {
  private counter = 0;
  private readonly injector: FailureInjector;

  public constructor(deps?: FakeHarnessDeps) {
    this.injector = depsInjector(deps);
  }

  public async execute(input: FakeModelInput): Promise<FakeModelReceipt> {
    if (input.routeRef.length === 0) throw new Error("EMPTY_ROUTE_REF");
    if (input.maxOutputBytes <= 0) throw new Error("INVALID_MAX_OUTPUT_BYTES");
    if (input.maxOutputBytes > 64 * 1024) throw new Error("OVERSIZED_MODEL_OUTPUT");
    await this.injector.hit("BEFORE_INTENT_COMMIT");
    this.counter += 1;
    const digest = await sha256Hex(`${input.routeRef}|${input.promptGeneration}|${input.evidenceDigest}|${String(this.counter)}`);
    return { receiptRef: `model-receipt-${String(this.counter).padStart(6, "0")}`, outputSha256: digest };
  }
}

export interface DriveRow {
  readonly rowId: string;
  readonly payload: string;
  readonly sha256: string;
  readonly generation: string;
}

export class FakeDriveExchange {
  private readonly rows = new Map<string, DriveRow>();
  private readonly injector: FailureInjector;

  public constructor(deps?: FakeHarnessDeps) {
    this.injector = depsInjector(deps);
  }

  public async append(rowId: string, payload: string, generation: string, expectedGeneration: string): Promise<string> {
    if (generation !== expectedGeneration) {
      await this.injector.hit("STALE_OWNER_GENERATION");
      throw new StaleGenerationError(`stale drive generation for ${rowId}`);
    }
    if (this.rows.has(rowId)) throw new Error(`DRIVE_DUPLICATE:${rowId}`);
    await this.injector.hit("BEFORE_INTENT_COMMIT");
    const digest = await sha256Hex(payload);
    this.rows.set(rowId, { rowId, payload, sha256: digest, generation });
    return digest;
  }

  public tamper(rowId: string, corrupted: string): void {
    const current = this.rows.get(rowId);
    if (current === undefined) throw new Error(`DRIVE_MISSING:${rowId}`);
    this.rows.set(rowId, { rowId, payload: corrupted, sha256: current.sha256, generation: current.generation });
  }

  public async read(rowId: string): Promise<DriveRow> {
    await this.injector.hit("DURING_READBACK");
    const current = this.rows.get(rowId);
    if (current === undefined) throw new Error(`DRIVE_MISSING:${rowId}`);
    const observed = await sha256Hex(current.payload);
    if (observed !== current.sha256) {
      await this.injector.hit("DRIVE_ROW_TAMPERED");
      throw new TamperDetectedError(`drive row tampered ${rowId}`);
    }
    return current;
  }

  public storedRowIds(): readonly string[] {
    return [...this.rows.keys()].sort();
  }
}
