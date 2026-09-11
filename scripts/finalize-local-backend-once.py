from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import re
import subprocess
import sys

ROOT = Path.cwd()
TMP = Path("/tmp/eliot-local-finalizer")
TMP.mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True)
class Checkpoint:
    name: str
    workflow: str
    steps: tuple[str, ...]
    commit_message: str
    marker: tuple[str, ...]
    verify: tuple[str, ...]


def run(
    command: str | list[str],
    *,
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    if isinstance(command, str):
        args = ["bash", "-lc", command]
    else:
        args = command
    result = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        env=os.environ.copy(),
    )
    if check and result.returncode != 0:
        output = result.stdout or ""
        raise RuntimeError(f"command failed ({result.returncode}): {args!r}\n{output}")
    return result


def output(command: str | list[str]) -> str:
    return (run(command, capture=True).stdout or "").strip()


def recover_workflow(name: str) -> Path:
    relative = Path(".github/workflows") / name
    if relative.exists():
        content = relative.read_text(encoding="utf-8")
    else:
        commits = output(["git", "log", "--all", "--format=%H", "--", relative.as_posix()]).splitlines()
        content = ""
        for commit in commits:
            probe = run(
                ["git", "cat-file", "-e", f"{commit}:{relative.as_posix()}"],
                check=False,
                capture=True,
            )
            if probe.returncode == 0:
                content = output(["git", "show", f"{commit}:{relative.as_posix()}"])
                break
        if not content:
            raise RuntimeError(f"no extant historical blob for {relative}")
    destination = TMP / name
    destination.write_text(content.rstrip() + "\n", encoding="utf-8", newline="\n")
    return destination


