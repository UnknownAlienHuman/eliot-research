from pathlib import Path
import json
import re

root = Path.cwd()
path = root / "apps/eliotr-core/src/wiki-publication-store.ts"
source = path.read_text(encoding="utf-8")
marker = "export function createD1R2WikiPublicationPort("
index = source.index(marker)
prefix = source[:index]
factory = source[index:]
body_start = prefix.index("const MAX_BODY_BYTES")
body = prefix[body_start:].rstrip() + "\n"

exports = [
    ("const MAX_BODY_BYTES", "export const MAX_BODY_BYTES"),
    ("const MAX_EVIDENCE_MAP_BYTES", "export const MAX_EVIDENCE_MAP_BYTES"),
    ("const MAX_MANIFEST_BYTES", "export const MAX_MANIFEST_BYTES"),
    ("const SAFE_REF", "export const SAFE_REF"),
    ("const RISK_CLASSES", "export const RISK_CLASSES"),
    ("interface ProposalRow", "export interface ProposalRow"),
    ("interface AuthorityRow", "export interface AuthorityRow"),
    ("interface HeadRow", "export interface HeadRow"),
    ("function fail(", "export function fail("),
    ("function validRef(", "export function validRef("),
    ("function validPrincipal(", "export function validPrincipal("),
    ("function validIdempotency(", "export function validIdempotency("),
    ("function nowIso(", "export function nowIso("),
    ("function pageJson(", "export function pageJson("),
    ("async function sha256(", "export async function sha256("),
    ("async function textDigest(", "export async function textDigest("),
    ("async function dependencyDigest(", "export async function dependencyDigest("),
    ("async function readObject(", "export async function readObject("),
    ("function decodeProposal(", "export function decodeProposal("),
    ("async function loadAuthority(", "export async function loadAuthority("),
    ("function sameCoverage(", "export function sameCoverage("),
    ("async function loadProposalRow(", "export async function loadProposalRow("),
]
for old, new in exports:
    if old not in body:
        raise SystemExit(f"Wiki support split anchor missing: {old}")
    body = body.replace(old, new, 1)

support_imports = '''import {
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import {
  WikiPublicationError,
  type DraftRiskClass,
  type WikiProposalRecord,
} from "@eliotr/research";

'''
support_path = path.with_name("wiki-publication-store-support.ts")
support_path.write_text(support_imports + body, encoding="utf-8", newline="\n")

main_imports = '''import {
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type WikiPageRevision,
} from "@eliotr/contracts";
import {
  type WikiHeadCommit,
  type WikiHeadCommitDisposition,
  type WikiHeadReadback,
  type WikiPublicationPort,
} from "@eliotr/research";
import {
  MAX_BODY_BYTES,
  MAX_EVIDENCE_MAP_BYTES,
  MAX_MANIFEST_BYTES,
  RISK_CLASSES,
  SAFE_REF,
  decodeProposal,
  dependencyDigest,
  fail,
  loadAuthority,
  loadProposalRow,
  nowIso,
  pageJson,
  readObject,
  sameCoverage,
  sha256,
  textDigest,
  validIdempotency,
  validPrincipal,
  validRef,
  type AuthorityRow,
  type HeadRow,
  type ProposalRow,
  type WikiStoreContext,
} from "./wiki-publication-store-support.js";

export {
  recordWikiPublicationAuthority,
  type WikiAuthorityAdmission,
  type WikiStoreContext,
} from "./wiki-publication-store-support.js";

'''
path.write_text(main_imports + factory.lstrip(), encoding="utf-8", newline="\n")

support_ref = "apps/eliotr-core/src/wiki-publication-store-support.ts"
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


packet = find_packet(manifest, "ER-12")
if packet is None:
    raise SystemExit("ER-12 work packet is absent")
key = "owned_paths" if "owned_paths" in packet else "ownedPaths" if "ownedPaths" in packet else None
if key is None or not isinstance(packet[key], list):
    raise SystemExit("ER-12 owned path list is absent")
if support_ref not in packet[key]:
    packet[key].append(support_ref)
manifest_path.write_text(
    json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
    newline="\n",
)

docs = list((root / "docs/agent-work").glob("ER-12-*.md"))
if len(docs) != 1:
    raise SystemExit(f"ER-12: expected one packet document, found {len(docs)}")
doc_path = docs[0]
doc = doc_path.read_text(encoding="utf-8")
if f"`{support_ref}`" not in doc:
    match = re.search(r"(?im)^##\s+Owned paths\s*$", doc)
    if match is None:
        raise SystemExit("ER-12 Owned paths heading is absent")
    tail = doc[match.end():]
    next_heading = re.search(r"(?m)^##\s+", tail)
    end = match.end() + (next_heading.start() if next_heading else len(tail))
    section = doc[match.end():end]
    if not section.endswith("\n"):
        section += "\n"
    section += f"- `{support_ref}`\n"
    doc_path.write_text(doc[:match.end()] + section + doc[end:], encoding="utf-8", newline="\n")

line_counts = {
    path.relative_to(root).as_posix(): len(path.read_text(encoding="utf-8").splitlines()),
    support_path.relative_to(root).as_posix(): len(support_path.read_text(encoding="utf-8").splitlines()),
}
if any(lines > 600 for lines in line_counts.values()):
    raise SystemExit(f"Wiki storage split still exceeds file budget: {line_counts}")
print(line_counts)
