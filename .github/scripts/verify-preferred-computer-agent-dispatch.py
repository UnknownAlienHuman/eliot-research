from pathlib import Path
import hashlib
import json
import re
import sqlite3
import subprocess

required = {
    "infra/d1/core/migrations/0094_computer_agent_preferred_dispatch.sql": [
        "computer-agent-preferred-dispatch-v1",
        "computer_agent_preferred_ready_qualification",
        "computer_agent_preferred_selection_route_guard",
        "computer_agent_preferred_selection_grant_guard",
        "computer_agent_preferred_selection_qualification_guard",
        "computer_agent_preferred_selection_priority_guard",
        "COMPUTER_AGENT_PREFERRED_SETTLEMENT_CONFLICT",
    ],
    "apps/eliotr-core/src/computer-agent-preferred-dispatch.ts": [
        'selection_strategy: "FIRST_READY"',
        "allow_preferred_internal_key: true",
        "readProjectComputerAgentRouteReadiness",
    ],
    "apps/eliotr-core/src/computer-agent-dispatch-store.ts": [
        "reserved preferred-dispatch namespace",
    ],
    "packages/interfaces/src/routes.ts": [
        "research.computer-agent-dispatches.create-preferred",
    ],
}
for name, markers in required.items():
    text = Path(name).read_text(encoding="utf-8")
    for marker in markers:
        if marker not in text:
            raise SystemExit(f"{name}: missing marker {marker!r}")

routes = Path("packages/interfaces/src/routes.ts").read_text(encoding="utf-8")
pairs = re.findall(r'\{ method: "([A-Z]+)", path: "([^"]+)"', routes)
if len(pairs) != len(set(pairs)):
    raise SystemExit("duplicate HTTP route method/path")

changed = subprocess.check_output(
    ["git", "diff", "--name-only", "--diff-filter=AM"], text=True,
).splitlines()
for name in changed:
    path = Path(name)
    if path.suffix not in {".ts", ".tsx", ".js", ".mjs"} or "/src/" not in f"/{name}":
        continue
    current = len(path.read_text(encoding="utf-8").splitlines())
    old = subprocess.run(["git", "show", f"HEAD:{name}"], text=True, capture_output=True)
    if old.returncode != 0:
        assert current <= 600, f"new source exceeds 600 lines: {name} ({current})"
    elif len(old.stdout.splitlines()) <= 600:
        assert current <= 600, f"changed source created a new violation: {name} ({current})"
print("PREFERRED_DISPATCH_STATIC_OK")

