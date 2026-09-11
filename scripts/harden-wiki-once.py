from pathlib import Path
import json
import os
import re

root = Path.cwd()


def write(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8", newline="\n")


service_path = root / "apps/eliotr-core/src/wiki-service.ts"
service = service_path.read_text(encoding="utf-8")
start = service.index("/** Existing SemanticApi operation.")
end = service.index("/** Server-side/manual review path", start)
factory = (
    'export function createWikiProposalService(\n'
    '  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,\n'
    '): SemanticApi["proposeWiki"] {\n'
    '  return (context: AuthenticatedRequestContext, raw: unknown) => '
    'propose(env, context, raw);\n'
    '}\n\n'
)
write(service_path, service[:start] + factory + service[end:])

store_path = root / "apps/eliotr-core/src/wiki-publication-store.ts"
store = store_path.read_text(encoding="utf-8")
old_sha = (
    'return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), '
    '(byte) => byte.toString(16).padStart(2, "0")).join("");'
)
new_sha = (
    'const stable = Uint8Array.from(bytes);\n'
    '  return Array.from(new Uint8Array(await crypto.subtle.digest('
    '"SHA-256", stable.buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");'
)
if old_sha not in store:
    raise SystemExit("Wiki SHA-256 type anchor missing")
store = store.replace(old_sha, new_sha, 1)
store = store.replace("  type WikiImmutableRevisionReceipt,\n", "", 1)

commit_start = store.index(
    "const statements = [",
    store.index("async commitHeadAndOutbox"),
)
commit_end = store.index("        ];", commit_start) + len("        ];")
statements = '''const statements = [
          input.expected_head_revision === null
            ? database.prepare(
              "INSERT OR IGNORE INTO wiki_publication_head (page_id, revision, manifest_ref, outbox_ref, updated_at) " +
              "SELECT ?1,?2,?3,?4,?5 WHERE NOT EXISTS (SELECT 1 FROM wiki_publication_head WHERE page_id = ?1)",
            ).bind(input.page.page_ref.id, input.page.page_ref.revision, input.manifest_ref, outboxRef, timestamp)
            : database.prepare(
              "UPDATE wiki_publication_head SET revision = ?2, manifest_ref = ?3, outbox_ref = ?4, updated_at = ?5 " +
              "WHERE page_id = ?1 AND revision = ?6",
            ).bind(input.page.page_ref.id, input.page.page_ref.revision, input.manifest_ref, outboxRef, timestamp, input.expected_head_revision),
          database.prepare(
            "INSERT INTO wiki_publication_revision " +
            "(page_id, revision, proposal_id, proposal_revision, manifest_ref, page_sha256, page_json, body_object_ref, body_sha256, committer_ref, created_at) " +
            "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 WHERE EXISTS (SELECT 1 FROM wiki_publication_head " +
            "WHERE page_id = ?1 AND revision = ?2 AND manifest_ref = ?5 AND outbox_ref = ?12)",
          ).bind(
            input.page.page_ref.id, input.page.page_ref.revision, proposal.proposal_id, proposal.proposal_revision,
            input.manifest_ref, pageSha, encoded, input.page.body_object_ref, input.page.body_sha256,
            input.committer_ref, timestamp, outboxRef,
          ),
          database.prepare(
            "INSERT INTO wiki_publication_outbox " +
            "(outbox_ref, page_id, revision, manifest_ref, payload_sha256, state, created_at) " +
            "SELECT ?1,?2,?3,?4,?5,'PENDING',?6 WHERE EXISTS (SELECT 1 FROM wiki_publication_head " +
            "WHERE page_id = ?2 AND revision = ?3 AND manifest_ref = ?4 AND outbox_ref = ?1)",
          ).bind(outboxRef, input.page.page_ref.id, input.page.page_ref.revision, input.manifest_ref, pageSha, timestamp),
          database.prepare(
            "UPDATE wiki_publication_proposal SET state = 'PUBLISHED', published_at = ?3 " +
            "WHERE proposal_id = ?1 AND proposal_revision = ?2 AND state IN ('PROPOSED','PUBLISHED') " +
            "AND EXISTS (SELECT 1 FROM wiki_publication_head WHERE page_id = ?4 AND revision = ?5 " +
            "AND manifest_ref = ?6 AND outbox_ref = ?7)",
          ).bind(
            proposal.proposal_id, proposal.proposal_revision, timestamp,
            input.page.page_ref.id, input.page.page_ref.revision, input.manifest_ref, outboxRef,
          ),
        ];'''
store = store[:commit_start] + statements + store[commit_end:]
write(store_path, store)

storage_test_path = root / "apps/eliotr-core/test/wiki-publication-store.test.ts"
storage_test = storage_test_path.read_text(encoding="utf-8")
race_anchor = '''      expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
        .toMatchObject({ code: "WIKI_HEAD_CONFLICT" });'''
race_assertions = race_anchor + '''
      const pageId = first.page.page_ref.id;
      const revisionCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_revision WHERE page_id = ?1",
      ).bind(pageId).first<number>("n");
      const outboxCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_outbox WHERE page_id = ?1",
      ).bind(pageId).first<number>("n");
      const publishedCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_proposal WHERE page_id = ?1 AND state = 'PUBLISHED'",
      ).bind(pageId).first<number>("n");
      const proposedCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_proposal WHERE page_id = ?1 AND state = 'PROPOSED'",
      ).bind(pageId).first<number>("n");
      expect({ revisionCount, outboxCount, publishedCount, proposedCount }).toEqual({
        revisionCount: 1, outboxCount: 1, publishedCount: 1, proposedCount: 1,
      });'''
if race_anchor not in storage_test:
    raise SystemExit("Wiki race assertion anchor missing")
write(storage_test_path, storage_test.replace(race_anchor, race_assertions, 1))

http_path = root / "apps/eliotr-core/src/http.ts"
http = http_path.read_text(encoding="utf-8")
if "  QueryRequest,\n" not in http:
    anchor = "  CatalogRequest,\n"
    if anchor not in http:
        raise SystemExit("HTTP QueryRequest import anchor missing")
    http = http.replace(anchor, anchor + "  QueryRequest,\n", 1)
old_query = (
    "const data = await application.services.semantic.query(context, "
    "await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes));"
)
new_query = (
    "const data = await application.services.semantic.query(context, "
    "await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes) as QueryRequest);"
)
old_run = (
    "return apiResult(request, env, await application.services.semantic.run(context, "
    "await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes)));"
)
new_run = (
    "return apiResult(request, env, await application.services.semantic.run(context, "
    "await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes) as QueryRequest));"
)
if old_query not in http or old_run not in http:
    raise SystemExit("HTTP bounded DTO anchors missing")
http = http.replace(old_query, new_query, 1).replace(old_run, new_run, 1)
write(http_path, http)

# Test code must not consume the production Worker source budget. The Vitest
# configuration and test tsconfig already include test/*.ts, so move the
# largest root unit tests there until the Worker has durable headroom.
source_root = root / "apps/eliotr-core/src"
test_root = root / "apps/eliotr-core/test"
code_suffixes = {".ts", ".tsx", ".js", ".mjs"}


def physical_lines(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    if not text:
        return 0
    return len(re.split(r"\r\n|\n|\r", text.rstrip("\r\n")))


def source_total() -> int:
    return sum(
        physical_lines(path)
        for path in source_root.rglob("*")
        if path.is_file() and path.suffix in code_suffixes
    )


mandatory = source_root / "bounded-json.test.ts"
candidates = sorted(
    [
        path
        for path in source_root.glob("*.test.ts")
        if path != mandatory and not (test_root / path.name).exists()
    ],
    key=lambda path: (-physical_lines(path), path.name),
)
selected: list[Path] = []
projected = source_total()
if mandatory.exists() and not (test_root / mandatory.name).exists():
    selected.append(mandatory)
    projected -= physical_lines(mandatory)
for path in candidates:
    if projected <= 9_300:
        break
    selected.append(path)
    projected -= physical_lines(path)
if projected > 10_000:
    raise SystemExit(f"Worker source extraction insufficient: projected={projected}")

selected_map = {
    path.resolve(): (test_root / path.name).resolve()
    for path in selected
}
import_pattern = re.compile(
    r"(?P<prefix>\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*)"
    r"(?P<quote>[\"'])(?P<spec>\.\.?/[^\"']+)(?P=quote)"
)


def rewrite_imports(old: Path, new: Path, text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        spec = match.group("spec")
        raw_target = (old.parent / spec).resolve()
        actual_target = raw_target
        if raw_target.suffix == ".js" and raw_target.with_suffix(".ts").exists():
            actual_target = raw_target.with_suffix(".ts").resolve()
        destination = selected_map.get(actual_target, actual_target)
        if spec.endswith(".js"):
            destination = destination.with_suffix(".js")
        relative = os.path.relpath(destination, new.parent).replace(os.sep, "/")
        if not relative.startswith("."):
            relative = "./" + relative
        return (
            match.group("prefix")
            + match.group("quote")
            + relative
            + match.group("quote")
        )

    return import_pattern.sub(replace, text)


moves: list[tuple[str, str]] = []
for old in selected:
    new = test_root / old.name
    write(new, rewrite_imports(old, new, old.read_text(encoding="utf-8")))
    old.unlink()
    moves.append(
        (old.relative_to(root).as_posix(), new.relative_to(root).as_posix())
    )

# Keep exact path references and ownership records synchronized with moved tests.
replace_suffixes = {
    ".json", ".md", ".mjs", ".js", ".ts", ".yml", ".yaml", ".toml"
}
for candidate in root.rglob("*"):
    if not candidate.is_file() or candidate.suffix not in replace_suffixes:
        continue
    if any(part in {".git", "node_modules", "dist", "target"} for part in candidate.parts):
        continue
    text = candidate.read_text(encoding="utf-8", errors="strict")
    changed = text
    for old_name, new_name in moves:
        changed = changed.replace(old_name, new_name)
    if changed != text:
        write(candidate, changed)

manifest_path = root / "docs/agent-work/manifest.json"
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


def add_doc_paths(packet_id: str, paths: list[str]) -> None:
    docs = list((root / "docs/agent-work").glob(f"{packet_id}-*.md"))
    if len(docs) != 1:
        raise SystemExit(
            f"{packet_id}: expected one packet document, found {len(docs)}"
        )
    path = docs[0]
    text = path.read_text(encoding="utf-8")
    match = re.search(r"(?im)^##\s+Owned paths\s*$", text)
    if match is None:
        raise SystemExit(f"{packet_id}: Owned paths heading is absent")
    tail = text[match.end():]
    next_heading = re.search(r"(?m)^##\s+", tail)
    end = match.end() + (next_heading.start() if next_heading else len(tail))
    section = text[match.end():end]
    additions = "".join(
        f"- `{item}`\n" for item in paths if f"`{item}`" not in section
    )
    if additions:
        if not section.endswith("\n"):
            section += "\n"
        section += additions
        write(path, text[:match.end()] + section + text[end:])


ownership = {
    "ER-12": [
        "apps/eliotr-core/src/wiki-publication-store.ts",
        "apps/eliotr-core/test/wiki-publication-store.test.ts",
        "apps/eliotr-core/src/wiki-service.ts",
        "apps/eliotr-core/test/wiki-service.test.ts",
    ],
    "ER-13": ["infra/d1/core/migrations/0042_wiki_publication.sql"],
    "ER-24": [
        "apps/eliotr-core/src/bounded-json.ts",
        "apps/eliotr-core/test/bounded-json.test.ts",
    ],
}
for packet_id, paths in ownership.items():
    packet = find_packet(manifest, packet_id)
    if packet is None:
        raise SystemExit(f"missing work packet {packet_id}")
    key = (
        "owned_paths"
        if "owned_paths" in packet
        else "ownedPaths"
        if "ownedPaths" in packet
        else None
    )
    if key is None or not isinstance(packet[key], list):
        raise SystemExit(f"{packet_id}: owned path list is absent")
    for value in paths:
        if value not in packet[key]:
            packet[key].append(value)
    add_doc_paths(packet_id, paths)

write(
    manifest_path,
    json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
)

print(f"Worker source lines after test extraction: {source_total()}")
print("Moved tests:", ", ".join(old for old, _ in moves))
