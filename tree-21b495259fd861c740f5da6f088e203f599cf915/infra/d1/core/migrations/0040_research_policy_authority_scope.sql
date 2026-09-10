-- Allow independently current, authority-bound research scopes to coexist.
-- The policy authority is derived from the verified scope snapshot, so it is
-- part of the server-owned policy identity rather than a global singleton.
DROP INDEX IF EXISTS investigation_current_policy_single_active;
CREATE UNIQUE INDEX IF NOT EXISTS investigation_current_policy_active_identity
  ON investigation_current_policy(policy_authority_ref)
  WHERE state = 'ACTIVE';
