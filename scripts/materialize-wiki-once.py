from pathlib import Path
import re
import subprocess
import textwrap

root = Path.cwd()


def historical(commit: str, path: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{commit}:{path}"],
        text=True,
        encoding="utf-8",
    )


def extract_here_doc(commit: str, workflow_path: str, target: str) -> str:
    source = historical(commit, workflow_path)
    marker = f"cat > {target} <<'EOF'"
    marker_index = source.find(marker)
    if marker_index < 0:
        raise SystemExit(f"{target}: historical here-doc marker not found")
    start = source.find("\n", marker_index) + 1
    terminator = re.search(r"(?m)^\s*EOF\s*$", source[start:])
    if start < 1 or terminator is None:
        raise SystemExit(f"{target}: malformed historical here-doc")
    return textwrap.dedent(source[start:start + terminator.start()])


def write(path: str, content: str) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8", newline="\n")


storage_commit = "3e20252d027cdf57939166a4fac1dd068b6bddc5"
storage_workflow = ".github/workflows/wiki-publication-slice-once.yml"
route_commit = "8fea2435931faa5cab1dcb510f22b7498805fbbb"
route_workflow = ".github/workflows/wiki-route-slice-once.yml"

store = extract_here_doc(
    storage_commit,
    storage_workflow,
    "apps/eliotr-core/src/wiki-publication-store.ts",
)
migration = extract_here_doc(
    storage_commit,
    storage_workflow,
    "infra/d1/core/migrations/0042_wiki_publication.sql",
)
store_test = extract_here_doc(
    storage_commit,
    storage_workflow,
    "apps/eliotr-core/test/wiki-publication-store.test.ts",
)
service = extract_here_doc(
    route_commit,
    route_workflow,
    "apps/eliotr-core/src/wiki-service.ts",
)
service_test = extract_here_doc(
    route_commit,
    route_workflow,
    "apps/eliotr-core/test/wiki-service.test.ts",
)

dependency_pattern = re.compile(
    r"async function dependencyDigest\(page: WikiPageRevision\): Promise<string> \{"
    r"\s*return textDigest\(JSON\.stringify\(\[\.\.\.page\.dependency_refs\]\.sort\(\)\)\);"
    r"\s*\}",
)
store, changed = dependency_pattern.subn(
    '''async function dependencyDigest(page: WikiPageRevision): Promise<string> {
  const refs = [...page.dependency_refs];
  refs.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return textDigest(JSON.stringify(refs));
}''',
    store,
    count=1,
)
if changed != 1:
    raise SystemExit(f"Wiki dependency digest correction count: {changed}")

# Keep the public API's explicit 0 sentinel; the domain layer maps it to an empty head.
service_test = service_test.replace(
    "import { body, count, db, principal, runtime, setupOrientationDatabase }",
    "import { count, db, principal, runtime, setupOrientationDatabase }",
    1,
)

semantic_path = root / "packages/interfaces/src/semantic-api.ts"
semantic = semantic_path.read_text(encoding="utf-8")
import_anchor = "  ArtifactRevision,\n"
if "  WikiPageRevision,\n" not in semantic:
    if import_anchor not in semantic:
        raise SystemExit("Semantic API WikiPageRevision import anchor missing")
    semantic = semantic.replace(
        import_anchor,
        import_anchor + "  WikiPageRevision,\n",
        1,
    )
types_anchor = "export interface ResearchArtifactSectionCitations {"
wiki_types = '''export type WikiDraftRiskClass =
  | "D0_MECHANICAL"
  | "D1_LOW_RISK_ADDITIVE"
  | "D2_ANALYTICAL"
  | "D3_AUTHORITY_SENSITIVE";

export interface WikiProposalRequest {
  readonly page: WikiPageRevision;
  readonly risk_class: WikiDraftRiskClass;
}

export interface WikiProposalResult {
  readonly protocol: "eliotr.wiki-proposal.v1";
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly risk_class: WikiDraftRiskClass;
  readonly state: "PROPOSED";
}

'''
if "export interface WikiProposalRequest" not in semantic:
    if types_anchor not in semantic:
        raise SystemExit("Semantic API Wiki type anchor missing")
    semantic = semantic.replace(types_anchor, wiki_types + types_anchor, 1)
