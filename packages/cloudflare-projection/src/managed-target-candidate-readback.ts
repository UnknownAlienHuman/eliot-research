
import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import { bufferBounded } from "@eliotr/platform-cloudflare";
import type { ManagedTargetManifestCandidatePayloadV2 } from "./managed-target-manifest-contract.js";
import {
  MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2,
  ManagedTargetManifestError,
} from "./managed-target-manifest-contract.js";
import { MANAGED_TARGET_MANIFEST_PROTOCOL_V3 } from "./managed-target-manifest.js";
import type { ManifestTreeObjectRef } from "./managed-target-manifest-tree.js";
import { projectionDigest, projectionSha256Utf8, canonicalProjectionJson } from "./canonical.js";
import { putCanonicalManifestObjectIfAbsent } from "./managed-target-manifest-fragments.js";

const TREE_INDEX_PROTOCOL = "eliotr.managed-target-manifest-index.v1" as const;
const MAX_TREE_FANOUT = 256;
const MAX_TREE_DEPTH = 12;
const MAX_CANDIDATE_OBJECT_BYTES = 4 * 1024 * 1024;
const NODES_PER_STEP = 24;
/**
 * Depth-first pending-stack ceiling. A writer-built tree never needs more than one
 * fanout row per level, so this bound proves the stack stayed depth-first rather than
 * accumulating a breadth-first frontier. It keeps the durable cursor well inside its
 * fixed object byte bound even at the 102400-copy ceiling.
 */
const MAX_TREE_PENDING = MAX_TREE_FANOUT * MAX_TREE_DEPTH;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Durable step cursor for the resumable candidate tree readback. The caller persists it
 * in Work and passes it back to resume; this module never holds the whole copy set.
 */
export interface ManagedTargetCandidateReadbackCursor {
  readonly protocol: "eliotr.managed-target-manifest-candidate-readback-cursor.v1";
  readonly candidate_sha256: string;
  readonly root_key: string;
  readonly root_sha256: string;
  readonly next_ordinal: number;
  readonly pending: readonly ManifestTreeObjectRef[];
  readonly nodes_visited: number;
}

/**
 * A resume request. The cursor is only ever accepted by its exact immutable Work object
 * identity, so an external coordinator cannot resume from an unauthenticated client
 * value: the bytes are read back and their digest must match the supplied receipt.
 */
export interface ManagedTargetCandidateReadbackResume {
  readonly ref: string;
  readonly sha256: string;
}

export interface ManagedTargetCandidateReadbackStep {
  readonly protocol: "eliotr.managed-target-manifest-candidate-readback-step.v1";
  readonly status: "CONTINUE" | "COMPLETE";
  readonly cursor: { readonly ref: string; readonly sha256: string } | null;
  readonly leaves: readonly ManifestTreeObjectRef[];
  readonly next_ordinal: number;
  readonly nodes_visited: number;
}

/** The candidate payload's stored tree field, with its full immutable object identity. */
interface StoredCandidateTreeRef {
  readonly key: string;
  readonly sha256: string;
  readonly copy_count: number;
  readonly item_count: number;
}

export interface ManagedTargetCandidateTreeReadInput {
  readonly store: EvidenceObjectStore;
  /** The exact stored V3 candidate payload, as read back from Work. */
  readonly candidate: ManagedTargetManifestCandidatePayloadV2;
  readonly candidate_sha256: string;
  /**
   * A resume must name the durable cursor object. Supplying only an in-memory cursor
   * value is rejected; the cursor bytes are read back and their digest must match.
   */
  readonly cursor?: ManagedTargetCandidateReadbackResume;
  readonly cursor_prefix?: string;
}

/**
 * Bounded resumable readback of one stored V3 manifest candidate's immutable copy tree.
 *
 * The tree is walked depth-first. Each step opens at most NODES_PER_STEP Work objects,
 * so no single invocation walks the whole corpus. A production manifest of 102400 copies
 * needs many durable steps driven by an external coordinator; this reader neither
 * accumulates the corpus nor claims a one-shot full read. The pending stack is bounded by
 * MAX_TREE_FANOUT times MAX_TREE_DEPTH, which keeps the durable cursor inside its fixed
 * object byte bound; a breadth-first queue would inflate the whole corpus before the
 * first leaf and overflow it. It verifies the exact protocol discriminators, the
 * candidate bytes against candidate_sha256, ordered ordinal coverage proven leaf by leaf,
 * per-node aggregates, fanout and depth bounds, and every tree object digest against its
 * parent receipt.
 */
