import {
  ArtifactRevisionSchema,
  ArtifactSpecSchema,
  ArtifactSectionRevisionSchema,
  EvidenceFreezeSchema,
  ResolvedEvidenceSchema,
  VersionedRefSchema,
  type ArtifactRevision,
  type ArtifactSectionRevision,
  type ArtifactSpec,
  type EvidenceFreeze,
  type ObjectResidencyKey,
  type OperationIntent,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import type { createArtifactDraftStore } from "./artifact-draft.js";
import type {
  ArtifactDraftReferencedObjectInput,
  ArtifactDraftSectionInput,
  PrepareArtifactDraftInput,
  PrepareArtifactDraftResult,
} from "./artifact-draft.js";

export interface ArtifactCowSectionObject {
  readonly section: ArtifactSectionRevision;
  readonly bytes: Uint8Array;
  readonly residency: ObjectResidencyKey;
}

export interface ArtifactCowCompilation extends ArtifactCowSectionObject {
  readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  readonly dependency_manifest_ref: string;
}

export interface ArtifactCowEvidencePack {
  readonly pack_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly resolved_evidence: readonly ResolvedEvidence[];
  readonly omitted_candidates: readonly { readonly candidate_id: string; readonly reason_code: string }[];
  readonly trace_ref: VersionedRef;
  readonly total_utf8_bytes: number;
}

export interface ArtifactCowParent {
  readonly spec: ArtifactSpec;
  readonly freeze: EvidenceFreeze;
  readonly revision: ArtifactRevision;
  readonly sections: readonly ArtifactCowSectionObject[];
  readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  readonly manifest_residency: ObjectResidencyKey;
}

export interface ArtifactCowExportSet {
  readonly refs: Readonly<Record<string, string>>;
  readonly objects: readonly ArtifactDraftReferencedObjectInput[];
}

export interface ArtifactCowPorts {
  readonly compile: (spec: ArtifactSpec, freeze: EvidenceFreeze) => Promise<ArtifactRevision>;
  /** Loads and verifies the immutable manifest and every object at this exact revision. */
  readonly readExactParent: (artifactRef: VersionedRef) => Promise<ArtifactCowParent | null>;
  /** Rechecks freeze currentness, evidence handles, citations, and verification before compilation. */
  readonly validateParentSection: (input: {
    readonly parent: ArtifactCowParent;
    readonly section: ArtifactCowSectionObject;
  }) => Promise<void>;
  readonly loadSectionEvidencePack: (input: {
    readonly parent: ArtifactCowParent;
    readonly section: ArtifactCowSectionObject;
    readonly contract: ArtifactSpec["section_contracts"][number];
  }) => Promise<ArtifactCowEvidencePack>;
  /** Produces the changed section from its section contract and current EvidencePack. */
  readonly compileSection: (input: {
    readonly parent: ArtifactCowParent;
    readonly contract: ArtifactSpec["section_contracts"][number];
    readonly previous: ArtifactCowSectionObject;
    readonly evidence_pack: ArtifactCowEvidencePack;
  }) => Promise<ArtifactCowCompilation>;
  /** Validates all newly produced evidence and citation bytes against the frozen scope. */
  readonly validateCompiledSection: (input: {
    readonly parent: ArtifactCowParent;
    readonly section: ArtifactCowCompilation;
    readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  }) => Promise<void>;
  /** Rebuilds deterministic exports from the complete next section set. */
  readonly assembleExports: (input: {
    readonly spec: ArtifactSpec;
    readonly sections: readonly ArtifactCowSectionObject[];
  }) => Promise<ArtifactCowExportSet>;
  /** Supplies the already-authorized operation identity and server-owned creation time. */
  readonly createIntent: (input: {
    readonly artifactRef: VersionedRef;
    readonly expectedHeadRevision: number;
    readonly sectionId: string;
  }) => Promise<{ readonly intent: OperationIntent; readonly created_at: string }>;
  readonly createResidency: (input: {
    readonly template: ObjectResidencyKey;
    readonly bytes: Uint8Array;
  }) => Promise<ObjectResidencyKey>;
  readonly prepare: (input: PrepareArtifactDraftInput) => Promise<PrepareArtifactDraftResult>;
}

export type ArtifactCowErrorCode =
  | "ARTIFACT_COW_INPUT_INVALID"
  | "ARTIFACT_COW_PARENT_MISSING"
  | "ARTIFACT_COW_HEAD_STALE"
  | "ARTIFACT_COW_SECTION_MISSING"
  | "ARTIFACT_COW_OUTPUT_INVALID";

export class ArtifactCowError extends Error {
  public readonly code: ArtifactCowErrorCode;

  public constructor(code: ArtifactCowErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactCowError";
    this.code = code;
  }
}

function fail(code: ArtifactCowErrorCode, message: string, cause?: unknown): never {
  throw new ArtifactCowError(code, message, cause);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function assertParent(parent: ArtifactCowParent, requested: VersionedRef, expectedRevision: number): void {
  try {
    VersionedRefSchema.parse(requested);
    ArtifactSpecSchema.parse(parent.spec);
    ArtifactRevisionSchema.parse(parent.revision);
    EvidenceFreezeSchema.parse(parent.freeze);
  } catch (cause) {
    fail("ARTIFACT_COW_INPUT_INVALID", "artifact COW input failed strict contract validation", cause);
  }
  if (!sameRef(parent.revision.artifact_ref, requested)) {
    fail("ARTIFACT_COW_PARENT_MISSING", "exact parent read returned a different artifact revision");
  }
  if (parent.revision.artifact_ref.revision !== expectedRevision || parent.revision.status !== "DRAFT") {
    fail("ARTIFACT_COW_HEAD_STALE", "artifact revision is no longer the expected mutable draft");
  }
  if (!sameRef(parent.revision.spec_ref, parent.spec.spec_ref)) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "parent spec ref differs from the immutable revision");
  }
  if (!sameRef(parent.revision.evidence_freeze_ref, parent.freeze.freeze_ref) ||
      !sameRef(parent.freeze.scope_snapshot_ref, parent.spec.scope_snapshot_ref)) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "parent freeze differs from its manifest or spec scope");
  }
  if (parent.sections.length !== parent.revision.sections.length) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "parent section bytes are incomplete");
  }
  for (let index = 0; index < parent.sections.length; index += 1) {
    const section = parent.sections[index];
    if (section === undefined ||
        JSON.stringify(section.section) !== JSON.stringify(parent.revision.sections[index])) {
      fail("ARTIFACT_COW_OUTPUT_INVALID", "parent section objects are not in exact manifest order");
    }
  }
}

