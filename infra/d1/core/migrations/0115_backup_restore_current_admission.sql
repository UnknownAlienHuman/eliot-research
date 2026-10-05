PRAGMA foreign_keys = ON;

-- Current restore authority is target-local controller state. None of these
-- rows are portable backup data; restoring a source epoch cannot recreate a
-- profile, grant, revocation state, or the request-to-grant binding.
CREATE TABLE backup_restore_target_profile (
  profile_ref TEXT NOT NULL CHECK(length(profile_ref) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK(revision > 0),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 32768),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64 AND profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
  failure_domain TEXT NOT NULL CHECK(length(failure_domain) BETWEEN 1 AND 256),
  environment_ref TEXT NOT NULL CHECK(length(environment_ref) BETWEEN 1 AND 256),
  deployment_ref TEXT NOT NULL CHECK(length(deployment_ref) BETWEEN 1 AND 256),
  configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256)=64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
  resources_json TEXT NOT NULL CHECK(json_valid(resources_json) AND length(CAST(resources_json AS BLOB)) BETWEEN 2 AND 4096),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  PRIMARY KEY(profile_ref, revision),
  UNIQUE(profile_ref, revision, profile_sha256)
) STRICT;

CREATE TABLE backup_restore_target_profile_revocation (
  revocation_ref TEXT PRIMARY KEY CHECK(length(revocation_ref) BETWEEN 1 AND 256),
  profile_ref TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
  revoked_at TEXT NOT NULL CHECK(revoked_at GLOB '????-??-??T??:??:??.???Z' AND julianday(revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS revoked_at),
  reason_sha256 TEXT NOT NULL CHECK(length(reason_sha256)=64 AND reason_sha256 NOT GLOB '*[^0-9a-f]*'),
  revocation_json TEXT NOT NULL CHECK(json_valid(revocation_json) AND length(CAST(revocation_json AS BLOB)) BETWEEN 2 AND 8192),
  revocation_sha256 TEXT NOT NULL CHECK(length(revocation_sha256)=64 AND revocation_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(profile_ref, profile_revision),
  FOREIGN KEY(profile_ref, profile_revision) REFERENCES backup_restore_target_profile(profile_ref, revision)
) STRICT;

CREATE TABLE backup_restore_permission (
  permission_ref TEXT NOT NULL CHECK(length(permission_ref) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK(revision > 0),
  permission_json TEXT NOT NULL CHECK(json_valid(permission_json) AND length(CAST(permission_json AS BLOB)) BETWEEN 2 AND 262144),
  permission_sha256 TEXT NOT NULL CHECK(length(permission_sha256)=64 AND permission_sha256 NOT GLOB '*[^0-9a-f]*'),
  restore_id TEXT NOT NULL CHECK(length(restore_id) BETWEEN 1 AND 256),
  restore_intent_digest TEXT NOT NULL CHECK(length(restore_intent_digest)=64 AND restore_intent_digest NOT GLOB '*[^0-9a-f]*'),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_sha256 TEXT NOT NULL CHECK(length(actor_sha256)=64 AND actor_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_expires_at TEXT NOT NULL CHECK(actor_expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(actor_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_expires_at) IS actor_expires_at),
  epoch_id TEXT NOT NULL CHECK(length(epoch_id) BETWEEN 1 AND 256),
  offsite_copy_ref TEXT NOT NULL CHECK(length(offsite_copy_ref) BETWEEN 1 AND 256),
  copy_authority_sha256 TEXT NOT NULL CHECK(length(copy_authority_sha256)=64 AND copy_authority_sha256 NOT GLOB '*[^0-9a-f]*'),
  primary_binding_sha256 TEXT NOT NULL CHECK(length(primary_binding_sha256)=64 AND primary_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  profile_ref TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64 AND profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  migration_ledger_digest TEXT NOT NULL CHECK(length(migration_ledger_digest)=64 AND migration_ledger_digest NOT GLOB '*[^0-9a-f]*'),
  purge_ledger_revision INTEGER NOT NULL CHECK(purge_ledger_revision >= 0),
  purge_ledger_digest TEXT NOT NULL CHECK(length(purge_ledger_digest)=64 AND purge_ledger_digest NOT GLOB '*[^0-9a-f]*'),
  valid_from TEXT NOT NULL CHECK(valid_from GLOB '????-??-??T??:??:??.???Z' AND julianday(valid_from) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',valid_from) IS valid_from),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at AND julianday(expires_at) > julianday(valid_from) AND julianday(expires_at) <= julianday(actor_expires_at)),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  PRIMARY KEY(permission_ref, revision),
  UNIQUE(restore_id, permission_ref, revision),
  FOREIGN KEY(profile_ref, profile_revision, profile_sha256)
    REFERENCES backup_restore_target_profile(profile_ref, revision, profile_sha256)
) STRICT;

CREATE INDEX backup_restore_permission_restore_id
  ON backup_restore_permission(restore_id, permission_ref, revision);

CREATE TABLE backup_restore_permission_revocation (
  revocation_ref TEXT PRIMARY KEY CHECK(length(revocation_ref) BETWEEN 1 AND 256),
  permission_ref TEXT NOT NULL,
  permission_revision INTEGER NOT NULL CHECK(permission_revision > 0),
  revoked_at TEXT NOT NULL CHECK(revoked_at GLOB '????-??-??T??:??:??.???Z' AND julianday(revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS revoked_at),
  reason_sha256 TEXT NOT NULL CHECK(length(reason_sha256)=64 AND reason_sha256 NOT GLOB '*[^0-9a-f]*'),
  revocation_json TEXT NOT NULL CHECK(json_valid(revocation_json) AND length(CAST(revocation_json AS BLOB)) BETWEEN 2 AND 8192),
  revocation_sha256 TEXT NOT NULL CHECK(length(revocation_sha256)=64 AND revocation_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(permission_ref, permission_revision),
  FOREIGN KEY(permission_ref, permission_revision) REFERENCES backup_restore_permission(permission_ref, revision)
) STRICT;

CREATE TABLE backup_restore_admission_binding (
  restore_id TEXT NOT NULL CHECK(length(restore_id) BETWEEN 1 AND 256),
  permission_ref TEXT NOT NULL,
  permission_revision INTEGER NOT NULL CHECK(permission_revision > 0),
  permission_sha256 TEXT NOT NULL CHECK(length(permission_sha256)=64 AND permission_sha256 NOT GLOB '*[^0-9a-f]*'),
  restore_intent_digest TEXT NOT NULL CHECK(length(restore_intent_digest)=64 AND restore_intent_digest NOT GLOB '*[^0-9a-f]*'),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_sha256 TEXT NOT NULL CHECK(length(actor_sha256)=64 AND actor_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_expires_at TEXT NOT NULL CHECK(actor_expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(actor_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_expires_at) IS actor_expires_at),
  copy_authority_sha256 TEXT NOT NULL CHECK(length(copy_authority_sha256)=64 AND copy_authority_sha256 NOT GLOB '*[^0-9a-f]*'),
  primary_binding_sha256 TEXT NOT NULL CHECK(length(primary_binding_sha256)=64 AND primary_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  profile_ref TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64 AND profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  valid_from TEXT NOT NULL CHECK(valid_from GLOB '????-??-??T??:??:??.???Z' AND julianday(valid_from) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',valid_from) IS valid_from),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB)) BETWEEN 2 AND 32768),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  PRIMARY KEY(restore_id, permission_ref, permission_revision),
  FOREIGN KEY(restore_id, permission_ref, permission_revision)
    REFERENCES backup_restore_permission(restore_id, permission_ref, revision),
  FOREIGN KEY(profile_ref, profile_revision, profile_sha256)
    REFERENCES backup_restore_target_profile(profile_ref, revision, profile_sha256)
) STRICT;

CREATE TRIGGER backup_restore_target_profile_immutable_update
BEFORE UPDATE ON backup_restore_target_profile
BEGIN SELECT RAISE(ABORT,'backup restore target profile is immutable'); END;
CREATE TRIGGER backup_restore_target_profile_immutable_delete
BEFORE DELETE ON backup_restore_target_profile
BEGIN SELECT RAISE(ABORT,'backup restore target profile is immutable'); END;
CREATE TRIGGER backup_restore_target_profile_revocation_immutable_update
BEFORE UPDATE ON backup_restore_target_profile_revocation
BEGIN SELECT RAISE(ABORT,'backup restore target profile revocation is immutable'); END;
CREATE TRIGGER backup_restore_target_profile_revocation_immutable_delete
BEFORE DELETE ON backup_restore_target_profile_revocation
BEGIN SELECT RAISE(ABORT,'backup restore target profile revocation is immutable'); END;
CREATE TRIGGER backup_restore_permission_immutable_update
BEFORE UPDATE ON backup_restore_permission
BEGIN SELECT RAISE(ABORT,'backup restore permission is immutable'); END;
CREATE TRIGGER backup_restore_permission_immutable_delete
BEFORE DELETE ON backup_restore_permission
BEGIN SELECT RAISE(ABORT,'backup restore permission is immutable'); END;
CREATE TRIGGER backup_restore_permission_revocation_immutable_update
BEFORE UPDATE ON backup_restore_permission_revocation
BEGIN SELECT RAISE(ABORT,'backup restore permission revocation is immutable'); END;
CREATE TRIGGER backup_restore_permission_revocation_immutable_delete
BEFORE DELETE ON backup_restore_permission_revocation
BEGIN SELECT RAISE(ABORT,'backup restore permission revocation is immutable'); END;
CREATE TRIGGER backup_restore_admission_binding_immutable_update
BEFORE UPDATE ON backup_restore_admission_binding
BEGIN SELECT RAISE(ABORT,'backup restore admission binding is immutable'); END;
CREATE TRIGGER backup_restore_admission_binding_immutable_delete
BEFORE DELETE ON backup_restore_admission_binding
BEGIN SELECT RAISE(ABORT,'backup restore admission binding is immutable'); END;

-- A permission and its request binding become usable only after the profile
-- and exact immutable grant already exist and are not revoked. The installer
-- writes the binding last; partial/lost-ack profile or grant writes remain inert.
CREATE TRIGGER backup_restore_permission_profile_guard
BEFORE INSERT ON backup_restore_permission
BEGIN
  SELECT RAISE(ABORT,'BACKUP_RESTORE_PROFILE_UNAVAILABLE')
  WHERE NOT EXISTS (
    SELECT 1 FROM backup_restore_target_profile profile
    WHERE profile.profile_ref=NEW.profile_ref AND profile.revision=NEW.profile_revision
      AND profile.profile_sha256=NEW.profile_sha256
      AND NOT EXISTS (SELECT 1 FROM backup_restore_target_profile_revocation revoked
        WHERE revoked.profile_ref=profile.profile_ref AND revoked.profile_revision=profile.revision)
  );
END;

CREATE TRIGGER backup_restore_admission_binding_guard
BEFORE INSERT ON backup_restore_admission_binding
BEGIN
  SELECT RAISE(ABORT,'BACKUP_RESTORE_ADMISSION_BINDING_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM backup_restore_permission permission
    JOIN backup_restore_target_profile profile
      ON profile.profile_ref=permission.profile_ref AND profile.revision=permission.profile_revision
      AND profile.profile_sha256=permission.profile_sha256
    WHERE permission.permission_ref=NEW.permission_ref AND permission.revision=NEW.permission_revision
      AND permission.permission_sha256=NEW.permission_sha256
      AND permission.restore_id=NEW.restore_id
      AND permission.restore_intent_digest=NEW.restore_intent_digest
      AND permission.intent_sha256=NEW.intent_sha256
      AND permission.actor_sha256=NEW.actor_sha256
      AND permission.request_sha256=NEW.request_sha256
      AND permission.actor_expires_at=NEW.actor_expires_at
      AND permission.copy_authority_sha256=NEW.copy_authority_sha256
      AND permission.primary_binding_sha256=NEW.primary_binding_sha256
      AND permission.profile_ref=NEW.profile_ref AND permission.profile_revision=NEW.profile_revision
      AND permission.profile_sha256=NEW.profile_sha256
      AND permission.valid_from=NEW.valid_from AND permission.expires_at=NEW.expires_at
      AND profile.profile_ref=NEW.profile_ref AND profile.revision=NEW.profile_revision
      AND profile.profile_sha256=NEW.profile_sha256
      AND NOT EXISTS (SELECT 1 FROM backup_restore_permission_revocation revoked
        WHERE revoked.permission_ref=permission.permission_ref AND revoked.permission_revision=permission.revision)
      AND NOT EXISTS (SELECT 1 FROM backup_restore_target_profile_revocation revoked
        WHERE revoked.profile_ref=profile.profile_ref AND revoked.profile_revision=profile.revision)
  );
END;