export async function readManagedTargetManifestCandidateTreeV3(
  input: ManagedTargetCandidateTreeReadInput,
): Promise<ManagedTargetCandidateReadbackStep> {
  const { store, candidate, candidate_sha256: candidateSha } = input;
  if (candidate.protocol !== MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2 ||
      candidate.manifest_protocol !== MANAGED_TARGET_MANIFEST_PROTOCOL_V3 ||
      candidate.copy_layout !== MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2) {
    fail("candidate protocol discriminators do not identify a stored V3 manifest candidate");
  }
  const requiredCopyCount = candidate.required_set.project_revision_copy_count;
  const treeRef = candidate.tree as StoredCandidateTreeRef | null;

  // The candidate payload is caller-supplied data, not authority. Bind it to the exact
  // immutable bytes it claims, so a mismatched or rewritten payload fails closed.
  const candidateJson = canonicalProjectionJson(candidate);
  if (candidateJson.length > MAX_CANDIDATE_OBJECT_BYTES ||
      await projectionSha256Utf8(candidateJson) !== candidateSha) {
    fail("supplied candidate payload bytes do not bind to candidate_sha256");
  }

  if (treeRef === null) {
    if (requiredCopyCount !== 0) fail("non-empty candidate lacks its tree root");
    return Object.freeze({
      protocol: "eliotr.managed-target-manifest-candidate-readback-step.v1" as const,
      status: "COMPLETE" as const,
      cursor: null,
      leaves: Object.freeze([]),
      next_ordinal: 0,
      nodes_visited: 0,
    });
  }
  if (!isSha256(treeRef.sha256) || typeof treeRef.key !== "string" || treeRef.key.length === 0 ||
      treeRef.key.length > 1024) {
    fail("candidate tree root reference is malformed");
  }
  if (treeRef.copy_count !== requiredCopyCount) {
    fail("candidate tree root copy count differs from its required-set receipt");
  }
  if (treeRef.item_count !== candidate.desired_item_count) {
    fail("candidate tree root item count differs from its desired-item count");
  }
  // The producer's tree writer returns the sole COPY leaf unchanged when the
  // manifest holds exactly one copy, and an INDEX node otherwise. The root kind is
  // therefore part of the writer contract, not a reader assumption.
  const rootKind: "COPY" | "INDEX" = requiredCopyCount === 1 ? "COPY" : "INDEX";
  const rootNode: ManifestTreeObjectRef = Object.freeze({
    kind: rootKind,
    key: treeRef.key,
    sha256: treeRef.sha256,
    size_bytes: 0,
    first_copy_ordinal: 0,
    last_copy_ordinal: requiredCopyCount - 1,
    copy_count: requiredCopyCount,
    item_count: candidate.desired_item_count,
  });

  let pending: ManifestTreeObjectRef[];
  let nextOrdinal: number;
  let nodesVisited: number;
  if (input.cursor === undefined) {
    pending = [rootNode];
    nextOrdinal = 0;
    nodesVisited = 0;
  } else {
    const storedCursor = await readCursorObject(store, input.cursor);
    if (storedCursor.candidate_sha256 !== candidateSha || storedCursor.root_key !== treeRef.key) {
      fail("readback cursor belongs to a different candidate");
    }
    if (storedCursor.pending.length === 0 && storedCursor.next_ordinal !== requiredCopyCount) {
      fail("readback cursor has no pending tree work but has not covered the required set");
    }
    pending = storedCursor.pending.map((node) => {
      if (!isTreeRef(node)) fail("readback cursor carries a malformed tree node");
      return node;
    });
    nextOrdinal = storedCursor.next_ordinal;
    nodesVisited = storedCursor.nodes_visited;
  }

  const leaves: ManifestTreeObjectRef[] = [];
  // One shared budget for every object this step opens, descent and leaf alike.
  let stepObjects = 0;
  while (pending.length > 0 && stepObjects < NODES_PER_STEP) {
    const node = pending[0];
    if (node === undefined) break;
    pending.shift();
    stepObjects += 1;
    nodesVisited += 1;
    const stored = await openTreeObject(store, node);
    if (node.kind === "COPY") {
      if (node.copy_count !== 1 || node.first_copy_ordinal !== node.last_copy_ordinal) {
        fail("copy leaf does not carry exactly one copy ordinal");
      }
      // The ordered coverage is proved by the leaves themselves: each must name the
      // exact next ordinal, so a forged or foreign leaf cannot skip or repeat one.
      if (node.first_copy_ordinal !== nextOrdinal) {
        fail(`copy leaf ordinal ${node.first_copy_ordinal} is not the next expected ordinal ${nextOrdinal}`);
      }
      leaves.push(node);
      nextOrdinal += 1;
      continue;
    }
    const payload = stored.value as {
      readonly protocol: string;
      readonly level: number;
      readonly first_copy_ordinal: number;
      readonly last_copy_ordinal: number;
      readonly copy_count: number;
      readonly item_count: number;
      readonly children: readonly ManifestTreeObjectRef[];
    };
    if (payload.protocol !== TREE_INDEX_PROTOCOL) fail(`tree node ${node.key} is not the index protocol`);
    if (payload.first_copy_ordinal !== node.first_copy_ordinal ||
        payload.last_copy_ordinal !== node.last_copy_ordinal ||
        payload.copy_count !== node.copy_count || payload.item_count !== node.item_count) {
      fail(`tree node ${node.key} header differs from its parent receipt`);
    }
    if (!Number.isSafeInteger(payload.level) || payload.level < 0 || payload.level > MAX_TREE_DEPTH) {
      fail(`tree node ${node.key} level is outside its bound`);
    }
    if (!Array.isArray(payload.children) || payload.children.length === 0 ||
        payload.children.length > MAX_TREE_FANOUT) {
      fail(`tree node ${node.key} fanout is outside its bound`);
    }
    let expectedFirst = payload.first_copy_ordinal;
    let copyTotal = 0;
    let itemTotal = 0;
    const validatedChildren: ManifestTreeObjectRef[] = [];
    // Validate every child before any is enqueued, so a malformed child never lands in
    // the durable stack and the node is either fully accepted or fully rejected.
    for (const child of payload.children) {
      if (!isTreeRef(child)) fail(`tree node ${node.key} child is malformed`);
      if (child.first_copy_ordinal !== expectedFirst) {
        fail(`tree node ${node.key} children are not contiguous in ordinal order`);
      }
      if (child.copy_count !== child.last_copy_ordinal - child.first_copy_ordinal + 1) {
        fail(`tree node ${node.key} child range is inconsistent with its copy count`);
      }
      copyTotal += child.copy_count;
      itemTotal += child.item_count;
      expectedFirst = child.last_copy_ordinal + 1;
      validatedChildren.push(child);
    }
    if (expectedFirst - 1 !== payload.last_copy_ordinal) {
      fail(`tree node ${node.key} children do not span its full ordinal range`);
    }
    if (copyTotal !== payload.copy_count || itemTotal !== payload.item_count) {
      fail(`tree node ${node.key} aggregates differ from its children`);
    }
    // Depth-first: unshift the whole validated child run once, preserving order.
    // Unshifting one child at a time would reverse the run. Pushing would turn this
    // stack into a breadth-first queue that inflates the whole corpus before any leaf,
    // which at 102400 copies overflows the durable cursor byte bound.
    pending.unshift(...validatedChildren);
    if (pending.length > MAX_TREE_PENDING) {
      fail(`tree pending stack ${pending.length} exceeds its bounded depth-times-fanout ceiling`);
    }
  }

  const complete = pending.length === 0 && nextOrdinal === requiredCopyCount;
  let cursor: { readonly ref: string; readonly sha256: string } | null = null;
  if (!complete) {
    const cursorState: ManagedTargetCandidateReadbackCursor = Object.freeze({
      protocol: "eliotr.managed-target-manifest-candidate-readback-cursor.v1",
      candidate_sha256: candidateSha,
      root_key: treeRef.key,
      root_sha256: treeRef.sha256,
      next_ordinal: nextOrdinal,
      pending: Object.freeze([...pending]),
      nodes_visited: nodesVisited,
    });
    const prefix = input.cursor_prefix ?? "candidate-readback";
    const digest = await projectionDigest(cursorState);
    const key = `${prefix}/${candidateSha}/${digest}.json`;
    const put = await putCanonicalManifestObjectIfAbsent(store, key, cursorState, {
      manifest_kind: "managed-target-manifest-candidate-readback-cursor",
      candidate_sha256: candidateSha,
    });
    cursor = Object.freeze({ ref: put.key, sha256: put.sha256 });
  }
  return Object.freeze({
    protocol: "eliotr.managed-target-manifest-candidate-readback-step.v1" as const,
    status: complete ? "COMPLETE" as const : "CONTINUE" as const,
    cursor,
    leaves: Object.freeze(leaves),
    next_ordinal: nextOrdinal,
    nodes_visited: nodesVisited,
  });
}

