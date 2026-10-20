from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new), encoding="utf-8")


def remove_once(path: str, block: str) -> None:
    replace_once(path, block, "")


package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
scripts = package.get("scripts")
if not isinstance(scripts, dict):
    raise SystemExit("package.json: scripts is not an object")
if scripts.pop("work-packets:check", None) != "node scripts/check-work-packets.mjs":
    raise SystemExit("package.json: unexpected or missing work-packets:check")
check = scripts.get("check")
if not isinstance(check, str) or check.count(" && pnpm work-packets:check") != 1:
    raise SystemExit("package.json: check script does not contain exactly one work-packets gate")
scripts["check"] = check.replace(" && pnpm work-packets:check", "")
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

remove_once(
    ".github/workflows/ci.yml",
    """      - name: Verify swarm work packets
        if: ${{ !cancelled() && steps.dependencies.outcome == 'success' }}
        run: pnpm work-packets:check
""",
)

remove_once(
    "scripts/test-boundary-negative.mjs",
    """const workPacketPath = resolve(
  root,
  "docs/agent-work/ER-17-access-observability-and-runtime-limits.md",
);

""",
)
remove_once(
    "scripts/test-boundary-negative.mjs",
    """async function withWorkPacketMutation(label, mutate, expectedFragments) {
  const original = await readFile(workPacketPath, "utf8");
  const normalized = original.replaceAll("\\r\\n", "\\n");
  const mutated = mutate(normalized);
  if (mutated === normalized) {
    throw new Error(`${label} fixture did not change ER-17`);
  }

  try {
    await writeFile(workPacketPath, mutated, "utf8");
    runGateExpectingFailure(
      "scripts/check-work-packets.mjs",
      expectedFragments,
      label,
    );
    console.log(`${label}: PASS`);
  } finally {
    await writeFile(workPacketPath, original, "utf8");
  }
}

""",
)
remove_once(
    "scripts/test-boundary-negative.mjs",
    """async function proveWorkPacketParityFailsClosed() {
  const firstOwnedPath =
    "packages/cloudflare-access/**";
  const secondOwnedPath =
    "packages/platform-cloudflare/src/observability.ts";
  const finalPath =
    "packages/platform-cloudflare/src/runtime-limits.test.ts";
  const injectedPath =
    "packages/platform-cloudflare/src/__eliotr_manifest_drift__.test.ts";

  await withWorkPacketMutation(
    "Work-packet document-only ownership drift negative boundary",
    (original) =>
      original.replace(
        `- \\`${finalPath}\\`\\n`,
        `- \\`${finalPath}\\`\\n- \\`${injectedPath}\\`\\n`,
      ),
    [
      `ER-17: packet document owns path absent from manifest: ${injectedPath}`,
    ],
  );

  await withWorkPacketMutation(
    "Work-packet manifest-only ownership drift negative boundary",
    (original) => original.replace(`- \\`${secondOwnedPath}\\`\\n`, ""),
    [
      `ER-17: manifest owns path absent from packet document: ${secondOwnedPath}`,
    ],
  );

  await withWorkPacketMutation(
    "Work-packet ownership order drift negative boundary",
    (original) =>
      original.replace(
        `- \\`${firstOwnedPath}\\`\\n- \\`${secondOwnedPath}\\`\\n`,
        `- \\`${secondOwnedPath}\\`\\n- \\`${firstOwnedPath}\\`\\n`,
      ),
    ["ER-17: manifest and packet document owned paths use different order"],
  );

  await withWorkPacketMutation(
    "Work-packet malformed ownership entry negative boundary",
    (original) =>
      original.replace(`- \\`${firstOwnedPath}\\`\\n`, `- ${firstOwnedPath}\\n`),
    [
      "ER-17: ER-17-access-observability-and-runtime-limits.md:",
      "has malformed owned-path entry",
    ],
  );
}

""",
)
remove_once(
    "scripts/test-boundary-negative.mjs",
    """  await proveWorkPacketParityFailsClosed();
""",
)

replace_once(
    "docs/agent-work/README.md",
    """The generic work-packet manifest/checker still exists. Its coordinated retirement must remove root-script,
negative-fixture and documentation-index dependencies together; this frontend cleanup does not complete that
separate task. The remaining ER-47/48 fragment paths match their documents but reserve no current scope.
Do not add packets, claim JSON, prerequisite commits or status manifests to start authorized work.
""",
    """The generic work-packet checker, manifest, JSON fragments, CI/package callers and packet-only negative fixtures
have also been removed. Historical `Owned paths` sections are explanatory source maps only; they reserve no scope.
Git history retains the deleted packet data. Do not restore packets, claim JSON, prerequisite commits or status
manifests to coordinate authorized work.
""",
)

replace_once(
    "docs/implementation/backend-entrypoints.md",
    """Retire remaining work-packet/AST-shape machinery independently:

- remove `check-work-packets.mjs`, package callers, manifest coupling and packet-only fixtures;
- keep the small current-doc/broken-link check;
- remove exact source-layout requirements from `check-launch-code.mjs`;
- do not replace them with another registry or always-success stub.
""",
    """The work-packet checker, manifest, packet fragments, CI/package callers and packet-only fixtures are removed.
Historical ER documents reserve no paths and Git history is the archive. Do not restore that registry.

Keep the small current-doc/broken-link check. Remove remaining exact source-layout requirements from
`check-launch-code.mjs` without replacing them with another registry or an always-success stub.
""",
)

for relative in (
    "scripts/check-work-packets.mjs",
    "docs/agent-work/manifest.json",
):
    path = ROOT / relative
    if not path.is_file():
        raise SystemExit(f"missing expected predecessor: {relative}")
    path.unlink()

packets = ROOT / "docs/agent-work/packets"
if not packets.is_dir():
    raise SystemExit("missing expected packet directory")
packet_files = sorted(path for path in packets.rglob("*") if path.is_file())
if not packet_files:
    raise SystemExit("packet directory unexpectedly empty")
print(f"removing {len(packet_files)} packet fragments")
shutil.rmtree(packets)
