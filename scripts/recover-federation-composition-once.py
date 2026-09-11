from __future__ import annotations

from pathlib import Path
import re
import subprocess

ROOT = Path.cwd()
COMPOSITION = "apps/eliotr-core/src/composition-root.ts"
SKIP_PREFIXES = (".github/workflows/", "docs/")
SKIP_EXACT = {"pnpm-lock.yaml"}


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=ROOT,
        check=check,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def show(commit: str, path: str) -> str | None:
    result = run("git", "show", f"{commit}:{path}", check=False)
    return result.stdout if result.returncode == 0 else None


def function_section(source: str, name: str, next_name: str) -> str | None:
    start = source.find(f"function {name}")
    if start < 0:
        return None
    end = source.find(f"function {next_name}", start)
    if end < 0:
        return None
    return source[start:end]


def score(source: str) -> tuple[int, int]:
    section = function_section(source, "federationApi", "ownerApi")
    if section is None:
        return (999, 0)
    unavailable = len(re.findall(r'unavailable\("federation\.', section))
    operations = len(re.findall(r"(?m)^\s{4}[A-Za-z][A-Za-z0-9]*:\s*", section))
    return (unavailable, operations)


commits = run("git", "rev-list", "--all", "--", COMPOSITION).stdout.splitlines()
if not commits:
    raise SystemExit("no composition-root history available")

candidates: list[tuple[int, int, int, str, str]] = []
for commit in commits[:2_000]:
    current = show(commit, COMPOSITION)
    if current is None:
        continue
    current_score, operations = score(current)
    parent = run("git", "rev-parse", f"{commit}^", check=False)
    if parent.returncode != 0:
        continue
    parent_sha = parent.stdout.strip()
    parent_source = show(parent_sha, COMPOSITION)
    if parent_source is None:
        continue
    parent_score, _ = score(parent_source)
    improvement = parent_score - current_score
    if improvement > 0:
        timestamp = int(run("git", "show", "-s", "--format=%ct", commit).stdout.strip())
        candidates.append((improvement, -current_score, timestamp, commit, parent_sha))

if not candidates:
    current_source = (ROOT / COMPOSITION).read_text(encoding="utf-8")
    current_score, operations = score(current_source)
    if current_score == 0 and operations >= 7:
        print("federation composition is already complete")
        raise SystemExit(0)
    raise SystemExit("no historical commit reduces federation unavailable operations")

candidates.sort(reverse=True)
_, neg_score, _, selected, parent = candidates[0]
selected_source = show(selected, COMPOSITION)
if selected_source is None:
    raise SystemExit("selected federation composition disappeared")
selected_score, selected_operations = score(selected_source)
print(
    f"selected federation checkpoint {selected} "
    f"with {selected_operations} operations and {selected_score} unavailable"
)


def changed_paths() -> list[tuple[str, str]]:
    result = run(
        "git",
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        selected,
    )
    output: list[tuple[str, str]] = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        status = parts[0]
        if status.startswith(("R", "C")) and len(parts) == 3:
            output.append(("D", parts[1]))
            output.append(("A", parts[2]))
        elif len(parts) == 2:
            output.append((status[0], parts[1]))
    return output


def relevant(path: str) -> bool:
    if path in SKIP_EXACT or any(path.startswith(prefix) for prefix in SKIP_PREFIXES):
        return False
    lower = path.lower()
    if "federation" in lower:
        return True
    return path in {
        COMPOSITION,
        "apps/eliotr-core/src/http.ts",
        "apps/eliotr-core/src/env.ts",
        "packages/interfaces/src/routes.ts",
        "packages/interfaces/src/federation-api.ts",
        "packages/interfaces/src/index.ts",
        "packages/interfaces/package.json",
        "apps/eliotr-core/package.json",
        "tsconfig.json",
        "pnpm-workspace.yaml",
    }