old_signature = (
    "  proposeWiki(context: AuthenticatedRequestContext, proposalRef: VersionedRef): "
    "Promise<VersionedRef>;"
)
new_signature = (
    "  proposeWiki(context: AuthenticatedRequestContext, request: unknown): "
    "Promise<WikiProposalResult>;"
)
if old_signature not in semantic:
    raise SystemExit("Semantic API Wiki signature anchor missing")
semantic = semantic.replace(old_signature, new_signature, 1)
semantic_path.write_text(semantic, encoding="utf-8", newline="\n")

bounded = '''import {
  readRequestBodyWithinBytes,
  RuntimeLimitError,
} from "@eliotr/platform-cloudflare";
import { CatalogInputError } from "./catalog-service.js";

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function declaredLength(request: Request, maximumBytes: number): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    fail("REQUEST_CONTENT_LENGTH_INVALID", "content-length is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail("REQUEST_CONTENT_LENGTH_INVALID", "content-length is invalid");
  }
  if (value > maximumBytes) {
    fail("REQUEST_BODY_TOO_LARGE", "request body exceeds the route byte limit", 413);
  }
  return value;
}

export async function readJsonBodyWithinBytes(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    fail("REQUEST_MEDIA_TYPE_INVALID", "content-type application/json is required", 415);
  }
  const declared = declaredLength(request, maximumBytes);
  let bytes: Uint8Array;
  try {
    bytes = await readRequestBodyWithinBytes(request, {
      label: "http.request.json",
      max_bytes: maximumBytes,
      max_chunks: 4_096,
    });
  } catch (error) {
    if (error instanceof RuntimeLimitError) throw error;
    fail("REQUEST_BODY_UNAVAILABLE", "request body stream is unavailable", 503, true);
  }
  if (declared !== undefined && declared !== bytes.byteLength) {
    fail("REQUEST_CONTENT_LENGTH_MISMATCH", "content-length does not match the received body");
  }
  if (bytes.byteLength === 0) {
    fail("REQUEST_BODY_INVALID", "JSON request body is required");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("REQUEST_BODY_INVALID", "request body is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("REQUEST_BODY_INVALID", "request body is not valid JSON");
  }
}
'''
bounded_test = '''import { describe, expect, it } from "vitest";
import { readJsonBodyWithinBytes } from "./bounded-json.js";

function streamed(
  bytes: Uint8Array,
  input: { readonly contentType?: string; readonly contentLength?: string } = {},
): Request {
  const headers = new Headers({
    "content-type": input.contentType ?? "application/json",
  });
  if (input.contentLength !== undefined) headers.set("content-length", input.contentLength);
  return new Request("https://research.example/test", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded JSON request reader", () => {
  it("accepts the exact byte ceiling and rejects max+1 actual bytes", async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    await expect(readJsonBodyWithinBytes(streamed(bytes), bytes.byteLength))
      .resolves.toEqual({ a: 1 });
    await expect(readJsonBodyWithinBytes(streamed(bytes), bytes.byteLength - 1))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("rejects understated Content-Length, malformed UTF-8 and wrong media type", async () => {
    const bytes = new TextEncoder().encode("{}");
    await expect(readJsonBodyWithinBytes(
      streamed(bytes, { contentLength: "1" }),
      16,
    )).rejects.toMatchObject({ code: "REQUEST_CONTENT_LENGTH_MISMATCH" });
    await expect(readJsonBodyWithinBytes(
      streamed(new Uint8Array([0xc3, 0x28])),
      16,
    )).rejects.toMatchObject({ code: "REQUEST_BODY_INVALID" });
    await expect(readJsonBodyWithinBytes(
      streamed(bytes, { contentType: "text/plain" }),
      16,
    )).rejects.toMatchObject({ code: "REQUEST_MEDIA_TYPE_INVALID", status: 415 });
  });
});
'''

