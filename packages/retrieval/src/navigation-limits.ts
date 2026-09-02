export const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_SHORT_TEXT_BYTES = 4 * 1024;
export const MAX_CARD_AUTHORS = 128;
export const MAX_CARD_TERMS = 256;
export const MAX_CARD_OUTLINE_ITEMS = 1_024;
export const MAX_MAP_FRAGMENTS = 256;
export const MAX_MAP_OBJECTS_PER_FIELD = 4_096;
export const MAX_MAP_TERMS = 4_096;
export const MAX_ATLAS_SOURCES = 4_096;
export const MAX_ATLAS_NODES = 4_096;
export const MAX_NODE_REFERENCES = 512;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 32_768;
export const MAX_ORIENTATION_SOURCES = 128;
export const MAX_ORIENTATION_CANDIDATES = 512;
export const MAX_FOCUS_TERMS = 64;
export const MAX_OMISSION_SAMPLE = 512;

export const VERSION_TOKEN = /^(?:v|version[-_:]?)?\d+(?:\.\d+){1,3}$/iu;

export const FORBIDDEN_NAVIGATION_KEYS = new Set([
  "authorization_receipt_ref",
  "citation_resolution_receipt",
  "counterevidence_handles",
  "evidence_handle",
  "evidence_resolution_receipt",
  "exact_support_handles",
  "publication_eligible",
  "resolved_evidence",
  "verification_receipt_ref",
]);
