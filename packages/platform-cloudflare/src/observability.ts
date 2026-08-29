export interface MetricPoint {
  readonly operation_kind: string;
  readonly query_product?: string;
  readonly project_id_hash?: string;
  readonly route_generation?: string;
  readonly embedding_generation?: string;
  readonly index_generation?: string;
  readonly workflow_stage?: string;
  readonly result_disposition?: string;
  readonly error_class?: string;
  readonly duration_ms?: number;
  readonly cost_usd?: number;
  readonly count?: number;
}

export interface MetricsPort {
  write(point: MetricPoint): void;
}

export interface HealthSnapshot {
  readonly generated_at: string;
  readonly deployment_generation: string;
  readonly schema_generation: string;
  readonly connector_states: Readonly<Record<string, string>>;
  readonly projection_lag_seconds: Readonly<Record<string, number>>;
  readonly outbox_oldest_seconds: number;
  readonly dlq_messages: number;
  readonly open_incident_refs: readonly string[];
  readonly budget_utilization: Readonly<Record<string, number>>;
}

export const TELEMETRY_FORBIDDEN_FIELDS = [
  "source_text", "prompt_body", "private_path", "evidence_excerpt", "oauth_token", "provider_key",
] as const;
