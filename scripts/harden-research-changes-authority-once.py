from __future__ import annotations

from pathlib import Path
import json
import re

ROOT = Path.cwd()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8", newline="\n")


secure_service = r'''import {
  ScopeSnapshotSchema,
  type ScopeSnapshot,
} from "@eliotr/contracts";
import {
  createD1ScopeService,
  createOwnerScopeAuthority,
} from "@eliotr/cloudflare-navigation";
import type {
  AuthenticatedRequestContext,
  SemanticApi,
} from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";

const CURSOR_PROTOCOL = "eliotr.research-changes-cursor.v1";
const PAGE_PROTOCOL = "eliotr.research-changes-page.v1";
const CURSOR_TTL_MS = 15 * 60 * 1_000;
const MAX_CURSOR_BYTES = 4_096;
const MAX_LEGACY_CURSOR_BYTES = 2_048;
const MAX_SCOPES = 64;
const MAX_REFS = 1_024;

export type LegacyResearchChanges = (
  context: AuthenticatedRequestContext,
  afterCursor: string,
  allowedScopes: readonly string[],
) => Promise<{ readonly refs: readonly string[]; readonly next_cursor: string }>;

interface CursorAuthority {
  readonly protocol: typeof CURSOR_PROTOCOL;
  readonly principal_ref: string;
  readonly client_class: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly scope_digest: string;
  readonly inner_cursor: string;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

interface ParsedRequest {
  readonly cursor: string | null;
  readonly scope_snapshots: readonly ScopeSnapshot[];
}

export interface ResearchChangesCoreInput {
  readonly legacy: LegacyResearchChanges;
  readonly secret: string;
  readonly deployment_generation: string;
  readonly now?: () => number;
  readonly resolve_scopes: (
    context: AuthenticatedRequestContext,
    rawScopes: unknown,
  ) => Promise<{ readonly ids: readonly string[]; readonly digest: string }>;
}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(raw).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("RESEARCH_CHANGES_INPUT_INVALID", "research changes request has unknown or missing fields");
  }
}

function parseRequest(raw: unknown): { readonly cursor: string | null; readonly raw_scopes: unknown } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("RESEARCH_CHANGES_INPUT_INVALID", "research changes request must be an object");
  }
  const record = raw as Record<string, unknown>;
  exactKeys(record, ["cursor", "scope_snapshots"]);
  const cursor = record.cursor;
  if (cursor !== null && (typeof cursor !== "string" || utf8(cursor).byteLength > MAX_CURSOR_BYTES)) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor is invalid");
  }
  return { cursor: cursor as string | null, raw_scopes: record.scope_snapshots };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor encoding is invalid");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor encoding is invalid");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const bytes = utf8(secret);
  if (bytes.byteLength < 32 || bytes.byteLength > 4_096) {
    fail(
      "RESEARCH_CHANGES_CURSOR_KEY_UNAVAILABLE",
      "research changes cursor signing key is unavailable",
      503,
      true,
    );
  }
  const stable = Uint8Array.from(bytes);
  return crypto.subtle.importKey(
    "raw",
    stable.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function encodeAuthority(authority: CursorAuthority): Uint8Array {
  return utf8(JSON.stringify({
    protocol: authority.protocol,
    principal_ref: authority.principal_ref,
    client_class: authority.client_class,
    credential_generation: authority.credential_generation,
    deployment_generation: authority.deployment_generation,
    scope_digest: authority.scope_digest,
    inner_cursor: authority.inner_cursor,
    issued_at_ms: authority.issued_at_ms,
    expires_at_ms: authority.expires_at_ms,
  }));
}

async function signCursor(secret: string, authority: CursorAuthority): Promise<string> {
  const body = encodeAuthority(authority);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), body));
  const cursor = `${base64UrlEncode(body)}.${base64UrlEncode(signature)}`;
  if (utf8(cursor).byteLength > MAX_CURSOR_BYTES) {
    fail("RESEARCH_CHANGES_CURSOR_TOO_LARGE", "research changes cursor exceeds its byte limit", 500);
  }
  return cursor;
}

function parseCursorBody(bytes: Uint8Array): CursorAuthority {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor body is invalid");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor body is invalid");
  }
  const record = raw as Record<string, unknown>;
  exactKeys(record, [
    "protocol",
    "principal_ref",
    "client_class",
    "credential_generation",
    "deployment_generation",
    "scope_digest",
    "inner_cursor",
    "issued_at_ms",
    "expires_at_ms",
  ]);
  const strings = [
    "principal_ref",
    "client_class",
    "credential_generation",
    "deployment_generation",
    "scope_digest",
    "inner_cursor",
  ] as const;
  if (record.protocol !== CURSOR_PROTOCOL || strings.some((key) => typeof record[key] !== "string")) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor fields are invalid");
  }
  if (
    !Number.isSafeInteger(record.issued_at_ms)
    || !Number.isSafeInteger(record.expires_at_ms)
    || (record.issued_at_ms as number) < 0
    || (record.expires_at_ms as number) <= (record.issued_at_ms as number)
    || utf8(record.inner_cursor as string).byteLength > MAX_LEGACY_CURSOR_BYTES
  ) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor bounds are invalid");
  }
  return record as unknown as CursorAuthority;
}

async function verifyCursor(secret: string, cursor: string): Promise<CursorAuthority> {
  const pieces = cursor.split(".");
  if (pieces.length !== 2 || pieces[0] === undefined || pieces[1] === undefined) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor is malformed");
  }
  const body = base64UrlDecode(pieces[0]);
  const signature = base64UrlDecode(pieces[1]);
  const stableBody = Uint8Array.from(body);
  const stableSignature = Uint8Array.from(signature);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    stableSignature.buffer,
    stableBody.buffer,
  );
  if (!valid) fail("RESEARCH_CHANGES_CURSOR_INVALID", "research changes cursor signature is invalid");
  return parseCursorBody(body);
}

function requireAuthority(
  cursor: CursorAuthority,
  context: AuthenticatedRequestContext,
  deploymentGeneration: string,
  scopeDigest: string,
  now: number,
): void {
  if (cursor.expires_at_ms <= now || cursor.issued_at_ms > now + 60_000) {
    fail("RESEARCH_CHANGES_CURSOR_EXPIRED", "research changes cursor expired", 409);
  }
  if (
    cursor.principal_ref !== context.principal_ref
    || cursor.client_class !== context.client_class
    || cursor.credential_generation !== context.credential_generation
    || cursor.deployment_generation !== deploymentGeneration
    || cursor.scope_digest !== scopeDigest
  ) {
    fail("RESEARCH_CHANGES_CURSOR_AUTHORITY_MISMATCH", "research changes cursor authority changed", 409);
  }
}

function validateLegacyPage(raw: unknown): { readonly refs: readonly string[]; readonly next_cursor: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("RESEARCH_CHANGES_RESULT_INVALID", "research changes store returned an invalid page", 503, true);
  }
  const record = raw as Record<string, unknown>;
  exactKeys(record, ["next_cursor", "refs"]);
  if (
    !Array.isArray(record.refs)
    || record.refs.length > MAX_REFS
    || record.refs.some((ref) => typeof ref !== "string" || ref.length < 1 || utf8(ref).byteLength > 1_024)
    || typeof record.next_cursor !== "string"
    || utf8(record.next_cursor).byteLength > MAX_LEGACY_CURSOR_BYTES
  ) {
    fail("RESEARCH_CHANGES_RESULT_INVALID", "research changes store returned an invalid page", 503, true);
  }
  return { refs: Object.freeze([...record.refs]) as readonly string[], next_cursor: record.next_cursor };
}

export function createResearchChangesCore(input: ResearchChangesCoreInput): SemanticApi["changes"] {
  const now = input.now ?? Date.now;
  return async (context: AuthenticatedRequestContext, raw: unknown) => {
    if (context.client_class !== "owner_pwa") {
      fail("RESEARCH_CHANGES_OWNER_REQUIRED", "research changes requires the owner profile", 403);
    }
    const request = parseRequest(raw);
    const scopes = await input.resolve_scopes(context, request.raw_scopes);
    if (scopes.ids.length < 1 || scopes.ids.length > MAX_SCOPES) {
      fail("RESEARCH_CHANGES_SCOPE_INVALID", "research changes requires a bounded current scope set");
    }
    const currentTime = now();
    let innerCursor = "";
    if (request.cursor !== null) {
      const cursor = await verifyCursor(input.secret, request.cursor);
      requireAuthority(cursor, context, input.deployment_generation, scopes.digest, currentTime);
      innerCursor = cursor.inner_cursor;
    }
    const page = validateLegacyPage(await input.legacy(context, innerCursor, scopes.ids));
    const nextCursor = await signCursor(input.secret, {
      protocol: CURSOR_PROTOCOL,
      principal_ref: context.principal_ref,
      client_class: context.client_class,
      credential_generation: context.credential_generation,
      deployment_generation: input.deployment_generation,
      scope_digest: scopes.digest,
      inner_cursor: page.next_cursor,
      issued_at_ms: currentTime,
      expires_at_ms: currentTime + CURSOR_TTL_MS,
    });
    return { protocol: PAGE_PROTOCOL, refs: page.refs, next_cursor: nextCursor };
  };
}

async function scopeDigest(ids: readonly string[]): Promise<string> {
  const body = utf8(JSON.stringify([...ids]));
  const stable = Uint8Array.from(body);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", stable.buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseScopeSnapshots(raw: unknown): readonly ScopeSnapshot[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SCOPES) {
    fail("RESEARCH_CHANGES_SCOPE_INVALID", "scope_snapshots must contain between one and 64 snapshots");
  }
  return raw.map((candidate) => {
    const parsed = ScopeSnapshotSchema.safeParse(candidate);
    if (!parsed.success) fail("RESEARCH_CHANGES_SCOPE_INVALID", "scope snapshot is invalid");
    return parsed.data;
  });
}

export function createAuthorityBoundResearchChanges(
  env: Pick<Env, "CORE_DB" | "DEPLOYMENT_GENERATION" | "CHANGES_CURSOR_HMAC_SECRET">,
  legacy: LegacyResearchChanges,
): SemanticApi["changes"] {
  const now = Date.now;
  const secret = env.CHANGES_CURSOR_HMAC_SECRET;
  return createResearchChangesCore({
    legacy,
    secret: secret ?? "",
    deployment_generation: env.DEPLOYMENT_GENERATION,
    now,
    async resolve_scopes(context, rawScopes) {
      const snapshots = parseScopeSnapshots(rawScopes);
      const authority = createOwnerScopeAuthority(env.CORE_DB, context, now);
      const service = createD1ScopeService(env.CORE_DB, authority, { now });
      for (const snapshot of snapshots) await service.requireCurrent(snapshot);
      const ids = snapshots.map((snapshot) => snapshot.scope_ref.id);
      ids.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      if (new Set(ids).size !== ids.length) {
        fail("RESEARCH_CHANGES_SCOPE_INVALID", "scope_snapshots contain duplicate scope identities");
      }
      return { ids: Object.freeze(ids), digest: await scopeDigest(ids) };
    },
  });
}
'''