function validateEvidencePack(parent: ArtifactCowParent, pack: ArtifactCowEvidencePack): void {
  try {
    VersionedRefSchema.parse(pack.pack_ref);
    VersionedRefSchema.parse(pack.scope_snapshot_ref);
    VersionedRefSchema.parse(pack.trace_ref);
  } catch (cause) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "section EvidencePack refs are invalid", cause);
  }
  if (!sameRef(pack.scope_snapshot_ref, parent.spec.scope_snapshot_ref) ||
      !Array.isArray(pack.resolved_evidence) || !Array.isArray(pack.omitted_candidates) ||
      !Number.isSafeInteger(pack.total_utf8_bytes) || pack.total_utf8_bytes < 0 || pack.total_utf8_bytes > 8_388_608) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "section EvidencePack is malformed or bound to a different scope");
  }
  const frozen = new Map(parent.freeze.included_evidence.map((item) => [
    `${item.handle_ref.id}:${item.handle_ref.revision}`,
    item.digest,
  ]));
  const seen = new Set<string>();
  for (const evidence of pack.resolved_evidence) {
    const parsed = ResolvedEvidenceSchema.safeParse(evidence);
    if (!parsed.success || parsed.data.handle.terminal_state !== "LIVE" ||
        !sameRef(parsed.data.handle.scope_snapshot_ref, parent.spec.scope_snapshot_ref)) {
      fail("ARTIFACT_COW_OUTPUT_INVALID", "section EvidencePack contains malformed, stale, or foreign evidence");
    }
    const key = `${parsed.data.handle.handle_ref.id}:${parsed.data.handle.handle_ref.revision}`;
    const frozenDigest = frozen.get(key);
    if (seen.has(key) || frozenDigest === undefined || frozenDigest !== parsed.data.handle.excerpt_sha256) {
      fail("ARTIFACT_COW_OUTPUT_INVALID", "section EvidencePack evidence is duplicated or differs from the exact freeze");
    }
    seen.add(key);
  }
}

