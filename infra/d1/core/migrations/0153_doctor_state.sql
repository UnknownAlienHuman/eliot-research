CREATE TABLE doctor_delivery_outbox (
  delivery_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incident(incident_id),
  sink_ref TEXT NOT NULL CHECK (sink_ref = 'github-issue'),
  marker TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','UNKNOWN','DELIVERED','UNCONFIGURED','FAILED','SUPERSEDED')),
  diagnosis_state TEXT NOT NULL CHECK (diagnosis_state IN ('NOT_STARTED','UNKNOWN','COMPLETE','UNAVAILABLE')),
  diagnosis TEXT CHECK (diagnosis IS NULL OR length(diagnosis) <= 320),
  external_issue_number INTEGER CHECK (external_issue_number IS NULL OR external_issue_number > 0),
  external_issue_url TEXT,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((lease_owner IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  UNIQUE (incident_id, sink_ref)
) STRICT;

CREATE INDEX doctor_delivery_outbox_state_idx
  ON doctor_delivery_outbox(sink_ref, state, created_at, delivery_id);