secure_test = r'''import { describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createResearchChangesCore } from "../src/research-changes-authority.js";

const SECRET = "research-changes-test-secret-32-bytes-minimum-value";

function context(overrides: Partial<AuthenticatedRequestContext> = {}): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/changes", { method: "POST" }),
    principal_ref: "principal-owner",
    client_class: "owner_pwa",
    credential_generation: "credential-v1",
    trace_id: "trace-changes",
    ...overrides,
  };
}

function service(now = 1_800_000_000_000) {
  let calls = 0;
  const api = createResearchChangesCore({
    secret: SECRET,
    deployment_generation: "deployment-v1",
    now: () => now,
    resolve_scopes: async (_context, raw) => {
      expect(raw).toEqual([{ scope: "one" }]);
      return { ids: ["scope-one"], digest: "scope-digest-one" };
    },
    legacy: async (_context, cursor, scopes) => {
      calls += 1;
      expect(scopes).toEqual(["scope-one"]);
      return { refs: [`ref-${cursor || "initial"}`], next_cursor: `legacy-${calls}` };
    },
  });
  return { api, calls: () => calls };
}

describe("authority-bound research changes cursor", () => {
  it("signs the legacy cursor and resumes the exact same authority", async () => {
    const fixture = service();
    const first = await fixture.api(context(), { cursor: null, scope_snapshots: [{ scope: "one" }] });
    expect(first).toMatchObject({ protocol: "eliotr.research-changes-page.v1", refs: ["ref-initial"] });
    expect(first.next_cursor).not.toContain("legacy-1");
    const second = await fixture.api(context(), {
      cursor: first.next_cursor,
      scope_snapshots: [{ scope: "one" }],
    });
    expect(second.refs).toEqual(["ref-legacy-1"]);
    expect(fixture.calls()).toBe(2);
  });

  it("rejects tampering before the legacy store is called", async () => {
    const fixture = service();
    const first = await fixture.api(context(), { cursor: null, scope_snapshots: [{ scope: "one" }] });
    const last = first.next_cursor.at(-1);
    const tampered = first.next_cursor.slice(0, -1) + (last === "A" ? "B" : "A");
    await expect(fixture.api(context(), {
      cursor: tampered,
      scope_snapshots: [{ scope: "one" }],
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_INVALID" });
    expect(fixture.calls()).toBe(1);
  });

  it.each([
    ["principal", { principal_ref: "principal-other" }],
    ["client", { client_class: "service" }],
    ["credential", { credential_generation: "credential-v2" }],
  ] as const)("rejects a changed %s authority", async (_label, overrides) => {
    const fixture = service();
    const first = await fixture.api(context(), { cursor: null, scope_snapshots: [{ scope: "one" }] });
    await expect(fixture.api(context(overrides), {
      cursor: first.next_cursor,
      scope_snapshots: [{ scope: "one" }],
    })).rejects.toMatchObject({
      code: overrides.client_class === "service"
        ? "RESEARCH_CHANGES_OWNER_REQUIRED"
        : "RESEARCH_CHANGES_CURSOR_AUTHORITY_MISMATCH",
    });
    expect(fixture.calls()).toBe(1);
  });

  it("rejects expiry, changed scope digest and an unavailable signing key", async () => {
    const fixture = service(1_800_000_000_000);
    const first = await fixture.api(context(), { cursor: null, scope_snapshots: [{ scope: "one" }] });
    const expired = createResearchChangesCore({
      secret: SECRET,
      deployment_generation: "deployment-v1",
      now: () => 1_800_000_901_000,
      resolve_scopes: async () => ({ ids: ["scope-one"], digest: "scope-digest-one" }),
      legacy: async () => ({ refs: [], next_cursor: "never" }),
    });
    await expect(expired(context(), {
      cursor: first.next_cursor,
      scope_snapshots: [{ scope: "one" }],
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_EXPIRED" });

    const changedScope = createResearchChangesCore({
      secret: SECRET,
      deployment_generation: "deployment-v1",
      now: () => 1_800_000_000_001,
      resolve_scopes: async () => ({ ids: ["scope-two"], digest: "scope-digest-two" }),
      legacy: async () => ({ refs: [], next_cursor: "never" }),
    });
    await expect(changedScope(context(), {
      cursor: first.next_cursor,
      scope_snapshots: [{ scope: "one" }],
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_AUTHORITY_MISMATCH" });

    const noKey = createResearchChangesCore({
      secret: "short",
      deployment_generation: "deployment-v1",
      now: () => 1_800_000_000_001,
      resolve_scopes: async () => ({ ids: ["scope-one"], digest: "scope-digest-one" }),
      legacy: async () => ({ refs: [], next_cursor: "legacy" }),
    });
    await expect(noKey(context(), {
      cursor: null,
      scope_snapshots: [{ scope: "one" }],
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_CURSOR_KEY_UNAVAILABLE", status: 503 });
  });

  it("rejects unknown fields and an invalid legacy page", async () => {
    const fixture = service();
    await expect(fixture.api(context(), {
      cursor: null,
      scope_snapshots: [{ scope: "one" }],
      extra: true,
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_INPUT_INVALID" });

    const invalid = createResearchChangesCore({
      secret: SECRET,
      deployment_generation: "deployment-v1",
      resolve_scopes: async () => ({ ids: ["scope-one"], digest: "scope-digest-one" }),
      legacy: async () => ({ refs: Array.from({ length: 1_025 }, (_, index) => `ref-${index}`), next_cursor: "x" }),
    });
    await expect(invalid(context(), {
      cursor: null,
      scope_snapshots: [{ scope: "one" }],
    })).rejects.toMatchObject({ code: "RESEARCH_CHANGES_RESULT_INVALID", status: 503 });
  });
});
'''

