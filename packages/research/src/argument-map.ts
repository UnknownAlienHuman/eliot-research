import type { EvidenceHandle, VersionedRef } from "@eliotr/contracts";

export type ArgumentNodeKind =
  | "problem" | "question" | "assumption" | "premise" | "evidence" | "intermediate_conclusion"
  | "final_claim" | "limitation" | "objection" | "alternative";

export interface ArgumentNode {
  readonly node_id: string;
  readonly kind: ArgumentNodeKind;
  readonly text_digest: string;
  readonly support_handles: readonly EvidenceHandle[];
}

export interface ArgumentEdge {
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly relation: "SUPPORTS" | "CONTRADICTS" | "QUALIFIES" | "DEPENDS_ON" | "ALTERNATIVE_TO";
  readonly precision_class: "source_native" | "deterministic" | "parser_derived" | "model_candidate" | "human_reviewed";
  readonly evidence_handles: readonly EvidenceHandle[];
}

export interface ArgumentMapRevision {
  readonly map_ref: VersionedRef;
  readonly source_revision_ref: string;
  readonly nodes: readonly ArgumentNode[];
  readonly edges: readonly ArgumentEdge[];
  readonly generator_generation: string;
}
