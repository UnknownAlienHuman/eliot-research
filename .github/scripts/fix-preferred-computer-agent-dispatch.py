from pathlib import Path
from textwrap import dedent

path = Path("infra/d1/core/migrations/0094_computer_agent_preferred_dispatch.sql")
text = path.read_text(encoding="utf-8")
start_marker = "CREATE TRIGGER computer_agent_preferred_selection_insert_guard\n"
end_marker = "CREATE TRIGGER computer_agent_preferred_selection_no_update\n"
start = text.find(start_marker)
end = text.find(end_marker)
if start < 0 or end < 0 or end <= start:
    raise SystemExit("preferred selection guard markers changed")

replacement = dedent(r'''
CREATE VIEW computer_agent_preferred_ready_qualification AS
SELECT q.*
FROM computer_agent_connection_qualification_observation q
WHERE q.challenge_id=(
  SELECT q2.challenge_id
  FROM computer_agent_connection_qualification_observation q2
  WHERE q2.connection_id=q.connection_id
    AND q2.connection_revision=q.connection_revision AND q2.transport=q.transport
  ORDER BY q2.issued_at DESC,q2.challenge_id DESC LIMIT 1
)
AND q.challenge_state='CONFIRMED' AND q.auth_profile='service-token'
AND q.connection_state='ENABLED' AND q.current_connection_state='ENABLED'
AND q.current_connection_revision=q.connection_revision
AND q.verified_authentication_method='service_token'
AND q.verified_actor_ref=q.actor_subject;

CREATE TRIGGER computer_agent_preferred_selection_route_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN NOT EXISTS (
  SELECT 1
  FROM project_computer_agent_route_current r
  JOIN project_computer_agent_route_entry e
    ON e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND e.priority=NEW.priority AND e.connection_id=NEW.connection_id
    AND e.connection_revision=NEW.connection_revision
  JOIN computer_agent_connection_current c
    ON c.connection_id=e.connection_id AND c.revision=e.connection_revision AND c.state='ENABLED'
  JOIN project_owner o ON o.project_id=r.project_id AND o.principal_ref=r.owner_principal_ref
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind
    AND r.revision=NEW.route_revision AND r.state='ACTIVE'
    AND r.owner_principal_ref=NEW.owner_principal_ref
    AND c.owner_principal_ref=NEW.owner_principal_ref
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value=NEW.task_kind)
    AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) WHERE value=NEW.transport)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_grant_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN NOT EXISTS (
  SELECT 1
  FROM project_client_grant_current g
  JOIN computer_agent_connection_current c
    ON c.connection_id=NEW.connection_id AND c.revision=NEW.connection_revision
  WHERE g.grant_id=NEW.client_grant_id AND g.revision=NEW.client_grant_revision
    AND g.state='ACTIVE' AND g.project_id=NEW.project_id
    AND g.grantor_principal_ref=NEW.owner_principal_ref
    AND g.grantee_method='service_token'
    AND g.grantee_issuer=c.actor_issuer AND g.grantee_subject=c.actor_subject
    AND g.spend_policy_ref IS NOT NULL AND julianday(g.expires_at)>julianday(NEW.selected_at)
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='recover')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='evidence')
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_qualification_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_preferred_ready_qualification q
  WHERE q.challenge_id=NEW.qualification_challenge_id
    AND q.connection_id=NEW.connection_id
    AND q.connection_revision=NEW.connection_revision
    AND q.transport=NEW.transport
    AND q.owner_principal_ref=NEW.owner_principal_ref
    AND q.observation_ref=NEW.qualification_observation_ref
    AND q.verified_credential_generation=NEW.qualification_credential_generation
    AND q.deployment_generation=NEW.deployment_generation
    AND julianday(q.observed_at)<=julianday(NEW.selected_at)
    AND julianday(NEW.selected_at)<julianday(q.observed_at,'+1 day')
    AND julianday(NEW.selected_at)<julianday(q.verified_expires_at)
    AND julianday(NEW.qualification_ready_until)<=julianday(q.observed_at,'+1 day')
    AND julianday(NEW.qualification_ready_until)<=julianday(q.verified_expires_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_priority_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN EXISTS (
  SELECT 1
  FROM project_computer_agent_route_entry pe
  JOIN computer_agent_connection_current pc
    ON pc.connection_id=pe.connection_id AND pc.revision=pe.connection_revision
    AND pc.state='ENABLED'
  JOIN computer_agent_preferred_ready_qualification pq
    ON pq.connection_id=pe.connection_id AND pq.connection_revision=pe.connection_revision
    AND pq.transport=NEW.transport
  WHERE pe.project_id=NEW.project_id AND pe.task_kind=NEW.task_kind
    AND pe.route_revision=NEW.route_revision AND pe.priority<NEW.priority
    AND pc.owner_principal_ref=NEW.owner_principal_ref
    AND EXISTS (SELECT 1 FROM json_each(pc.task_kinds_json) WHERE value=NEW.task_kind)
    AND EXISTS (SELECT 1 FROM json_each(pc.transport_capabilities_json) WHERE value=NEW.transport)
    AND pq.deployment_generation=NEW.deployment_generation
    AND julianday(pq.observed_at)<=julianday(NEW.selected_at)
    AND julianday(NEW.selected_at)<julianday(pq.observed_at,'+1 day')
    AND julianday(NEW.selected_at)<julianday(pq.verified_expires_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

''').lstrip()
path.write_text(text[:start] + replacement + text[end:], encoding="utf-8")