write("apps/eliotr-core/src/research-changes-authority.ts", secure_service)
write("apps/eliotr-core/test/research-changes-authority.test.ts", secure_test)

# Optional secret binding: existing environments remain fail-closed until the
# dedicated secret is provisioned; tests can inject it explicitly.
env_path = ROOT / "apps/eliotr-core/src/env.ts"
env = env_path.read_text(encoding="utf-8")
if "CHANGES_CURSOR_HMAC_SECRET" not in env:
    interface = re.search(r"export interface Env\s*\{", env)
    if interface is None:
        raise SystemExit("Env interface anchor missing")
    insertion = interface.end()
    env = env[:insertion] + "\n  readonly CHANGES_CURSOR_HMAC_SECRET?: string;" + env[insertion:]
    env_path.write_text(env, encoding="utf-8", newline="\n")

# Public SemanticApi becomes a single opaque request; the insecure internal
# three-argument function is retained only behind the new facade.
semantic_path = ROOT / "packages/interfaces/src/semantic-api.ts"
semantic = semantic_path.read_text(encoding="utf-8")
page_type = '''export interface ResearchChangesPage {
  readonly protocol: "eliotr.research-changes-page.v1";
  readonly refs: readonly string[];
  readonly next_cursor: string;
}

'''
anchor = "export interface ResearchArtifactSectionCitations {"
if "export interface ResearchChangesPage" not in semantic:
    if anchor not in semantic:
        raise SystemExit("SemanticApi page type anchor missing")
    semantic = semantic.replace(anchor, page_type + anchor, 1)