# Focused D1 behavior fixture. The first insert selects Muse while Spark is unqualified;
# a second attempt to select Muse is rejected once Spark becomes the earlier READY entry.
db = sqlite3.connect(":memory:")
db.executescript('''
PRAGMA foreign_keys=ON;
CREATE TABLE schema_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
CREATE TABLE project(project_id TEXT PRIMARY KEY);
CREATE TABLE project_owner(project_id TEXT,principal_ref TEXT,PRIMARY KEY(project_id,principal_ref));
CREATE TABLE computer_agent_connection(
  connection_id TEXT,revision INTEGER,state TEXT,owner_principal_ref TEXT,
  actor_issuer TEXT,actor_subject TEXT,task_kinds_json TEXT,transport_capabilities_json TEXT,
  PRIMARY KEY(connection_id,revision));
CREATE VIEW computer_agent_connection_current AS SELECT * FROM computer_agent_connection;
CREATE TABLE project_computer_agent_route(
  project_id TEXT,task_kind TEXT,revision INTEGER,owner_principal_ref TEXT,state TEXT,
  PRIMARY KEY(project_id,task_kind,revision));
CREATE TABLE project_computer_agent_route_entry(
  project_id TEXT,task_kind TEXT,route_revision INTEGER,priority INTEGER,
  connection_id TEXT,connection_revision INTEGER,
  PRIMARY KEY(project_id,task_kind,route_revision,priority),
  UNIQUE(project_id,task_kind,route_revision,priority,connection_id,connection_revision));
CREATE VIEW project_computer_agent_route_current AS SELECT * FROM project_computer_agent_route;
CREATE TABLE project_client_grant(
  grant_id TEXT,revision INTEGER,state TEXT,project_id TEXT,grantor_principal_ref TEXT,
  grantee_method TEXT,grantee_issuer TEXT,grantee_subject TEXT,spend_policy_ref TEXT,
  expires_at TEXT,record_json TEXT,PRIMARY KEY(grant_id,revision));
CREATE VIEW project_client_grant_current AS SELECT * FROM project_client_grant;
CREATE TABLE computer_agent_connection_qualification_binding(challenge_id TEXT PRIMARY KEY);
CREATE TABLE computer_agent_connection_qualification_observation(
  challenge_id TEXT PRIMARY KEY,connection_id TEXT,connection_revision INTEGER,transport TEXT,
  owner_principal_ref TEXT,challenge_state TEXT,auth_profile TEXT,connection_state TEXT,
  current_connection_state TEXT,current_connection_revision INTEGER,
  verified_authentication_method TEXT,verified_actor_ref TEXT,actor_subject TEXT,
  observation_ref TEXT,verified_credential_generation TEXT,deployment_generation TEXT,
  issued_at TEXT,observed_at TEXT,verified_expires_at TEXT);
CREATE TABLE computer_agent_dispatch(
  dispatch_id TEXT PRIMARY KEY,project_id TEXT,task_kind TEXT,transport TEXT,
  route_revision INTEGER,priority INTEGER,connection_id TEXT,connection_revision INTEGER,
  client_grant_id TEXT,client_grant_revision INTEGER,owner_principal_ref TEXT,
  owner_credential_generation TEXT,qualification_challenge_id TEXT,
  qualification_observation_ref TEXT,qualification_credential_generation TEXT,
  deployment_generation TEXT,run_request_sha256 TEXT,created_at TEXT,expires_at TEXT);
''')
db.executescript(Path("infra/d1/core/migrations/0094_computer_agent_preferred_dispatch.sql").read_text())
now = "2026-10-01T09:00:00.000Z"
ready = "2026-10-01T10:00:00.000Z"
db.execute("INSERT INTO project VALUES ('project-1')")
db.execute("INSERT INTO project_owner VALUES ('project-1','owner-1')")
for cid, subject in [("spark", "spark.access"), ("muse", "muse.access")]:
    db.execute("INSERT INTO computer_agent_connection VALUES (?,?,?,?,?,?,?,?)", (
        cid, 1, "ENABLED", "owner-1", "https://issuer.example", subject,
        '["RESEARCH_BRANCH_ANALYSIS"]', '["WEB_INBOX"]',
    ))
db.execute("INSERT INTO project_computer_agent_route VALUES (?,?,?,?,?)", (
    "project-1", "RESEARCH_BRANCH_ANALYSIS", 1, "owner-1", "ACTIVE",
))
db.executemany("INSERT INTO project_computer_agent_route_entry VALUES (?,?,?,?,?,?)", [
    ("project-1", "RESEARCH_BRANCH_ANALYSIS", 1, 0, "spark", 1),
    ("project-1", "RESEARCH_BRANCH_ANALYSIS", 1, 1, "muse", 1),
])
grant_record = json.dumps({"allowed_operations": ["run", "recover", "evidence"]}, separators=(",", ":"))
db.execute("INSERT INTO project_client_grant VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
    "grant-muse", 1, "ACTIVE", "project-1", "owner-1", "service_token",
    "https://issuer.example", "muse.access", "spend-1", ready, grant_record,
))
db.execute("INSERT INTO computer_agent_connection_qualification_binding VALUES ('q-muse')")
db.execute("INSERT INTO computer_agent_connection_qualification_observation VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
    "q-muse", "muse", 1, "WEB_INBOX", "owner-1", "CONFIRMED", "service-token", "ENABLED",
    "ENABLED", 1, "service_token", "muse.access", "muse.access", "obs-muse", "cred-muse",
    "deploy-1", "2026-10-01T08:55:00.000Z", "2026-10-01T08:59:00.000Z", ready,
))
run_sha = hashlib.sha256(b"run-1").hexdigest()

