import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "docs/agent-work/frontend-owner-checkpoints.json";
const PACKETS = ["ER-47", "ER-48"];
const CLAIM_ROOT = "docs/agent-work/frontend-owner-claims/";
const SHA = /^[a-f0-9]{40}$/u;
const MAX_BYTES = 1024 * 1024;
const MAX_HISTORY = 2000;
const immutable = ["protocol", "claim_id", "checkpoint_id", "packet_id", "manager_identity",
  "manager_context_id", "leaf_identity", "owner_authorization_ref", "base_sha", "history_base_sha",
  "write_paths", "predecessor_refs", "supersedes_claim_id"];
const claimKeys = [...immutable, "state", "handoff_reason", "evidence_refs", "blocker_refs",
  "handoff_receipt_ref", "takeover_authorization_ref"];
const checkpointKeys = ["id", "kind", "packet_id", "write_scopes", "manager_only", "claim_mode",
  "predecessors", "required_contracts", "evidence_classes", "mandatory_negative_case", "handoff_owner"];

function fail(code, detail = "") {
  throw new Error(`${code}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`);
}
function object(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail("UNKNOWN_FIELD", key);
}
function string(value, code = "BAD_STRING") {
  if (typeof value !== "string" || !value.length || value.length > 2048 || /[\x00-\x1f\x7f]/u.test(value)) fail(code);
}
function array(value, code = "BAD_ARRAY", max = 256) {
  if (!Array.isArray(value) || value.length > max) fail(code);
}
function unique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}
function path(value, glob = false) {
  string(value, "BAD_PATH");
  if (value.startsWith("/") || value.includes("\\") || value.includes(":") || value !== value.normalize("NFC")) fail("BAD_PATH", value);
  const segments = value.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) fail("BAD_PATH", value);
  if (!glob && [...value].some((ch) => "*?[]{}".includes(ch))) fail("BAD_PATH", value);
}
function covers(pattern, target) {
  const regex = pattern.split("**").map((part) => part.split("*").map((piece) =>
    piece.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${regex}$`, "u").test(target);
}
function scopeInside(scope, owners) {
  return owners.some((owner) => owner === scope || (owner.endsWith("/**") &&
    (scope === owner.slice(0, -3) || scope.startsWith(owner.slice(0, -2)))));
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function parseStrictJson(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) fail("JSON_LIMIT");
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? new Set() : null);
      if (stack.length > 64) fail("JSON_DEPTH");
    } else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/[ \t\r\n]/u.test(text[next] ?? "!")) next++;
      if (text[next] === ":") {
        let key;
        try { key = JSON.parse(text.slice(start, i + 1)); } catch { fail("JSON_SYNTAX"); }
        const keys = stack.at(-1);
        if (!(keys instanceof Set)) fail("JSON_SYNTAX");
        if (keys.has(key)) fail("DUPLICATE_JSON_KEY");
        keys.add(key);
      }
    }
  }
  try { return JSON.parse(text); } catch { fail("JSON_SYNTAX"); }
}

function git(root, args, optional = false) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", "-C", root, ...args],
      { encoding: "utf8", maxBuffer: 16 * MAX_BYTES, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  } catch {
    if (optional) return null;
    fail("GIT_READ_FAILED", args[0]);
  }
}
function ancestor(root, older, newer, strict = false) {
  if (!SHA.test(older ?? "") || !SHA.test(newer ?? "")) return false;
  return (!strict || older !== newer) && git(root, ["merge-base", "--is-ancestor", older, newer], true) !== null;
}
function blob(root, rev, file) {
  const result = git(root, ["show", `${rev}:${file}`], true);
  if (result === null) fail("MISSING_BLOB", file);
  return parseStrictJson(result);
}
function filesAt(root, rev, prefix) {
  return git(root, ["ls-tree", "-r", "--name-only", rev, "--", prefix]).split("\n").filter(Boolean);
}
function loadPackets(root, rev) {
  return new Map(PACKETS.map((id) => {
    const file = `docs/agent-work/packets/${id}.json`;
    const input = rev ? blob(root, rev, file) : parseStrictJson(readFileSync(resolve(root, file), "utf8"));
    if (input.protocol !== "eliotr.agent-work.packet.v1" || input.packet?.id !== id) fail("BAD_PACKET", id);
    array(input.packet.owned_paths);
    for (const p of input.packet.owned_paths) path(p, true);
    return [id, input.packet.owned_paths];
  }));
}

export function validateRegistry(registry, packets) {
  object(registry, ["protocol", "checkpoints"], "BAD_REGISTRY");
  if (registry.protocol !== "eliotr.frontend-owner-checkpoints.v1") fail("REGISTRY_PROTOCOL");
  array(registry.checkpoints, "BAD_CHECKPOINTS", 256);
  if (!registry.checkpoints.length) fail("EMPTY_REGISTRY");
  const byId = new Map();
  for (const row of registry.checkpoints) {
    object(row, checkpointKeys, "BAD_CHECKPOINT");
    string(row.id); string(row.packet_id); string(row.mandatory_negative_case);
    if (!/^[A-Z][A-Za-z0-9.-]{0,63}$/u.test(row.id) || byId.has(row.id)) fail("DUPLICATE_OR_BAD_CHECKPOINT", row.id);
    if (!["leaf", "manager_gate", "external_gate"].includes(row.kind)) fail("CHECKPOINT_KIND", row.id);
    for (const field of ["write_scopes", "predecessors", "required_contracts", "evidence_classes"]) {
      array(row[field]); for (const value of row[field]) string(value); unique(row[field], "DUPLICATE_CHECKPOINT_VALUE");
    }
    for (const p of row.write_scopes) path(p, true);
    if (typeof row.manager_only !== "boolean") fail("MANAGER_FLAG", row.id);
    if (row.kind === "leaf") {
      if (row.claim_mode !== "single" || row.manager_only || !row.write_scopes.length) fail("LEAF_MODE", row.id);
    } else if (row.claim_mode !== "none" || !row.manager_only) fail("GATE_MODE", row.id);
    if (row.kind === "external_gate") {
      string(row.handoff_owner, "MISSING_HANDOFF_OWNER");
      if (row.write_scopes.length) fail("EXTERNAL_SCOPE", row.id);
    } else {
      if (!packets.has(row.packet_id)) fail("FOREIGN_PACKET", row.id);
      for (const p of row.write_scopes) if (!scopeInside(p, packets.get(row.packet_id))) fail("PACKET_SCOPE_ESCAPE", p);
    }
    byId.set(row.id, row);
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) fail("CHECKPOINT_CYCLE", id);
    if (visited.has(id)) return;
    const row = byId.get(id);
    if (!row) fail("UNKNOWN_PREDECESSOR", id);
    visiting.add(id);
    for (const dep of row.predecessors) {
      const generation = /^([UC])(\d+)/u.exec(id);
      const dependencyGeneration = /^([UC])(\d+)/u.exec(dep);
      if (generation && dependencyGeneration && generation[1] === dependencyGeneration[1] &&
        Number(dependencyGeneration[2]) > Number(generation[2])) fail("LATER_GENERATION_DEPENDENCY", id);
      visit(dep);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return byId;
}
function predecessors(registry, id, result = new Set()) {
  for (const dep of registry.get(id).predecessors) {
    if (!result.has(dep)) { result.add(dep); predecessors(registry, dep, result); }
  }
  return result;
}
function validateClaim(root, file, claim, registry, packets, head, historyBase) {
  object(claim, claimKeys, "BAD_CLAIM");
  if (claim.protocol !== "eliotr.frontend-owner-claim.v1") fail("CLAIM_PROTOCOL");
  for (const key of ["claim_id", "checkpoint_id", "packet_id", "manager_identity", "manager_context_id",
    "leaf_identity", "owner_authorization_ref"]) string(claim[key], `CLAIM_${key.toUpperCase()}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/u.test(claim.claim_id)) fail("BAD_CLAIM_ID");
  if (file !== `${CLAIM_ROOT}${claim.packet_id}/${claim.claim_id}.json`) fail("CLAIM_PLACEMENT", file);
  const checkpoint = registry.get(claim.checkpoint_id);
  if (!checkpoint || checkpoint.kind !== "leaf" || checkpoint.manager_only) fail("GATE_OR_UNKNOWN_CLAIM", claim.checkpoint_id);
  if (checkpoint.packet_id !== claim.packet_id) fail("CROSS_PACKET_CLAIM");
  if (!ancestor(root, claim.base_sha, head) || !ancestor(root, claim.history_base_sha, claim.base_sha)) fail("CLAIM_BASE");
  if (historyBase && claim.history_base_sha !== historyBase) fail("HISTORY_BASE_MISMATCH");
  array(claim.write_paths, "CLAIM_PATHS");
  if (!claim.write_paths.length) fail("CLAIM_PATHS_EMPTY");
  unique(claim.write_paths.map((p) => p.toLowerCase()), "CLAIM_PATH_COLLISION");
  for (const p of claim.write_paths) {
    path(p);
    if (!checkpoint.write_scopes.some((s) => covers(s, p)) || !packets.get(claim.packet_id).some((s) => covers(s, p))) fail("CLAIM_SCOPE_ESCAPE", p);
    if (p.startsWith(CLAIM_ROOT)) fail("CLAIM_COVERS_CLAIM");
  }
  array(claim.predecessor_refs, "PREDECESSOR_REFS");
  unique(claim.predecessor_refs.map((p) => p?.checkpoint_id), "DUPLICATE_PREDECESSOR");
  const allowed = predecessors(registry, checkpoint.id);
  for (const ref of claim.predecessor_refs) {
    object(ref, ["checkpoint_id", "commit_sha", "approval_ref"], "BAD_PREDECESSOR_REF");
    if (!allowed.has(ref.checkpoint_id)) fail("FOREIGN_PREDECESSOR", ref.checkpoint_id);
    if (!ancestor(root, ref.commit_sha, claim.base_sha, true)) fail("PREDECESSOR_ANCESTRY");
    if (registry.get(ref.checkpoint_id).kind !== "leaf") string(ref.approval_ref, "GATE_APPROVAL_REQUIRED");
    else if (ref.approval_ref !== undefined) string(ref.approval_ref);
  }
  for (const dep of checkpoint.predecessors) {
    if (!claim.predecessor_refs.some((p) => p.checkpoint_id === dep)) fail("MISSING_PREDECESSOR", dep);
  }
  if (!["ACTIVE", "HANDED_OFF"].includes(claim.state)) fail("CLAIM_STATE");
  for (const field of ["evidence_refs", "blocker_refs"]) {
    array(claim[field], `CLAIM_${field.toUpperCase()}`);
    for (const ref of claim[field]) string(ref); unique(claim[field], "DUPLICATE_EVIDENCE");
  }
  if (claim.state === "ACTIVE") {
    if (claim.handoff_reason !== undefined || claim.handoff_receipt_ref !== undefined || claim.takeover_authorization_ref !== undefined) fail("ACTIVE_HANDOFF");
  } else {
    if (!["COMPLETED", "BLOCKED", "ABANDONED", "SUPERSEDED"].includes(claim.handoff_reason)) fail("HANDOFF_REASON");
    string(claim.handoff_receipt_ref, "HANDOFF_RECEIPT_REQUIRED");
    if (claim.handoff_reason === "COMPLETED" && !claim.evidence_refs.length) fail("COMPLETION_EVIDENCE_REQUIRED");
    if (claim.takeover_authorization_ref !== undefined) string(claim.takeover_authorization_ref);
  }
  if (claim.supersedes_claim_id !== undefined) string(claim.supersedes_claim_id);
  return claim;
}
function checkSet(claims) {
  const checkpoints = new Set(); const paths = new Set(); const contexts = new Map(); const ids = new Set();
  for (const claim of claims.values()) {
    if (ids.has(claim.claim_id)) fail("DUPLICATE_CLAIM_ID"); ids.add(claim.claim_id);
    if (claim.state !== "ACTIVE") continue;
    if (checkpoints.has(claim.checkpoint_id)) fail("DUPLICATE_ACTIVE_CHECKPOINT"); checkpoints.add(claim.checkpoint_id);
    const context = `${claim.manager_identity}:${claim.manager_context_id}`;
    if (contexts.has(claim.packet_id) && contexts.get(claim.packet_id) !== context) fail("MULTIPLE_MANAGER_CONTEXTS");
    contexts.set(claim.packet_id, context);
    for (const p of claim.write_paths) {
      if (paths.has(p.toLowerCase())) fail("OVERLAPPING_CLAIMS", p); paths.add(p.toLowerCase());
    }
  }
  for (const claim of claims.values()) if (claim.supersedes_claim_id) {
    const old = [...claims.values()].find((c) => c.claim_id === claim.supersedes_claim_id);
    if (!old || old.packet_id !== claim.packet_id || old.state !== "HANDED_OFF" ||
      old.handoff_reason === "COMPLETED" || !old.takeover_authorization_ref ||
      old.takeover_authorization_ref !== claim.owner_authorization_ref) fail("UNAUTHORIZED_SUPERSESSION");
  }
}
function transition(old, current) {
  for (const key of immutable) if (stable(old[key]) !== stable(current[key])) fail("IMMUTABLE_CLAIM_FIELD", key);
  for (const key of ["evidence_refs", "blocker_refs"]) {
    if (old[key].some((value, i) => current[key][i] !== value)) fail("EVIDENCE_NOT_APPEND_ONLY");
  }
  if (old.state === "HANDED_OFF") {
    if (current.state !== "HANDED_OFF" || old.handoff_reason !== current.handoff_reason ||
      old.handoff_receipt_ref !== current.handoff_receipt_ref ||
      old.takeover_authorization_ref !== current.takeover_authorization_ref) fail("ILLEGAL_HANDOFF_TRANSITION");
  }
}
function claimsAt(root, rev, registry, packets, head, historyBase) {
  const result = new Map();
  const files = filesAt(root, rev, CLAIM_ROOT);
  if (files.length > 512) fail("CLAIM_COUNT_LIMIT");
  for (const file of files) {
    path(file);
    if (!file.endsWith(".json")) fail("UNKNOWN_CLAIM_FILE", file);
    result.set(file, validateClaim(root, file, blob(root, rev, file), registry, packets, head, historyBase));
  }
  checkSet(result); return result;
}
function workingClaims(root, registry, packets, head, base) {
  const result = new Map();
  for (const packet of PACKETS) {
    const dir = resolve(root, CLAIM_ROOT, packet);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir, { withFileTypes: true });
    if (files.length > 512) fail("CLAIM_COUNT_LIMIT");
    for (const item of files) {
      if (!item.isFile() || !item.name.endsWith(".json")) fail("UNKNOWN_CLAIM_FILE", item.name);
      const file = `${CLAIM_ROOT}${packet}/${item.name}`;
      result.set(file, validateClaim(root, file, parseStrictJson(readFileSync(resolve(root, file), "utf8")), registry, packets, head, base));
    }
  }
  checkSet(result); return result;
}
function checkHistory(root, base, head) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]) !== "false") fail("INCOMPLETE_HISTORY");
  if (!ancestor(root, base, head)) fail("UNREACHABLE_HISTORY_BASE");
  const commits = git(root, ["rev-list", "--reverse", "--topo-order", `${base}..${head}`]).split("\n").filter(Boolean);
  if (commits.length > MAX_HISTORY) fail("HISTORY_LIMIT");
  const introduced = new Map(); const firstVersions = new Map();
  const rulesCache = new Map();
  function rulesAt(rev) {
    if (!rulesCache.has(rev)) {
      const scopes = loadPackets(root, rev);
      rulesCache.set(rev, { packets: scopes, registry: validateRegistry(blob(root, rev, REGISTRY), scopes) });
    }
    return rulesCache.get(rev);
  }
  const baseRules = rulesAt(base);
  if (claimsAt(root, base, baseRules.registry, baseRules.packets, head, base).size) fail("HISTORY_BASE_CLIPS_CLAIMS");
  for (const commit of commits) {
    const parents = git(root, ["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean);
    if (!parents.length) fail("INCOMPLETE_HISTORY");
    const currentRules = rulesAt(commit);
    const current = claimsAt(root, commit, currentRules.registry, currentRules.packets, head, base);
    const commitLeafPaths = new Set(); const parentClaims = new Map();
    for (const [file, claim] of current) if (!introduced.has(file)) {
      if (claim.state !== "ACTIVE" || !ancestor(root, claim.base_sha, commit, true)) fail("CLAIM_INTRODUCTION");
      introduced.set(file, commit); firstVersions.set(file, claim);
    } else {
      if (!ancestor(root, introduced.get(file), commit)) fail("CLAIM_REINTRODUCED");
      for (const key of immutable) if (stable(firstVersions.get(file)[key]) !== stable(claim[key])) fail("IMMUTABLE_CLAIM_FIELD", key);
    }
    for (const parent of parents) {
      const beforeRules = rulesAt(parent);
      const before = claimsAt(root, parent, beforeRules.registry, beforeRules.packets, head, base);
      for (const [file, claim] of before) if (claim.state === "ACTIVE") parentClaims.set(file, claim);
      for (const [file, old] of before) {
        if (!current.has(file)) fail("CLAIM_DELETE_OR_RENAME", file);
        transition(old, current.get(file));
      }
      const changed = git(root, ["diff", "--name-only", "--no-renames", parent, commit]).split("\n").filter(Boolean);
      const source = changed.filter((p) => !p.startsWith(CLAIM_ROOT) && PACKETS.some((packet) =>
        beforeRules.packets.get(packet).some((s) => covers(s, p))));
      const leafSource = [];
      for (const p of source) {
        path(p);
        const roles = [...beforeRules.registry.values()].filter((row) => row.write_scopes.some((s) => covers(s, p)));
        if (!roles.length) fail("UNREGISTERED_OWNED_PATH", p);
        if (roles.some((row) => row.kind === "leaf")) leafSource.push(p);
        else if (!roles.some((row) => row.manager_only && row.kind === "manager_gate")) fail("SOURCE_GATE_SCOPE", p);
      }
      for (const p of leafSource) commitLeafPaths.add(p);
    }
    if (commitLeafPaths.size) {
      const cover = [...parentClaims.entries()].filter(([, claim]) =>
        [...commitLeafPaths].every((p) => claim.write_paths.includes(p)));
      if (cover.length !== 1) fail("SOURCE_WITHOUT_SINGLE_PRIOR_CLAIM");
      const [file] = cover[0];
      if (!ancestor(root, introduced.get(file), commit, true)) fail("CLAIM_NOT_PRIOR_ANCESTOR");
    }
  }
  return commits.length;
}

export function checkFrontend({ root = DEFAULT_ROOT, historyBase, head } = {}) {
  root = resolve(root);
  const registry = validateRegistry(parseStrictJson(readFileSync(resolve(root, REGISTRY), "utf8")), loadPackets(root));
  const observedHead = head ?? git(root, ["rev-parse", "HEAD"]);
  if (!SHA.test(observedHead)) fail("BAD_HEAD");
  const packets = loadPackets(root);
  const current = workingClaims(root, registry, packets, observedHead, historyBase);
  const historyClaims = filesAt(root, observedHead, CLAIM_ROOT);
  const ever = git(root, ["log", "-1", "--format=%H", observedHead, "--", CLAIM_ROOT]);
  if ((current.size || historyClaims.length || ever) && (!historyBase || !head)) fail("HISTORY_ARGUMENTS_REQUIRED");
  if (Boolean(historyBase) !== Boolean(head)) fail("HISTORY_ARGUMENTS_REQUIRED");
  let commits = 0;
  if (historyBase) {
    if (!SHA.test(historyBase)) fail("BAD_HISTORY_BASE");
    commits = checkHistory(root, historyBase, observedHead);
    const accepted = claimsAt(root, observedHead, registry, packets, observedHead, historyBase);
    for (const [file, claim] of current) {
      if (!accepted.has(file)) fail("UNCOMMITTED_CLAIM", file);
      transition(accepted.get(file), claim);
    }
    for (const file of accepted.keys()) if (!current.has(file)) fail("CLAIM_WORKTREE_DELETION", file);
    const dirty = [...new Set([...git(root, ["diff", "--name-only", observedHead]).split("\n"),
      ...git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n")])].filter(Boolean);
    for (const p of dirty) {
      if (p.startsWith(CLAIM_ROOT)) continue;
      const roles = [...registry.values()].filter((row) => row.kind === "leaf" && row.write_scopes.some((s) => covers(s, p)));
      if (!roles.length) continue;
      const covering = [...accepted.values()].filter((claim) => claim.state === "ACTIVE" && claim.write_paths.includes(p));
      if (covering.length !== 1) fail("WORKTREE_SOURCE_WITHOUT_PRIOR_CLAIM", p);
    }
  }
  return { protocol: "eliotr.frontend-owner-check.v1", status: "PASS", checkpoints: registry.size,
    claims: current.size, active: [...current.values()].filter((c) => c.state === "ACTIVE").length,
    history_commits: commits, semantic_approval: "NOT_EVALUATED" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = { "--root": "root", "--history-base": "historyBase", "--head": "head" }[args[i]];
      if (!key || !args[i + 1] || input[key] !== undefined) fail("BAD_ARGUMENT");
      input[key] = args[i + 1];
    }
    console.log(JSON.stringify(checkFrontend(input)));
  } catch (error) {
    console.error(`Frontend checkpoints: FAIL ${error instanceof Error ? error.message : "UNKNOWN"}`);
    process.exitCode = 1;
  }
}
