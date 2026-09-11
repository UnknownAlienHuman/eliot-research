from pathlib import Path
import json
import re

root = Path.cwd()
manifest_path = root / "docs/agent-work/manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

ownership = {
    "ER-12": [
        "apps/eliotr-core/src/wiki-publication-store.ts",
        "apps/eliotr-core/src/wiki-publication-store-support.ts",
        "apps/eliotr-core/test/wiki-publication-store.test.ts",
        "apps/eliotr-core/src/wiki-service.ts",
        "apps/eliotr-core/test/wiki-service.test.ts",
    ],
    "ER-13": [
        "infra/d1/core/migrations/0042_wiki_publication.sql",
    ],
    "ER-24": [
        "apps/eliotr-core/src/bounded-json.ts",
        "apps/eliotr-core/test/bounded-json.test.ts",
    ],
}


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


def normalize_doc(packet_id: str, paths: list[str]) -> None:
    docs = list((root / "docs/agent-work").glob(f"{packet_id}-*.md"))
    if len(docs) != 1:
        raise SystemExit(f"{packet_id}: expected one packet document, found {len(docs)}")
    path = docs[0]
    text = path.read_text(encoding="utf-8")
    heading = re.search(r"(?im)^##\s+Owned paths\s*$", text)
    if heading is None:
        raise SystemExit(f"{packet_id}: Owned paths heading is absent")
    tail = text[heading.end():]
    next_heading = re.search(r"(?m)^##\s+", tail)
    section_end = heading.end() + (next_heading.start() if next_heading else len(tail))
    section = text[heading.end():section_end]

    # Remove every existing occurrence from the entire section, including bullets
    # previously appended after explanatory prose where the packet parser cannot see them.
    lines = section.splitlines()
    wanted = set(paths)
    retained: list[str] = []
    for line in lines:
        match = re.match(r"^\s*-\s+`([^`]+)`\s*$", line)
        if match is not None and match.group(1) in wanted:
            continue
        retained.append(line)

    # Locate the initial machine-readable bullet run. Blank lines before/between
    # bullets are allowed; explanatory prose terminates the owned-path list.
    insertion = 0
    started = False
    for index, line in enumerate(retained):
        stripped = line.strip()
        if not started:
            if stripped == "":
                insertion = index + 1
                continue
            if re.match(r"^-\s+`[^`]+`\s*$", stripped):
                started = True
                insertion = index + 1
                continue
            break
        if stripped == "" or re.match(r"^-\s+`[^`]+`\s*$", stripped):
            insertion = index + 1
            continue
        break

    bullets = [f"- `{item}`" for item in paths]
    retained[insertion:insertion] = bullets
    normalized = "\n".join(retained)
    if section.endswith("\n"):
        normalized += "\n"
    path.write_text(text[:heading.end()] + normalized + text[section_end:], encoding="utf-8", newline="\n")


for packet_id, paths in ownership.items():
    packet = find_packet(manifest, packet_id)
    if packet is None:
        raise SystemExit(f"missing work packet {packet_id}")
    key = "owned_paths" if "owned_paths" in packet else "ownedPaths" if "ownedPaths" in packet else None
    if key is None or not isinstance(packet[key], list):
        raise SystemExit(f"{packet_id}: owned path list is absent")
    packet[key] = [value for value in packet[key] if value not in paths] + paths
    normalize_doc(packet_id, paths)

manifest_path.write_text(
    json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
    newline="\n",
)

# Assert the exact parser-visible prefix that check-work-packets.mjs reads.
for packet_id, paths in ownership.items():
    doc = next((root / "docs/agent-work").glob(f"{packet_id}-*.md"))
    text = doc.read_text(encoding="utf-8")
    heading = re.search(r"(?im)^##\s+Owned paths\s*$", text)
    if heading is None:
        raise SystemExit(f"{packet_id}: Owned paths heading disappeared")
    tail = text[heading.end():]
    next_heading = re.search(r"(?m)^##\s+", tail)
    section = tail[: next_heading.start() if next_heading else len(tail)]
    visible: list[str] = []
    started = False
    for line in section.splitlines():
        match = re.match(r"^\s*-\s+`([^`]+)`\s*$", line)
        if match is not None:
            started = True
            visible.append(match.group(1))
        elif started and line.strip() != "":
            break
    missing = [item for item in paths if item not in visible]
    if missing:
        raise SystemExit(f"{packet_id}: parser-visible ownership still missing {missing}")

print("Wiki ownership is parser-visible and synchronized")