def selection_record(seed: bytes, key: str): tuple[dict, str, str]:
    request_sha = hashlib.sha256(seed).hexdigest()
    selection = {
        "protocol": "eliotr.computer-agent-preferred-selection.v1",
        "selection_id": "preferred-selection-" + request_sha[:48],
        "project_id": "project-1", "task_kind": "RESEARCH_BRANCH_ANALYSIS",
        "selection_strategy": "FIRST_READY", "transport": "WEB_INBOX", "route_revision": 1,
        "priority": 1, "connection_id": "muse", "connection_revision": 1,
        "client_grant_id": "grant-muse", "client_grant_revision": 1,
        "owner_principal_ref": "owner-1", "owner_credential_generation": "owner-gen-1",
        "qualification": {"challenge_id": "q-muse", "observation_ref": "obs-muse",
            "verified_credential_generation": "cred-muse", "ready_until": ready,
            "deployment_generation": "deploy-1"},
        "run_request_sha256": run_sha, "idempotency_key": key,
        "request_sha256": request_sha, "selected_at": now,
    }
    record = json.dumps(selection, sort_keys=True, separators=(",", ":"))
    return selection, request_sha, record

def insert_selection(selection: dict, request_sha: str, record: str) -> None:
    db.execute("INSERT INTO computer_agent_preferred_dispatch_selection VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        selection["selection_id"], "project-1", "RESEARCH_BRANCH_ANALYSIS", "FIRST_READY", "WEB_INBOX", 1, 1,
        "muse", 1, "grant-muse", 1, "owner-1", "owner-gen-1", "q-muse", "obs-muse", "cred-muse",
        ready, "deploy-1", run_sha, selection["idempotency_key"], request_sha, record,
        hashlib.sha256(record.encode()).hexdigest(), now,
    ))

selection, request_sha, record = selection_record(b"preferred-1", "owner-key-1")
insert_selection(selection, request_sha, record)
db.execute("INSERT INTO computer_agent_dispatch VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
    "dispatch-1", "project-1", "RESEARCH_BRANCH_ANALYSIS", "WEB_INBOX", 1, 1, "muse", 1,
    "grant-muse", 1, "owner-1", "owner-gen-1", "q-muse", "obs-muse", "cred-muse", "deploy-1",
    run_sha, now, "2026-10-01T09:15:00.000Z",
))
settlement = {"protocol": "eliotr.computer-agent-preferred-dispatch-settlement.v1",
    "selection_id": selection["selection_id"], "dispatch_id": "dispatch-1", "settled_at": now}
settlement_json = json.dumps(settlement, sort_keys=True, separators=(",", ":"))
db.execute("INSERT INTO computer_agent_preferred_dispatch_settlement VALUES (?,?,?,?,?)", (
    selection["selection_id"], "dispatch-1", settlement_json,
    hashlib.sha256(settlement_json.encode()).hexdigest(), now,
))
assert db.execute("SELECT COUNT(*) FROM computer_agent_preferred_dispatch_settlement").fetchone()[0] == 1

db.execute("INSERT INTO computer_agent_connection_qualification_binding VALUES ('q-spark')")
db.execute("INSERT INTO computer_agent_connection_qualification_observation VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
    "q-spark", "spark", 1, "WEB_INBOX", "owner-1", "CONFIRMED", "service-token", "ENABLED",
    "ENABLED", 1, "service_token", "spark.access", "spark.access", "obs-spark", "cred-spark",
    "deploy-1", "2026-10-01T08:56:00.000Z", "2026-10-01T08:58:00.000Z", ready,
))
selection2, request_sha2, record2 = selection_record(b"preferred-2", "owner-key-2")
rejected = False
try:
    insert_selection(selection2, request_sha2, record2)
except sqlite3.IntegrityError as error:
    rejected = "COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE" in str(error)
assert rejected, "later READY entry was selected while an earlier READY entry existed"
print("PREFERRED_DISPATCH_SQL_BEHAVIOR_OK")
