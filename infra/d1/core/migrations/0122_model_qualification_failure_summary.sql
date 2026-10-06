-- ER-09: a provider failure after dispatch admission is durable without
-- reopening the one-shot dispatch.  The summary intentionally contains only
-- bounded typed fields; error text, causes, payloads, headers and URLs never
-- cross this schema boundary.
PRAGMA foreign_keys = ON;

CREATE TABLE model_route_qualification_failure_summary (
  probe_idempotency_key TEXT PRIMARY KEY CHECK(
    length(probe_idempotency_key) BETWEEN 1 AND 256
  ),
  probe_input_sha256 TEXT NOT NULL CHECK(
    length(probe_input_sha256) = 64
    AND probe_input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  claim_ref TEXT NOT NULL CHECK(length(claim_ref) BETWEEN 1 AND 256),
  phase TEXT NOT NULL CHECK(phase = 'MODEL_GATEWAY_EXECUTION'),
  failure_code TEXT NOT NULL CHECK(failure_code IN (
    'MODEL_GATEWAY_DEPLOYMENT_MISSING',
    'MODEL_GATEWAY_PROMPT_COMPILE_FAILED',
    'MODEL_GATEWAY_REQUEST_INVALID',
    'MODEL_GATEWAY_CREDENTIAL_INVALID',
    'MODEL_GATEWAY_TRANSPORT_FAILED',
    'MODEL_GATEWAY_AUTH_REJECTED',
    'MODEL_GATEWAY_LIMIT_REJECTED',
    'MODEL_GATEWAY_POLICY_REJECTED',
    'MODEL_GATEWAY_UPSTREAM_REJECTED',
    'MODEL_GATEWAY_RESPONSE_INVALID',
    'MODEL_GATEWAY_OUTPUT_TRUNCATED',
    'MODEL_GATEWAY_OUTPUT_PERSIST_FAILED',
    'MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED',
    'MODEL_GATEWAY_PRICING_FAILED'
  )),
  safe_response_reason TEXT CHECK(safe_response_reason IN (
    'FINGERPRINT_INVALID', 'LOG_READBACK_UNAVAILABLE',
    'LOG_CORRELATION_INVALID', 'LOG_ID_MISSING', 'LOG_ID_INVALID',
    'CONTENT_TYPE_INVALID', 'BODY_TOO_LARGE', 'BODY_JSON_INVALID',
    'BODY_SHAPE_INVALID', 'MODEL_ID_INVALID', 'CACHE_INVALID', 'UNCLASSIFIED'
  ) OR safe_response_reason IS NULL),
  transport_failure_reason TEXT CHECK(transport_failure_reason IN (
    'CANCELLED', 'DEADLINE_EXCEEDED', 'REDIRECTED', 'BODY_TOO_LARGE',
    'BODY_READ_FAILED', 'NETWORK_CONNECTION_LOST', 'FETCH_TYPE_ERROR',
    'FETCH_ERROR', 'ILLEGAL_INVOCATION', 'FETCH_NOT_SUPPORTED', 'UNCLASSIFIED'
  ) OR transport_failure_reason IS NULL),
  observed_http_status INTEGER CHECK(
    observed_http_status IS NULL OR observed_http_status BETWEEN 100 AND 599
  ),
  summary_sha256 TEXT NOT NULL CHECK(
    length(summary_sha256) = 64
    AND summary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(
    observed_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(observed_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at
  ),
  FOREIGN KEY(probe_idempotency_key)
    REFERENCES model_route_qualification_dispatch(probe_idempotency_key)
) STRICT;

-- A summary seals the unfinished dispatch as a durable failure.  It must bind
-- all three dispatch identity fields and may never describe a completed call.
CREATE TRIGGER model_route_qualification_failure_summary_identity_guard
BEFORE INSERT ON model_route_qualification_failure_summary
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_FAILURE_SUMMARY_IDENTITY_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM model_route_qualification_dispatch d
    WHERE d.probe_idempotency_key = NEW.probe_idempotency_key
      AND d.probe_input_sha256 = NEW.probe_input_sha256
      AND d.claim_ref = NEW.claim_ref
      AND d.state = 'STARTED'
      AND d.observation_sha256 IS NULL
      AND d.observation_json IS NULL
      AND d.completed_at IS NULL
  );
END;

-- Response and transport reasons are projections of their owning error code;
-- policy, pricing and other bounded failures intentionally remain code-only.
CREATE TRIGGER model_route_qualification_failure_summary_reason_guard
BEFORE INSERT ON model_route_qualification_failure_summary
WHEN (NEW.failure_code = 'MODEL_GATEWAY_RESPONSE_INVALID' AND NEW.safe_response_reason IS NULL)
  OR (NEW.failure_code <> 'MODEL_GATEWAY_RESPONSE_INVALID' AND NEW.safe_response_reason IS NOT NULL)
  OR (NEW.failure_code = 'MODEL_GATEWAY_TRANSPORT_FAILED' AND NEW.transport_failure_reason IS NULL)
  OR (NEW.failure_code <> 'MODEL_GATEWAY_TRANSPORT_FAILED' AND NEW.transport_failure_reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_FAILURE_SUMMARY_REASON_INVALID');
END;

CREATE TRIGGER model_route_qualification_failure_summary_immutable_update
BEFORE UPDATE ON model_route_qualification_failure_summary
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_FAILURE_SUMMARY_IMMUTABLE');
END;

CREATE TRIGGER model_route_qualification_failure_summary_immutable_delete
BEFORE DELETE ON model_route_qualification_failure_summary
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_FAILURE_SUMMARY_IMMUTABLE');
END;

-- Once a failure summary exists, the dispatch cannot be completed by a late
-- successful caller.  This preserves the STARTED + NULL-success receipt
-- fence used to prevent provider replay.
CREATE TRIGGER model_route_qualification_dispatch_failure_summary_guard
BEFORE UPDATE ON model_route_qualification_dispatch
WHEN OLD.state = 'STARTED'
  AND NEW.state = 'COMPLETED'
  AND EXISTS (
    SELECT 1 FROM model_route_qualification_failure_summary s
    WHERE s.probe_idempotency_key = OLD.probe_idempotency_key
  )
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_DISPATCH_FAILURE_SUMMARY_EXISTS');
END;
