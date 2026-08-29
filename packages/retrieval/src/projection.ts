import type { ProjectionItem, SourceRevision } from "@eliotr/contracts";

export interface NormalizedSection {
  readonly canonical_section_id: string;
  readonly heading_path: readonly string[];
  readonly text: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly offset_map_ref: string;
}

export interface StructuralProjectionInput {
  readonly source_revision: SourceRevision;
  readonly project_membership_ids: readonly string[];
  readonly sections: readonly NormalizedSection[];
  readonly projection_generation: string;
  readonly max_item_utf8_bytes: number;
}

export interface StructuralProjector {
  project(input: StructuralProjectionInput): Promise<readonly ProjectionItem[]>;
}

export const STRUCTURAL_PROJECTOR_RULES = [
  "stable canonical section IDs survive reindex within one normalized revision",
  "items preserve heading context and normalized offset mappings",
  "items target 16–64 KiB and never exceed the application hard limit",
  "project membership duplication is explicit and counted for capacity",
  "instruction taint is preserved into every projection item",
] as const;
