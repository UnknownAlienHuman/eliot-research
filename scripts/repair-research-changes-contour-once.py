from __future__ import annotations

from pathlib import Path
import re
import subprocess

ROOT = Path.cwd()
COMMIT = "5fa963bc66f78007dafd04dc1472d6ec09843694"
PARENT = subprocess.check_output(
    ["git", "rev-parse", f"{COMMIT}^"],
    cwd=ROOT,
    text=True,
    encoding="utf-8",
).strip()


def historical(commit: str, path: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{commit}:{path}"],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
    )


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.write_text(text, encoding="utf-8", newline="\n")


def added_imports(path: str) -> list[str]:
    before = historical(PARENT, path).splitlines()
    after = historical(COMMIT, path).splitlines()
    before_set = set(before)
    return [line for line in after if line.startswith("import ") and line not in before_set]


def insert_imports(current: str, imports: list[str]) -> str:
    missing = [line for line in imports if line not in current]
    if not missing:
        return current
    lines = current.splitlines()
    last_import = -1
    for index, line in enumerate(lines):
        if line.startswith("import ") or (last_import >= 0 and not line.endswith(";")):
            if line.startswith("import ") or last_import >= 0:
                last_import = index
        elif last_import >= 0:
            break
    insertion = last_import + 1 if last_import >= 0 else 0
    lines[insertion:insertion] = missing
    return "\n".join(lines) + ("\n" if current.endswith("\n") else "")


def extract_case(source: str, operation: str) -> str:
    marker = f'case "{operation}":'
    start = source.find(marker)
    if start < 0:
        raise SystemExit(f"historical HTTP case missing: {operation}")
    line_start = source.rfind("\n", 0, start) + 1
    brace = source.find("{", start)
    if brace < 0:
        raise SystemExit(f"historical HTTP case has no block: {operation}")
    depth = 0
    quote: str | None = None
    escaped = False
    index = brace
    while index < len(source):
        char = source[index]
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
                    end = source.find("\n", index)
                    return source[line_start:(len(source) if end < 0 else end + 1)]
        index += 1
    raise SystemExit(f"unterminated historical HTTP case: {operation}")


# Composition: preserve current code, transplant only the historical import and
# service expression that made research.changes executable.
composition_path = "apps/eliotr-core/src/composition-root.ts"
composition = (ROOT / composition_path).read_text(encoding="utf-8")
historical_composition = historical(COMMIT, composition_path)
composition = insert_imports(composition, added_imports(composition_path))
if 'changes: () => unavailable("research.changes")' in composition:
    match = re.search(r"(?m)^\s*changes:\s*.+research\.changes.*$", historical_composition)
    if match is None:
        # The executable expression need not contain the operation string.
        old = historical(PARENT, composition_path)
        old_line = re.search(r"(?m)^\s*changes:\s*.*$", old)
        new_lines = [
            line
            for line in historical_composition.splitlines()
            if re.match(r"^\s*changes:\s*", line)
        ]
        if old_line is None or len(new_lines) != 1:
            raise SystemExit("cannot derive historical composition changes expression")
        replacement = new_lines[0]
    else:
        replacement = match.group(0)
    composition = re.sub(
        r'(?m)^\s*changes:\s*\(\)\s*=>\s*unavailable\("research\.changes"\),?\s*$',
        replacement,
        composition,
        count=1,
    )
write(composition_path, composition)

# Public interface: use the implemented historical request/response contract,
# but do not overwrite other modern SemanticApi methods.
semantic_path = "packages/interfaces/src/semantic-api.ts"
semantic = (ROOT / semantic_path).read_text(encoding="utf-8")
historical_semantic = historical(COMMIT, semantic_path)
semantic = insert_imports(semantic, added_imports(semantic_path))
historical_signature = re.search(r"(?m)^\s*changes\([^\n]+$", historical_semantic)
if historical_signature is None:
    raise SystemExit("historical SemanticApi changes signature missing")
semantic, count = re.subn(
    r"(?m)^\s*changes\([^\n]+$",
    historical_signature.group(0),
    semantic,
    count=1,
)
if count != 1:
    raise SystemExit(f"SemanticApi changes signature replacement count: {count}")
write(semantic_path, semantic)

# Route registry: insert exactly the historical route row if it is absent.
routes_path = "packages/interfaces/src/routes.ts"
routes = (ROOT / routes_path).read_text(encoding="utf-8")
if 'operation: "research.changes"' not in routes:
    historical_routes = historical(COMMIT, routes_path)
    route_line = next(
        (
            line
            for line in historical_routes.splitlines()
            if 'operation: "research.changes"' in line
        ),
        None,
    )
    if route_line is None:
        raise SystemExit("historical research.changes route missing")
    anchor = next(
        (
            line
            for line in routes.splitlines()
            if 'operation: "research.trace"' in line
        ),
        None,
    )
    if anchor is None:
        raise SystemExit("research.trace route anchor missing")
    routes = routes.replace(anchor, anchor + "\n" + route_line, 1)
write(routes_path, routes)

# HTTP dispatch: transplant the bounded historical case and imports only.
http_path = "apps/eliotr-core/src/http.ts"
http = (ROOT / http_path).read_text(encoding="utf-8")
historical_http = historical(COMMIT, http_path)
http = insert_imports(http, added_imports(http_path))
if 'case "research.changes"' not in http:
    case = extract_case(historical_http, "research.changes")
    default_index = http.find("    default:", http.find("function dispatchApi"))
    if default_index < 0:
        raise SystemExit("HTTP dispatch default anchor missing")
    http = http[:default_index] + case + http[default_index:]
write(http_path, http)

# Refuse a fake contour: all restored service files must remain reachable from
# current production composition and HTTP dispatch.
composition = (ROOT / composition_path).read_text(encoding="utf-8")
http = (ROOT / http_path).read_text(encoding="utf-8")
routes = (ROOT / routes_path).read_text(encoding="utf-8")
if 'changes: () => unavailable("research.changes")' in composition:
    raise SystemExit("research.changes remains unavailable after contour repair")
if 'case "research.changes"' not in http:
    raise SystemExit("research.changes HTTP case remains absent")
if 'operation: "research.changes"' not in routes:
    raise SystemExit("research.changes route remains absent")

print("research.changes production contour repaired from accepted historical implementation")