semantic, count = re.subn(
    r"(?m)^\s*changes\([^\n]+$",
    "  changes(context: AuthenticatedRequestContext, request: unknown): Promise<ResearchChangesPage>;",
    semantic,
    count=1,
)
if count != 1:
    raise SystemExit(f"SemanticApi changes signature replacement count: {count}")
semantic_path.write_text(semantic, encoding="utf-8", newline="\n")

# Legacy implementations often annotated their factory as SemanticApi[changes].
# Remove only that obsolete return annotation; inference preserves the exact
# internal three-argument implementation for the secure adapter.
for path in ROOT.rglob("*.ts"):
    if any(part in {"node_modules", "dist", ".git"} for part in path.parts):
        continue
    if path == Path("apps/eliotr-core/src/research-changes-authority.ts"):
        continue
    text = path.read_text(encoding="utf-8")
    if 'SemanticApi["changes"]' not in text:
        continue
    changed = text.replace('): SemanticApi["changes"] {', ") {")
    if changed != text:
        if "SemanticApi" not in changed.replace('import type { SemanticApi }', ""):
            changed = changed.replace('import type { SemanticApi } from "@eliotr/interfaces";\n', "")
        path.write_text(changed, encoding="utf-8", newline="\n")

# Wrap the exact current legacy expression in composition. Restrict the edit to
# semanticApi, because FederationApi has its own changes property.
composition_path = ROOT / "apps/eliotr-core/src/composition-root.ts"
composition = composition_path.read_text(encoding="utf-8")
secure_import = 'import { createAuthorityBoundResearchChanges } from "./research-changes-authority.js";\n'
if secure_import not in composition:
    composition = secure_import + composition