function objectMap(objects: readonly ArtifactDraftReferencedObjectInput[]): Map<string, ArtifactDraftReferencedObjectInput> {
  const result = new Map<string, ArtifactDraftReferencedObjectInput>();
  for (const object of objects) {
    const previous = result.get(object.object_ref);
    if (previous !== undefined && (previous.object_kind !== object.object_kind ||
        previous.residency.content_digest.digest !== object.residency.content_digest.digest ||
        previous.bytes.byteLength !== object.bytes.byteLength ||
        previous.bytes.some((byte, index) => byte !== object.bytes[index]))) {
      fail("ARTIFACT_COW_OUTPUT_INVALID", "reused artifact object ref changed immutable bytes or residency");
    }
    result.set(object.object_ref, object);
  }
  return result;
}

function requiredObjectKinds(revision: ArtifactRevision): Map<string, ArtifactDraftReferencedObjectInput["object_kind"]> {
  const required = new Map<string, ArtifactDraftReferencedObjectInput["object_kind"]>();
  const add = (ref: string, kind: ArtifactDraftReferencedObjectInput["object_kind"]): void => {
    if (required.has(ref)) fail("ARTIFACT_COW_OUTPUT_INVALID", "next revision contains duplicate object refs");
    required.set(ref, kind);
  };
  add(revision.dependency_manifest_ref, "DEPENDENCY_MANIFEST");
  for (const ref of Object.values(revision.deterministic_export_refs)) add(ref, "EXPORT");
  for (const section of revision.sections) {
    add(section.evidence_ledger_ref, "EVIDENCE_LEDGER");
    add(section.verification_receipt_ref, "VERIFICATION_RECEIPT");
  }
  return required;
}