function fail(message: string): never {
  throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", message);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

/**
 * Reads a durable cursor back from Work and binds it to the exact bytes it claims. A
 * resume is never accepted from an unauthenticated in-memory value.
 */
async function readCursorObject(
  store: EvidenceObjectStore,
  resume: ManagedTargetCandidateReadbackResume,
): Promise<ManagedTargetCandidateReadbackCursor> {
  const prefix = "candidate-readback";
  if (typeof resume.ref !== "string" || !resume.ref.startsWith(`${prefix}/`) ||
      !isSha256(resume.sha256)) {
    fail("readback cursor resume is not an exact immutable Work object receipt");
  }
  const stored = await openTreeObject(store, Object.freeze({
    kind: "INDEX" as const,
    key: resume.ref,
    sha256: resume.sha256,
    size_bytes: 0,
    first_copy_ordinal: 0,
    last_copy_ordinal: 0,
    copy_count: 0,
    item_count: 0,
  }));
  const value = stored.value;
  if (!isRecord(value) || value.protocol !== "eliotr.managed-target-manifest-candidate-readback-cursor.v1" ||
      !Array.isArray(value.pending) || !isCount(value.next_ordinal) || !isCount(value.nodes_visited)) {
    fail("readback cursor object is not a valid bounded cursor");
  }
  return Object.freeze({
    protocol: "eliotr.managed-target-manifest-candidate-readback-cursor.v1",
    candidate_sha256: typeof value.candidate_sha256 === "string" ? value.candidate_sha256 : "",
    root_key: typeof value.root_key === "string" ? value.root_key : "",
    root_sha256: typeof value.root_sha256 === "string" ? value.root_sha256 : "",
    next_ordinal: value.next_ordinal,
    pending: value.pending,
    nodes_visited: value.nodes_visited,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTreeRef(value: unknown): value is ManifestTreeObjectRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (ref.kind === "COPY" || ref.kind === "INDEX") &&
    typeof ref.key === "string" && ref.key.length > 0 && ref.key.length <= 1024 &&
    isSha256(ref.sha256) &&
    Number.isSafeInteger(ref.first_copy_ordinal) && Number.isSafeInteger(ref.last_copy_ordinal) &&
    Number.isSafeInteger(ref.copy_count) && Number.isSafeInteger(ref.item_count) &&
    (ref.first_copy_ordinal as number) >= 0 && (ref.copy_count as number) >= 1;
}

async function openTreeObject(
  store: EvidenceObjectStore,
  ref: ManifestTreeObjectRef,
): Promise<{ readonly value: unknown }> {
  const opened = await store.open(ref.key);
  if (opened === null) fail(`tree object ${ref.key} is absent on exact immutable readback`);
  if (!Number.isSafeInteger(opened.size) || opened.size < 2 || opened.size > MAX_CANDIDATE_OBJECT_BYTES || opened.body === null) {
    try { await opened.body?.cancel(); } catch { /* the declared size already fails closed */ }
    fail(`tree object ${ref.key} is outside its fixed byte bound`);
  }
  const bytes = await bufferBounded(opened.body, MAX_CANDIDATE_OBJECT_BYTES);
  if (bytes.byteLength !== opened.size) fail(`tree object ${ref.key} stream size differs from its R2 readback`);
  const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const sha256 = await projectionSha256Utf8(json);
  if (sha256 !== ref.sha256) fail(`tree object ${ref.key} digest differs from its parent receipt`);
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (cause) {
    fail(`tree object ${ref.key} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (canonicalProjectionJson(value) !== json) fail(`tree object ${ref.key} bytes are not canonical JSON`);
  return Object.freeze({ value });
}
