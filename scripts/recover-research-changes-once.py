from __future__ import annotations

from pathlib import Path
import os
import re
import subprocess

ROOT = Path.cwd()
COMMITS = (
    "5fa963bc66f78007dafd04dc1472d6ec09843694",  # durable changes feed
    "0671ca705776f9f32185fb4e0bd0b940e9fd198b",  # research completion producer
    "8a84b1d46f552d369d50788b06a67331f40d3d28",  # source lifecycle producer
    "44250a9cce5e8ffc8e6faa3b1c3b3d4b39d13b80",  # artifact draft producer
    "8e403352d2f003dc79aa03b4083538a0ddac3567",  # erasure completion producer
)

SKIP_PREFIXES = (
    ".github/workflows/",
    "docs/",
)
SKIP_EXACT = {
    "pnpm-lock.yaml",
}


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


def git_bytes(commit: str, path: str) -> bytes:
    return subprocess.check_output(
        ["git", "show", f"{commit}:{path}"],
        cwd=ROOT,
    )


def changed_paths(commit: str) -> list[tuple[str, str]]:
    result = run(
        "git",
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        commit,
    )
    changes: list[tuple[str, str]] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0]
        if status.startswith("R") or status.startswith("C"):
            if len(parts) != 3:
                raise SystemExit(f"malformed rename/copy entry for {commit}: {line}")
            changes.append(("D", parts[1]))
            changes.append(("A", parts[2]))
        elif len(parts) == 2:
            changes.append((status[0], parts[1]))
        else:
            raise SystemExit(f"malformed diff-tree entry for {commit}: {line}")
    return changes


def skipped(path: str) -> bool:
    return path in SKIP_EXACT or any(path.startswith(prefix) for prefix in SKIP_PREFIXES)


def write_blob(commit: str, path: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(git_bytes(commit, path))


def apply_file_patch(commit: str, path: str) -> str:
    parent = run("git", "rev-parse", f"{commit}^").stdout.strip()
    patch = subprocess.check_output(
        ["git", "diff", "--binary", parent, commit, "--", path],
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

    three_way = subprocess.run(
        ["git", "apply", "--3way", "--whitespace=nowarn", "-"],
        cwd=ROOT,
        input=patch,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if three_way.returncode == 0:
        return "MERGED"
    return "CONFLICT"


def restore_commit(commit: str) -> None:
    if run("git", "cat-file", "-e", f"{commit}^{{commit}}", check=False).returncode != 0:
        raise SystemExit(f"required historical commit is absent: {commit}")
    for status, path in changed_paths(commit):
        if skipped(path):
            continue
        target = ROOT / path
        if status == "A":
            if not target.exists():
                write_blob(commit, path)
                print(f"RESTORED {path} from {commit[:8]}")
                continue
            current = target.read_bytes()
            historical = git_bytes(commit, path)
            if current == historical:
                print(f"PRESENT  {path}")
            else:
                print(f"KEEP_NEWER {path}")
            continue
        if status == "D":
            # Never delete a current-main file from a historical checkpoint.
            print(f"KEEP_DELETE {path}")
            continue
        outcome = apply_file_patch(commit, path)
        print(f"{outcome:9} {path} from {commit[:8]}")


def production_changes_candidates() -> list[Path]:
    candidates: list[Path] = []
    for base in (ROOT / "apps", ROOT / "packages"):
        if not base.exists():
            continue
        for path in base.rglob("*.ts"):
            if any(part in {"node_modules", "dist"} for part in path.parts):
                continue
            text = path.read_text(encoding="utf-8", errors="strict")
            if "research.changes" in text or "research_change" in text or "ResearchChange" in text:
                candidates.append(path)
    return sorted(set(candidates))


def require_product_contour() -> None:
    candidates = production_changes_candidates()
    if not candidates:
        raise SystemExit("historical recovery produced no research-changes implementation")

    composition = (ROOT / "apps/eliotr-core/src/composition-root.ts").read_text(encoding="utf-8")
    routes = (ROOT / "packages/interfaces/src/routes.ts").read_text(encoding="utf-8")
    semantic = (ROOT / "packages/interfaces/src/semantic-api.ts").read_text(encoding="utf-8")
    http = (ROOT / "apps/eliotr-core/src/http.ts").read_text(encoding="utf-8")

    checks = {
        "composition": 'changes: () => unavailable("research.changes")' not in composition,
        "route": 'operation: "research.changes"' in routes,
        "http": 'research.changes' in http,
        "interface": "changes(" in semantic,
        "migration": any(
            "change" in path.name.lower()
            for path in (ROOT / "infra/d1/core/migrations").glob("*.sql")
        ),
    }
    missing = [name for name, passed in checks.items() if not passed]
    if missing:
        print("Research changes candidate files:")
        for path in candidates:
            print(" -", path.relative_to(ROOT).as_posix())
        raise SystemExit("research.changes contour remains incomplete: " + ", ".join(missing))

    print("Recovered research.changes contour:")
    for path in candidates:
        print(" -", path.relative_to(ROOT).as_posix())


for historical_commit in COMMITS:
    restore_commit(historical_commit)

require_product_contour()