async function validateSectionObject(section: ArtifactCowSectionObject, contract: ArtifactSpec["section_contracts"][number]): Promise<void> {
  try { ArtifactSectionRevisionSchema.parse(section.section); }
  catch (cause) { fail("ARTIFACT_COW_OUTPUT_INVALID", "compiled section failed its strict contract", cause); }
  if (section.section.contract_id !== contract.section_id || !(section.bytes instanceof Uint8Array)) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "compiled section does not match its section contract");
  }
  if (section.bytes.byteLength > contract.maximum_utf8_bytes) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "compiled section exceeds its contract byte limit");
  }
  const digest = await sha256(section.bytes);
  if (digest !== section.section.body_sha256 || section.residency.content_digest.digest !== digest) {
    fail("ARTIFACT_COW_OUTPUT_INVALID", "compiled section digest differs from its immutable metadata");
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Copy-on-write section revision over the canonical DRAFT writer. All model,
 * evidence, export, identity and authorization decisions enter through explicit
 * ports; this adapter only commits a validated immutable revision.
 */
export class CloudflareArtifactCowAdapter {
  public constructor(private readonly ports: ArtifactCowPorts) {}

  public compile(spec: ArtifactSpec, freeze: EvidenceFreeze): Promise<ArtifactRevision> {
    return this.ports.compile(spec, freeze);
  }

  public async reviseSection(artifactRef: VersionedRef, sectionId: string, expectedArtifactRevision: number): Promise<ArtifactRevision> {
    if (typeof sectionId !== "string" || sectionId.trim() !== sectionId || sectionId.length === 0 ||
        !Number.isSafeInteger(expectedArtifactRevision) || expectedArtifactRevision < 1) {
      fail("ARTIFACT_COW_INPUT_INVALID", "section id or expected artifact revision is invalid");
    }
    try { VersionedRefSchema.parse(artifactRef); }
    catch (cause) { fail("ARTIFACT_COW_INPUT_INVALID", "artifact reference is invalid", cause); }
    const parent = await this.ports.readExactParent(artifactRef);
    if (parent === null) fail("ARTIFACT_COW_PARENT_MISSING", "exact artifact parent revision was not found");
    assertParent(parent, artifactRef, expectedArtifactRevision);
    if (await canonicalDigest(parent.spec) !== parent.revision.spec_digest) {
      fail("ARTIFACT_COW_OUTPUT_INVALID", "parent spec digest is not canonical");
    }

    const contract = parent.spec.section_contracts.find((item) => item.section_id === sectionId);
    if (contract === undefined) fail("ARTIFACT_COW_SECTION_MISSING", "section contract is absent from the exact parent spec");
    const matches = parent.sections.filter((item) => item.section.contract_id === sectionId);
    if (matches.length !== 1) fail("ARTIFACT_COW_SECTION_MISSING", "exact parent must contain one section for the requested contract");
    const previous = matches[0];
    if (previous === undefined) fail("ARTIFACT_COW_SECTION_MISSING", "section bytes are missing from the exact parent");

    for (const section of parent.sections) await this.ports.validateParentSection({ parent, section });
    const evidence_pack = await this.ports.loadSectionEvidencePack({ parent, section: previous, contract });
    validateEvidencePack(parent, evidence_pack);
    const compiled = await this.ports.compileSection({ parent, contract, previous, evidence_pack });
    await validateSectionObject(compiled, contract);
    if (compiled.section.section_ref.id !== previous.section.section_ref.id ||
        compiled.section.section_ref.revision !== previous.section.section_ref.revision + 1 ||
        compiled.section.body_object_ref === previous.section.body_object_ref) {
      fail("ARTIFACT_COW_OUTPUT_INVALID", "revised section must advance its ref and replace its body object");
    }
    const compiledSectionObjects = [...parent.referenced_objects, ...compiled.referenced_objects];
    await this.ports.validateCompiledSection({ parent, section: compiled, referenced_objects: compiledSectionObjects });

    const nextSections = parent.sections.map((item) => {
      if (item.section.contract_id === sectionId) return compiled;
      return {
        ...item,
        section: { ...item.section, reused_from_revision_ref: parent.revision.artifact_ref },
      };
    });
    const exports = await this.ports.assembleExports({ spec: parent.spec, sections: nextSections });
    const intentContext = await this.ports.createIntent({
      artifactRef: { id: artifactRef.id, revision: expectedArtifactRevision + 1 },
      expectedHeadRevision: expectedArtifactRevision,
      sectionId,
    });
    const createdAt = intentContext.created_at;
    const nextRevision = ArtifactRevisionSchema.parse({
      ...parent.revision,
      artifact_ref: { id: artifactRef.id, revision: expectedArtifactRevision + 1 },
      dependency_manifest_ref: compiled.dependency_manifest_ref,
      sections: nextSections.map((item) => item.section),
      deterministic_export_refs: exports.refs,
      status: "DRAFT",
      created_at: createdAt,
    });
    const referenced = objectMap([...parent.referenced_objects, ...compiled.referenced_objects, ...exports.objects]);
    const required = requiredObjectKinds(nextRevision);
    const referenced_objects: ArtifactDraftReferencedObjectInput[] = [];
    for (const [ref, kind] of required) {
      const object = referenced.get(ref);
      if (object === undefined || object.object_kind !== kind) {
        fail("ARTIFACT_COW_OUTPUT_INVALID", `next revision is missing its ${kind} object`);
      }
      referenced_objects.push(object);
    }

    const sections: ArtifactDraftSectionInput[] = nextSections.map((item) => ({
      section: item.section,
      bytes: new Uint8Array(item.bytes),
      residency: item.residency,
    }));
    const assembled: PrepareArtifactDraftInput = {
      intent: intentContext.intent,
      expected_draft_head_revision: expectedArtifactRevision,
      spec: parent.spec,
      revision: nextRevision,
      sections,
      referenced_objects,
      manifest_residency: await this.ports.createResidency({
        template: parent.manifest_residency,
        bytes: new TextEncoder().encode(canonicalJson({ spec: parent.spec, revision: nextRevision })),
      }),
    };
    const result = await this.ports.prepare(assembled);
    if (!sameRef(result.artifact_ref, nextRevision.artifact_ref) || result.draft_head_revision < nextRevision.artifact_ref.revision) {
      fail("ARTIFACT_COW_OUTPUT_INVALID", "draft store readback does not identify the newly prepared revision");
    }
    return nextRevision;
  }
}

export type CloudflareArtifactCowRuntimePorts = Omit<ArtifactCowPorts, "prepare"> & {
  readonly draftStore: Pick<ReturnType<typeof createArtifactDraftStore>, "prepare">;
};

export function createCloudflareArtifactCowAdapter(ports: CloudflareArtifactCowRuntimePorts): CloudflareArtifactCowAdapter {
  const { draftStore, ...compilerPorts } = ports;
  return new CloudflareArtifactCowAdapter({ ...compilerPorts, prepare: (input) => draftStore.prepare(input) });
}