start = composition.index("function semanticApi")
end = composition.index("function federationApi", start)
section = composition[start:end]
match = re.search(r"(?m)^(?P<indent>\s*)changes:\s*(?P<expression>.+),\s*$", section)
if match is None:
    raise SystemExit("semantic research.changes expression missing")
expression = match.group("expression").strip()
if 'unavailable("research.changes")' in expression:
    raise SystemExit("cannot harden research.changes before internal recovery")
return_index = section.index("  return {")
legacy_declaration = f"  const legacyChanges = {expression};\n"
if "const legacyChanges =" not in section:
    section = section[:return_index] + legacy_declaration + section[return_index:]
section = re.sub(
    r"(?m)^\s*changes:\s*.+,\s*$",
    "    changes: createAuthorityBoundResearchChanges(env, legacyChanges),",
    section,
    count=1,
)
composition = composition[:start] + section + composition[end:]
composition = composition.replace('      "RESEARCH_CHANGES",\n', "", 1)
composition_path.write_text(composition, encoding="utf-8", newline="\n")

# Convert the route to a bounded owner-only POST body.
routes_path = ROOT / "packages/interfaces/src/routes.ts"
routes = routes_path.read_text(encoding="utf-8")
route_pattern = re.compile(r'(?m)^\s*\{[^\n]*operation: "research\.changes"[^\n]*\},?$')
route = '  { method: "POST", path: "/api/v1/research/changes", operation: "research.changes", auth: "owner", maximum_request_bytes: 65536, response_mode: "json" },'
routes, count = route_pattern.subn(route, routes, count=1)
if count != 1:
    raise SystemExit(f"research.changes route replacement count: {count}")
