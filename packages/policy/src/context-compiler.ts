import type {
  AllowedReferenceManifest,
  EvidenceContextBlock,
  ResolvedEvidence,
  SelectionIntegrityReceipt,
  VersionedRef,
} from "@eliotr/contracts";

export interface ContextCompilationInput {
  readonly manifest: AllowedReferenceManifest;
  readonly evidence: readonly ResolvedEvidence[];
  readonly modelRouteRef: string;
  readonly maxBytes: number;
}

export interface CompiledEvidenceContext {
  readonly blocks: readonly EvidenceContextBlock[];
  readonly manifest_ref: VersionedRef;
  readonly total_utf8_bytes: number;
  readonly selection_receipt: SelectionIntegrityReceipt;
  readonly system_instructions: readonly string[];
  readonly source_text_in_system_fields: false;
}

export interface EvidenceContextCompiler {
  compile(input: ContextCompilationInput): Promise<CompiledEvidenceContext>;
}

export const CONTEXT_COMPILER_INVARIANTS = [
  "source content appears only in quoted_content fields",
  "source text never enters system, developer, or tool instruction fields",
  "side-effect-capable tools are absent from research generation",
  "taint survives summarization without a DeclassificationReceipt",
  "untrusted content cannot expand scope, disclosure, or authority",
] as const;