def workflow_steps(path: Path) -> dict[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    result: dict[str, str] = {}
    current: str | None = None
    index = 0
    while index < len(lines):
        named = re.match(r"^\s*-\s+name:\s*(.+?)\s*$", lines[index])
        if named:
            current = named.group(1).strip("\"'")
            index += 1
            continue
        block = re.match(r"^(\s*)run:\s*\|[-+]?\s*$", lines[index])
        if block and current is not None:
            indentation = len(block.group(1))
            index += 1
            body: list[str] = []
            while index < len(lines):
                line = lines[index]
                if line.strip() and len(line) - len(line.lstrip()) <= indentation:
                    break
                body.append(line[indentation + 2 :] if len(line) >= indentation + 2 else "")
                index += 1
            result[current] = "\n".join(body).rstrip() + "\n"
            continue
        index += 1
    return result


def marker_pending(marker: tuple[str, ...]) -> bool:
    mode, path, *patterns = marker
    target = ROOT / path
    text = target.read_text(encoding="utf-8") if target.exists() else ""
    if mode == "missing-or-contains":
        return not target.exists() or any(re.search(pattern, text, re.S) for pattern in patterns)
    if mode == "contains":
        return any(re.search(pattern, text, re.S) for pattern in patterns)
    if mode == "not-contains":
        return not all(re.search(pattern, text, re.S) for pattern in patterns)
    if mode == "commit-absent":
        subjects = output(["git", "log", "--format=%s", "-n", "500"]).splitlines()
        return patterns[0] not in subjects
    raise RuntimeError(f"unknown marker mode: {mode}")


def execute_step(workflow: Path, name: str) -> None:
    steps = workflow_steps(workflow)
    script = steps.get(name)
    if script is None:
        raise RuntimeError(f"{workflow.name}: missing step {name!r}")
    lowered = script.lower()
    forbidden = ("git push", "git commit", "astro build", "qdrant")
    hits = [token for token in forbidden if token in lowered]
    if hits:
        raise RuntimeError(f"{workflow.name}/{name}: forbidden effects: {hits}")
    script_path = TMP / f"{workflow.stem}-{len(list(TMP.glob('step-*.sh')))}.sh"
    script_path.write_text("set -euo pipefail\n" + script, encoding="utf-8", newline="\n")
    run(["bash", script_path.as_posix()])


def clean_untracked() -> None:
    run(["git", "clean", "-fd", "-e", "node_modules"], check=False)


def checkpoint(definition: Checkpoint, results: list[str]) -> None:
    if not marker_pending(definition.marker):
        results.append(f"SKIP {definition.name}: already integrated")
        return
    base = output(["git", "rev-parse", "HEAD"])
    workflow = recover_workflow(definition.workflow)
    print(f"START {definition.name} from {base}", flush=True)
    try:
        for step in definition.steps:
            execute_step(workflow, step)
        for command in definition.verify:
            run(command)
        run(["git", "add", "-A"])
        if run(["git", "diff", "--cached", "--quiet"], check=False).returncode == 0:
            results.append(f"SKIP {definition.name}: no delta")
            return
        run(["git", "commit", "-m", definition.commit_message])
        commit = output(["git", "rev-parse", "HEAD"])
        results.append(f"PASS {definition.name}: {commit}")
    except Exception as error:
        run(["git", "reset", "--hard", base], check=False)
        clean_untracked()
        results.append(f"DEFER {definition.name}: {error}")


def main() -> int:
    run("git fetch origin '+refs/heads/*:refs/remotes/origin/*'")
    checkpoints = (
        Checkpoint(
            name="wiki",
            workflow="wiki-product-once.yml",
            steps=("Materialize and harden Wiki product slice",),
            commit_message="feat: implement durable Wiki proposals and publication storage",
            marker=(
                "missing-or-contains",
                "apps/eliotr-core/src/wiki-service.ts",
                r"proposeWiki:.*unavailable",
            ),
            verify=(
                "pnpm --filter @eliotr/research test",
                "pnpm --filter @eliotr/interfaces typecheck",
                "pnpm --filter @eliotr/core test",
                "pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false",
                "pnpm budgets:check",
                "pnpm work-packets:check",
            ),
        ),
        Checkpoint(
            name="research-changes",
            workflow="research-changes-product-once.yml",
            steps=(
                "Extract the retained changes implementation",
                "Enforce changes-feed authority invariants",
            ),
            commit_message="feat: implement authenticated durable research changes",
            marker=(
                "contains",
                "apps/eliotr-core/src/composition-root.ts",
                r'changes:.*unavailable\("research\.changes"\)',
            ),
            verify=(
                "pnpm --filter @eliotr/interfaces typecheck",
                "pnpm --filter @eliotr/core test",
                "pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false",
                "pnpm budgets:check",
                "pnpm work-packets:check",
            ),
        ),
        Checkpoint(
            name="federation",
            workflow="federation-product-once.yml",
            steps=(
                "Select and extract a current-main-compatible federation checkpoint",
                "Reject authority regressions before installing dependencies",
            ),
            commit_message="feat: compose authenticated durable federation",
            marker=(
                "contains",
                "apps/eliotr-core/src/composition-root.ts",
                r'unavailable\("federation\.submit"\)',
            ),
            verify=(
                "pnpm --filter @eliotr/federation-api test",
                "pnpm --filter @eliotr/cloudflare-federation test",
                "pnpm --filter @eliotr/core test",
                "pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false",
                "pnpm budgets:check",
                "pnpm work-packets:check",
            ),
        ),
        Checkpoint(
            name="lifecycle-reconciliation",
            workflow="lifecycle-reconcile-product-once.yml",
            steps=("Derive the exact outbox lease schema and implement reconciliation",),
            commit_message="fix: reconcile expired outbox leases instead of reporting zero",
            marker=(
                "contains",
                "apps/eliotr-core/src/composition-root.ts",
                r"repaired:\s*0",
            ),
            verify=(
                "pnpm --filter @eliotr/core exec vitest run test/outbox-reconciler.test.ts",
                "pnpm --filter @eliotr/core typecheck",
                "pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false",
                "pnpm budgets:check",
                "pnpm work-packets:check",
            ),
        ),
        Checkpoint(
            name="governed-stages",
            workflow="research-governed-stages-once.yml",
            steps=(
                "Fetch retained cognitive checkpoints",
                "Extract only governed-stage implementation deltas",
                "Enforce cognitive and evidence invariants",
            ),
            commit_message="feat: execute citation resolution and coverage stages",
            marker=(
                "commit-absent",
                ".",
                "feat: execute citation resolution and coverage stages",
            ),
            verify=(
                "pnpm --filter @eliotr/research test",
                "pnpm --filter @eliotr/cloudflare-research test",
                "pnpm --filter @eliotr/core test",
                "pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false",
                "pnpm budgets:check",
                "pnpm work-packets:check",
            ),
        ),
        Checkpoint(
            name="public-v3",
            workflow="public-research-v3-once.yml",
            steps=(
                "Promote only the public default protocol",
                "Enforce protocol and evidence boundaries",
            ),
            commit_message="feat: make governed research v3 the public default",
            marker=(
                "not-contains",
                "apps/eliotr-core/src/research-session.ts",
                r"createResearchRunService[\s\S]{0,5000}exploratory\.v3",
            ),
            verify=(
                "pnpm --filter @eliotr/core exec vitest run test/public-research-v3.test.ts test/research-session.test.ts test/research-run-status.test.ts test/artifact-draft-reader.test.ts",
                "pnpm --filter @eliotr/research test",
                "pnpm --filter @eliotr/cloudflare-research test",
                "pnpm --filter @eliotr/core typecheck",
                "pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false",
                "pnpm budgets:check",
                "pnpm work-packets:check",
            ),
        ),
    )
    results: list[str] = []
    for definition in checkpoints:
        checkpoint(definition, results)
    result_path = TMP / "results.txt"
    result_path.write_text("\n".join(results) + "\n", encoding="utf-8")
    print(result_path.read_text(encoding="utf-8"), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FINALIZER_FATAL: {error}", file=sys.stderr)
        raise
