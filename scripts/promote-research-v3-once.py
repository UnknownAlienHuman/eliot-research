from __future__ import annotations

from pathlib import Path
import re

ROOT = Path.cwd()
SOURCE_ROOT = ROOT / "apps/eliotr-core/src"


def production_files() -> list[Path]:
    return sorted(
        path
        for path in SOURCE_ROOT.rglob("*.ts")
        if not path.name.endswith(".test.ts")
    )


candidates: list[tuple[Path, str, str]] = []
patterns = [
    (
        re.compile(r'(?P<prefix>\b(?:DEFAULT|PUBLIC|CURRENT|CREATE|NEW)[A-Z0-9_]*PROTOCOL\s*=\s*)"exploratory\.v2"'),
        lambda match: match.group("prefix") + '"exploratory.v3"',
    ),
    (
        re.compile(r'(?P<prefix>\bprotocol\s*:\s*)"exploratory\.v2"(?P<suffix>\s*[,}])'),
        lambda match: match.group("prefix") + '"exploratory.v3"' + match.group("suffix"),
    ),
    (
        re.compile(r'(?P<prefix>\breturn\s+)"exploratory\.v2"(?P<suffix>\s*;)'),
        lambda match: match.group("prefix") + '"exploratory.v3"' + match.group("suffix"),
    ),
]

for path in production_files():
    text = path.read_text(encoding="utf-8")
    if "exploratory.v2" not in text or "exploratory.v3" not in text:
        continue
    if not re.search(r"research|run|protocol", text, re.IGNORECASE):
        continue
    for pattern, replacement in patterns:
        for match in pattern.finditer(text):
            line_start = text.rfind("\n", 0, match.start()) + 1
            context_start = max(0, text.rfind("\n", 0, max(0, line_start - 500)))
            context = text[context_start:match.end() + 250]
            # Historical decoder/registry branches intentionally retain v2.
            if re.search(r"supported|historical|replay|decoder|parse|schema|versions?", context, re.IGNORECASE):
                continue
            candidates.append((path, match.group(0), replacement(match)))

# A small number of exact assignments is acceptable, but a broad replacement is
# not. All candidates must live in the backend run/session composition.
allowed_names = {
    "research-session.ts",
    "research-run-service.ts",
    "research-stage-handlers.ts",
    "http.ts",
}
candidates = [item for item in candidates if item[0].name in allowed_names]

if len(candidates) == 0:
    # Treat an already promoted backend as success only when v3 is referenced by
    # the production run/session path and no explicit public/default v2 remains.
    relevant = "\n".join(
        path.read_text(encoding="utf-8")
        for path in production_files()
        if path.name in allowed_names
    )
    if "exploratory.v3" not in relevant:
        raise SystemExit("no backend v3 run path exists")
    if re.search(r"(?:DEFAULT|PUBLIC|CURRENT|CREATE|NEW)[A-Z0-9_]*PROTOCOL\s*=\s*\"exploratory\.v2\"", relevant):
        raise SystemExit("public/default v2 remains but no safe promotion anchor was found")
    print("backend public run protocol is already v3")
else:
    unique = {(path, old, new) for path, old, new in candidates}
    if len(unique) > 2:
        rendered = "\n".join(f"{path.relative_to(ROOT)}: {old}" for path, old, _ in sorted(unique))
        raise SystemExit("ambiguous v3 promotion candidates:\n" + rendered)
    for path, old, new in sorted(unique):
        text = path.read_text(encoding="utf-8")
        if text.count(old) != 1:
            raise SystemExit(f"{path}: promotion anchor is not unique")
        path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")
        print(f"promoted {path.relative_to(ROOT)}: {old} -> {new}")

# Preserve explicit historical protocol support. Removing v2 entirely is a
# replay regression and therefore blocks this checkpoint.
all_backend = "\n".join(path.read_text(encoding="utf-8") for path in production_files())
if "exploratory.v2" not in all_backend:
    raise SystemExit("historical exploratory.v2 support was accidentally removed")
if "exploratory.v3" not in all_backend:
    raise SystemExit("exploratory.v3 is not present after promotion")
