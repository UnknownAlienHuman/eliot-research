PRAGMA foreign_keys = ON;

-- A qualification proof is a new immutable observation of an existing route
-- candidate.  It never replaces the candidate's original qualification bytes.
CREATE TABLE dynamic_route_qualification_proof (
  qualification_ref TEXT PRIMARY KEY CHECK(
    length(qualification_ref) BETWEEN 1 AND 256
  ),
  proof_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(proof_sha256) = 64
    AND proof_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  qualification_json TEXT NOT NULL CHECK(
    json_valid(qualification_json)
    AND length(CAST(qualification_json AS BLOB)) BETWEEN 1 AND 262144
  ),
  route_ref TEXT NOT NULL CHECK(length(route_ref) BETWEEN 1 AND 256),
  route_version TEXT NOT NULL CHECK(length(route_version) BETWEEN 1 AND 256),
  candidate_ref TEXT NOT NULL REFERENCES dynamic_route_candidate(candidate_ref),
  candidate_sha256 TEXT NOT NULL CHECK(
    length(candidate_sha256) = 64
    AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  UNIQUE(candidate_ref, proof_sha256)
) STRICT;

CREATE INDEX dynamic_route_qualification_proof_candidate_idx
  ON dynamic_route_qualification_proof(route_ref, route_version, candidate_ref);

CREATE TRIGGER dynamic_route_qualification_proof_candidate_guard
BEFORE INSERT ON dynamic_route_qualification_proof
BEGIN
  SELECT RAISE(ABORT, 'dynamic route qualification proof candidate mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM dynamic_route_candidate c
    WHERE c.candidate_ref = NEW.candidate_ref
      AND c.candidate_sha256 = NEW.candidate_sha256
      AND c.route_ref = NEW.route_ref
      AND c.route_version = NEW.route_version
  );
END;

CREATE TRIGGER dynamic_route_qualification_proof_immutable_update
BEFORE UPDATE ON dynamic_route_qualification_proof
BEGIN
  SELECT RAISE(ABORT, 'dynamic route qualification proofs are immutable');
END;

CREATE TRIGGER dynamic_route_qualification_proof_immutable_delete
BEFORE DELETE ON dynamic_route_qualification_proof
BEGIN
  SELECT RAISE(ABORT, 'dynamic route qualification proofs are immutable');
END;

-- One pointer per immutable route version selects the newest accepted proof.
-- The candidate identity is immutable; only the proof selected by a guarded
-- CAS and its activation timestamp may advance.
CREATE TABLE dynamic_route_active_qualification (
  route_ref TEXT NOT NULL CHECK(length(route_ref) BETWEEN 1 AND 256),
  route_version TEXT NOT NULL CHECK(length(route_version) BETWEEN 1 AND 256),
  candidate_ref TEXT NOT NULL REFERENCES dynamic_route_candidate(candidate_ref),
  candidate_sha256 TEXT NOT NULL CHECK(
    length(candidate_sha256) = 64
    AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  qualification_ref TEXT NOT NULL REFERENCES dynamic_route_qualification_proof(qualification_ref),
  qualification_sha256 TEXT NOT NULL CHECK(
    length(qualification_sha256) = 64
    AND qualification_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  activated_at TEXT NOT NULL CHECK(
    activated_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(activated_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) IS activated_at
  ),
  PRIMARY KEY(route_ref, route_version)
) STRICT;

CREATE INDEX dynamic_route_active_qualification_proof_idx
  ON dynamic_route_active_qualification(qualification_ref);

CREATE TRIGGER dynamic_route_active_qualification_candidate_guard
BEFORE INSERT ON dynamic_route_active_qualification
BEGIN
  SELECT RAISE(ABORT, 'dynamic route active qualification candidate mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM dynamic_route_candidate c
    WHERE c.candidate_ref = NEW.candidate_ref
      AND c.candidate_sha256 = NEW.candidate_sha256
      AND c.route_ref = NEW.route_ref
      AND c.route_version = NEW.route_version
  );
END;

CREATE TRIGGER dynamic_route_active_qualification_proof_guard
BEFORE INSERT ON dynamic_route_active_qualification
BEGIN
  SELECT RAISE(ABORT, 'dynamic route active qualification proof mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM dynamic_route_qualification_proof p
    WHERE p.qualification_ref = NEW.qualification_ref
      AND p.proof_sha256 = NEW.qualification_sha256
      AND p.route_ref = NEW.route_ref
      AND p.route_version = NEW.route_version
      AND p.candidate_ref = NEW.candidate_ref
      AND p.candidate_sha256 = NEW.candidate_sha256
  );
END;

CREATE TRIGGER dynamic_route_active_qualification_immutable_identity
BEFORE UPDATE ON dynamic_route_active_qualification
WHEN NEW.route_ref IS NOT OLD.route_ref
  OR NEW.route_version IS NOT OLD.route_version
  OR NEW.candidate_ref IS NOT OLD.candidate_ref
  OR NEW.candidate_sha256 IS NOT OLD.candidate_sha256
BEGIN
  SELECT RAISE(ABORT, 'dynamic route active qualification identity is immutable');
END;

CREATE TRIGGER dynamic_route_active_qualification_update_guard
BEFORE UPDATE ON dynamic_route_active_qualification
BEGIN
  SELECT RAISE(ABORT, 'dynamic route active qualification proof mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM dynamic_route_qualification_proof p
    WHERE p.qualification_ref = NEW.qualification_ref
      AND p.proof_sha256 = NEW.qualification_sha256
      AND p.route_ref = NEW.route_ref
      AND p.route_version = NEW.route_version
      AND p.candidate_ref = NEW.candidate_ref
      AND p.candidate_sha256 = NEW.candidate_sha256
  );
END;

CREATE TRIGGER dynamic_route_active_qualification_immutable_delete
BEFORE DELETE ON dynamic_route_active_qualification
BEGIN
  SELECT RAISE(ABORT, 'dynamic route active qualification pointers are immutable');
END;
