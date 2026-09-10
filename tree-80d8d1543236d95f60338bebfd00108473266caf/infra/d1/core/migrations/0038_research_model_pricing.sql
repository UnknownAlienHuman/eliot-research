-- ER-09 W3: immutable, server-supplied model pricing observations.
-- This table records a pricing snapshot; it does not select a route, approve
-- spending, or perform price arithmetic. Current-call expiry is enforced by
-- the caller's authority composition, while historical rows remain readable.
PRAGMA foreign_keys = ON;

CREATE TABLE research_model_pricing_snapshot (
  pricing_snapshot_ref TEXT PRIMARY KEY CHECK(length(pricing_snapshot_ref) BETWEEN 1 AND 256),
  route_ref TEXT NOT NULL CHECK(length(route_ref) BETWEEN 1 AND 256),
  route_version TEXT NOT NULL CHECK(length(route_version) BETWEEN 1 AND 256),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 256),
  exact_model_id TEXT NOT NULL CHECK(length(exact_model_id) BETWEEN 1 AND 256),
  pricing_basis TEXT NOT NULL CHECK(pricing_basis = 'EXACT_TOKEN_RATES_V1'),
  input_rate_usd_per_1k_tokens TEXT NOT NULL CHECK(length(input_rate_usd_per_1k_tokens) BETWEEN 1 AND 64),
  output_rate_usd_per_1k_tokens TEXT NOT NULL CHECK(length(output_rate_usd_per_1k_tokens) BETWEEN 1 AND 64),
  provenance_ref TEXT NOT NULL CHECK(length(provenance_ref) BETWEEN 1 AND 256),
  approval_receipt_ref TEXT NOT NULL CHECK(length(approval_receipt_ref) BETWEEN 1 AND 256),
  effective_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 65536),
  created_at TEXT NOT NULL,
  UNIQUE(route_ref, route_version, provider, exact_model_id, snapshot_sha256)
) STRICT;

CREATE INDEX research_model_pricing_snapshot_route_idx
  ON research_model_pricing_snapshot(route_ref, route_version, provider, exact_model_id);

CREATE TRIGGER research_model_pricing_snapshot_immutable_update
BEFORE UPDATE ON research_model_pricing_snapshot
BEGIN
  SELECT RAISE(ABORT, 'research model pricing snapshots are immutable');
END;

CREATE TRIGGER research_model_pricing_snapshot_immutable_delete
BEFORE DELETE ON research_model_pricing_snapshot
BEGIN
  SELECT RAISE(ABORT, 'research model pricing snapshots are immutable');
END;
