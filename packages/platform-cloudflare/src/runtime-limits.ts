export const RUNTIME_LIMITS = {
  ordinary_json_bytes: 256 * 1024,
  semantic_api_response_bytes: 512 * 1024,
  durable_object_message_bytes: 64 * 1024,
  durable_object_persisted_state_bytes: 256 * 1024,
  workflow_step_result_bytes: 64 * 1024,
  d1_text_or_json_column_bytes: 64 * 1024,
  ai_search_projection_target_min_bytes: 16 * 1024,
  ai_search_projection_target_max_bytes: 64 * 1024,
  ai_search_projection_hard_bytes: 256 * 1024,
  artifact_section_target_bytes: 1024 * 1024,
  buffered_r2_bytes: 8 * 1024 * 1024,
  worker_compressed_bundle_bytes: 4 * 1024 * 1024,
  worker_startup_ms: 400,
  first_party_peak_heap_bytes: 32 * 1024 * 1024,
} as const;

export function assertWithinBytes(label: string, actual: number, limit: number): void {
  if (actual > limit) throw new RangeError(`${label} is ${actual} bytes; limit is ${limit}`);
}