routes_path = root / "packages/interfaces/src/routes.ts"
routes = routes_path.read_text(encoding="utf-8")
route = (
    '  { method: "POST", path: "/api/v1/research/wiki/proposals", '
    'operation: "research.wiki.propose", auth: "owner", '
    'maximum_request_bytes: 262144, response_mode: "json" },\n'
)
route_anchor = '  { method: "POST", path: "/api/v1/research/query", operation: "research.query"'
if 'operation: "research.wiki.propose"' not in routes:
    position = routes.find(route_anchor)
    if position < 0:
        raise SystemExit("Research query route anchor missing")
    routes = routes[:position] + route + routes[position:]
routes_path.write_text(routes, encoding="utf-8", newline="\n")

composition_path = root / "apps/eliotr-core/src/composition-root.ts"
composition = composition_path.read_text(encoding="utf-8")
wiki_import = 'import { createWikiProposalService } from "./wiki-service.js";\n'
if wiki_import not in composition:
    composition = wiki_import + composition
placeholder = 'proposeWiki: () => unavailable("research.wiki.propose")'
if placeholder not in composition:
    raise SystemExit("Wiki composition placeholder missing")
composition = composition.replace(
    placeholder,
    "proposeWiki: createWikiProposalService(env)",
    1,
)
enabled_anchor = (
    '    enabled_slices: ["HEALTH", "ACCESS", "CATALOG", "INGEST", '
    '"EVIDENCE", "ORIENTATION_METADATA", "RESEARCH"],'
)
if "partial_slices:" not in composition:
    if enabled_anchor not in composition:
        raise SystemExit("Capability slice anchor missing")
    composition = composition.replace(
        enabled_anchor,
        enabled_anchor + '\n    partial_slices: ["WIKI"],',
        1,
    )
composition = composition.replace('      "WIKI",\n', "", 1)
composition_path.write_text(composition, encoding="utf-8", newline="\n")

http_path = root / "apps/eliotr-core/src/http.ts"
http = http_path.read_text(encoding="utf-8")
bounded_import = 'import { readJsonBodyWithinBytes } from "./bounded-json.js";\n'
if bounded_import not in http:
    http = bounded_import + http
wiki_case = '''    case "research.wiki.propose": {
      requireNoQuery(url);
      return apiResult(
        request,
        env,
        await application.services.semantic.proposeWiki(
          context,
          await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes),
        ),
      );
    }
'''
case_anchor = '    case "research.verify": {'
if 'case "research.wiki.propose"' not in http:
    position = http.find(case_anchor)
    if position < 0:
        raise SystemExit("HTTP research.verify case anchor missing")
    http = http[:position] + wiki_case + http[position:]
unbounded_reads = http.count("await request.json()")
if unbounded_reads != 2:
    raise SystemExit(f"Expected two research request.json calls, found {unbounded_reads}")
http = http.replace(
    "await request.json()",
    "await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes)",
)
http_path.write_text(http, encoding="utf-8", newline="\n")

write("apps/eliotr-core/src/wiki-publication-store.ts", store)
write("infra/d1/core/migrations/0042_wiki_publication.sql", migration)
write("apps/eliotr-core/test/wiki-publication-store.test.ts", store_test)
write("apps/eliotr-core/src/wiki-service.ts", service)
write("apps/eliotr-core/test/wiki-service.test.ts", service_test)
write("apps/eliotr-core/src/bounded-json.ts", bounded)
write("apps/eliotr-core/src/bounded-json.test.ts", bounded_test)

print("Wiki product slice materialized")