def apply_patch(path: str) -> str:
    patch = subprocess.check_output(
        ["git", "diff", "--binary", parent, selected, "--", path],
        cwd=ROOT,
    )
    if not patch:
        return "EMPTY"
    reverse = subprocess.run(
        ["git", "apply", "--reverse", "--check", "--whitespace=nowarn", "-"],
        cwd=ROOT,
        input=patch,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if reverse.returncode == 0:
        return "PRESENT"
    clean = subprocess.run(
        ["git", "apply", "--check", "--whitespace=nowarn", "-"],
        cwd=ROOT,
        input=patch,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if clean.returncode == 0:
        subprocess.run(
            ["git", "apply", "--whitespace=nowarn", "-"],
            cwd=ROOT,
            input=patch,
            check=True,
        )
        return "APPLIED"
    three = subprocess.run(
        ["git", "apply", "--3way", "--whitespace=nowarn", "-"],
        cwd=ROOT,
        input=patch,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return "MERGED" if three.returncode == 0 else "CONFLICT"


conflicts: list[str] = []
for status, path in changed_paths():
    if not relevant(path):
        continue
    target = ROOT / path
    if status == "A":
        historical = show(selected, path)
        if historical is None:
            continue
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(historical, encoding="utf-8", newline="\n")
            print("RESTORED", path)
        elif target.read_text(encoding="utf-8") == historical:
            print("PRESENT", path)
        else:
            print("KEEP_NEWER", path)
        continue
    if status == "D":
        print("KEEP_DELETE", path)
        continue
    outcome = apply_patch(path)
    print(outcome, path)
    if outcome == "CONFLICT":
        conflicts.append(path)

# Shared composition can be transplanted narrowly even when its historical
# patch conflicts with newer Wiki/research work.
current_path = ROOT / COMPOSITION
current = current_path.read_text(encoding="utf-8")
current_section = function_section(current, "federationApi", "ownerApi")
selected_section = function_section(selected_source, "federationApi", "ownerApi")
if current_section is None or selected_section is None:
    raise SystemExit("federationApi section is missing")
if score(current)[0] > selected_score:
    # Add only imports that were introduced by the selected checkpoint.
    parent_source = show(parent, COMPOSITION) or ""
    parent_imports = set(line for line in parent_source.splitlines() if line.startswith("import "))
    selected_imports = [
        line
        for line in selected_source.splitlines()
        if line.startswith("import ") and line not in parent_imports
    ]
    lines = current.splitlines()
    insertion = 0
    for index, line in enumerate(lines):
        if line.startswith("import "):
            insertion = index + 1
    for line in selected_imports:
        if line not in lines:
            lines.insert(insertion, line)
            insertion += 1
    current = "\n".join(lines) + "\n"
    current_section = function_section(current, "federationApi", "ownerApi")
    if current_section is None:
        raise SystemExit("current federation section vanished after import merge")
    current = current.replace(current_section, selected_section, 1)

    # The createApplication call may have acquired env/context arguments.
    selected_create = re.search(r"(?m)^\s*federation:\s*federationApi\([^\n]+$", selected_source)
    if selected_create is not None:
        current, count = re.subn(
            r"(?m)^\s*federation:\s*federationApi\([^\n]+$",
            selected_create.group(0),
            current,
            count=1,
        )
        if count != 1:
            raise SystemExit("createApplication federation call replacement failed")
    current_path.write_text(current, encoding="utf-8", newline="\n")

final = current_path.read_text(encoding="utf-8")
final_unavailable, final_operations = score(final)
if final_unavailable != 0 or final_operations < 7:
    raise SystemExit(
        f"federation remains incomplete: operations={final_operations}, unavailable={final_unavailable}"
    )

# Require load-bearing authority terms in the executable implementation. This
# is a conservative gate; absence keeps the checkpoint out of main.
relevant_text = []
for base in (ROOT / "apps", ROOT / "packages"):
    for path in base.rglob("*.ts"):
        if "federation" not in path.as_posix().lower():
            continue
        relevant_text.append(path.read_text(encoding="utf-8"))
joined = "\n".join(relevant_text)
required = {
    "principal": "principal_ref",
    "credential_generation": "credential_generation",
    "idempotency": "idempotency",
    "scope": "scope",
    "manifest": "manifest",
}
missing = [name for name, token in required.items() if token not in joined]
if missing:
    raise SystemExit("federation authority vocabulary missing: " + ", ".join(missing))

print(f"federation composition recovered from {selected}")