routes_path.write_text(routes, encoding="utf-8", newline="\n")

# Replace the historical query-parameter case with one bounded JSON request.
http_path = ROOT / "apps/eliotr-core/src/http.ts"
http = http_path.read_text(encoding="utf-8")
if 'import { readJsonBodyWithinBytes } from "./bounded-json.js";' not in http:
    http = 'import { readJsonBodyWithinBytes } from "./bounded-json.js";\n' + http
marker = 'case "research.changes":'
case_start = http.find(marker)
if case_start < 0:
    raise SystemExit("research.changes HTTP case missing")
line_start = http.rfind("\n", 0, case_start) + 1
brace = http.find("{", case_start)
if brace < 0:
    raise SystemExit("research.changes HTTP block missing")
depth = 0
quote: str | None = None
escaped = False
index = brace
case_end = -1
while index < len(http):
    char = http[index]
    if quote is not None:
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == quote:
            quote = None
    else:
        if char in {'"', "'", "`"}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                newline = http.find("\n", index)
                case_end = len(http) if newline < 0 else newline + 1
                break
    index += 1
if case_end < 0:
    raise SystemExit("research.changes HTTP block is unterminated")
replacement = '''    case "research.changes": {
      requireNoQuery(url);
      return apiResult(
        request,
        env,
        await application.services.semantic.changes(
          context,
          await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes),
        ),
      );
    }
'''
http = http[:line_start] + replacement + http[case_end:]
http_path.write_text(http, encoding="utf-8", newline="\n")

# Work-packet registration for the two new files.
manifest_path = ROOT / "docs/agent-work/manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))


def find_packet(value: object, packet_id: str):
    if isinstance(value, dict):
        if value.get("id") == packet_id:
            return value
        for child in value.values():
            found = find_packet(child, packet_id)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_packet(child, packet_id)
            if found is not None:
                return found
    return None


owned = [
    "apps/eliotr-core/src/research-changes-authority.ts",
    "apps/eliotr-core/test/research-changes-authority.test.ts",
]
packet = find_packet(manifest, "ER-24")
if packet is None:
    raise SystemExit("ER-24 packet missing")
key = "owned_paths" if "owned_paths" in packet else "ownedPaths"
for value in owned:
    if value not in packet[key]:
        packet[key].append(value)
manifest_path.write_text(
    json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
    newline="\n",
)

docs = list((ROOT / "docs/agent-work").glob("ER-24-*.md"))
if len(docs) != 1:
    raise SystemExit("ER-24 packet document is ambiguous")
doc_path = docs[0]
doc = doc_path.read_text(encoding="utf-8")
heading = re.search(r"(?im)^##\s+Owned paths\s*$", doc)
if heading is None:
    raise SystemExit("ER-24 Owned paths heading missing")
insert_at = heading.end()
additions = "".join(f"\n- `{value}`" for value in owned if f"`{value}`" not in doc)
doc_path.write_text(doc[:insert_at] + additions + doc[insert_at:], encoding="utf-8", newline="\n")

print("authority-bound research.changes facade generated")
