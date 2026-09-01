from pathlib import Path

EVIDENCE_SHA = "9e9a4d6bbfd5f2a67427714e7adfb9d71eb6c296"
RUN_ID = "33522427515"


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise SystemExit(f"unexpected {label}: expected one exact match")
    return source.replace(old, new, 1)


def update_readiness_plan() -> None:
    path = Path("docs/implementation/production-readiness-plan.md")
    plan = path.read_text()

    old_language = (
        "`eliotr.language-runtime.v1` M0 is complete. M1–M7 are not complete. The current TypeScript domain code\n"
        "is a transitional executable specification; it is not the final production owner of deterministic domain\n"
        "authority."
    )
    new_language = (
        "`eliotr.language-runtime.v1` M0 and M1 are complete. M2–M7 are not complete. The current TypeScript\n"
        "domain code remains the active transitional executable specification; no product authority moved to Rust\n"
        "during M1."
    )
    plan = replace_once(plan, old_language, new_language, "language-migration state")

    start = plan.index("## 4. Phase 2 — establish the Rust verification foundation (M1)")
    end = plan.index("## 5. Phase 3 — migrate canonical identity and serialization (M2)")
    phase = plan[start:end]

    owner_line = "**Owners:** ER-00, ER-01, Rust migration owner.\n"
    status = (
        f"**Status:** COMPLETE on 2026-09-01. Implementation evidence commit `{EVIDENCE_SHA}` passed CI run\n"
        f"`{RUN_ID}` with both the legacy TypeScript/Cloudflare job and the Rust M1 job successful. This closes only\n"
        "the verification foundation: M2–M7 and every live platform/provider receipt remain open.\n"
    )
    phase = replace_once(phase, owner_line, f"{owner_line}\n{status}", "Phase 2 owner line")
    phase = phase.replace("- [ ]", "- [x]")

    old_exit = """```text
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --workspace --all-features
cargo test --doc --workspace
cargo deny check
cargo build --workspace --target wasm32-unknown-unknown --release
```"""
    new_exit = """```text
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo nextest run --workspace --all-features --locked
cargo test --doc --workspace --all-features --locked
cargo deny check
cargo build --workspace --target wasm32-unknown-unknown --release --locked
cargo +nightly-2026-08-31 llvm-cov --package eliotr-canonical --package eliotr-test-vectors --all-features --locked --branch --fail-under-lines 90 --text
```"""
    phase = replace_once(phase, old_exit, new_exit, "Phase 2 exit-evidence block")

    metrics_anchor = "The existing TypeScript Worker must still pass all current CI and Wrangler dry-run gates.\n"
    metrics = (
        f"\nRetained deterministic evidence on `{EVIDENCE_SHA}`:\n\n"
        "- 28/28 native Rust tests passed; formatting, Clippy, doctests and `cargo deny` passed;\n"
        "- default Wasm: 363 raw / 258 gzip bytes, zero imports, no product ABI;\n"
        "- feature-gated self-test Wasm: 8,790 raw / 4,142 gzip bytes, zero imports;\n"
        "- coverage: 99.60% lines, 96.75% branches, 100% functions and 97.38% regions;\n"
        "- the separately excluded fuzz dependency graph is frozen in `fuzz/Cargo.lock`;\n"
        "- Cloudflare, Google, provider, recovery and workload receipts: `NOT EXECUTED`.\n"
    )
    phase = replace_once(
        phase,
        metrics_anchor,
        metrics_anchor + metrics,
        "Phase 2 TypeScript exit statement",
    )

    path.write_text(plan[:start] + phase + plan[end:])


def update_gap_register() -> None:
    path = Path("docs/implementation/gap-register.md")
    gap = path.read_text()
    old = "| P1 | Rust deterministic-kernel migration M1–M7 required by `eliotr.language-runtime.v1` has not started | ER-00, ER-01, ER-02, ER-03 and capability owners | Cargo workspace and gates; shared TS/native-Rust/Wasm fixtures; shadow receipts; promoted Rust authority; superseded TS domain removal |"
    new = "| P1 | Rust deterministic-kernel M1 verification foundation is complete; M2–M7 authority migration remains open | ER-00, ER-01, ER-02, ER-03 and capability owners | M2 canonical identity/serialization parity; M3–M4 deterministic-domain migration; M5–M7 ABI promotion, shadow receipts, promoted Rust authority and superseded TypeScript removal |"
    path.write_text(replace_once(gap, old, new, "Rust migration gap row"))


def update_packet() -> None:
    path = Path("docs/agent-work/ER-00-workspace-and-verification-gates.md")
    packet = path.read_text()
    if "## Completion evidence — 2026-09-01" in packet:
        raise SystemExit("ER-00 completion evidence already exists")

    completion = (
        f"\n\n## Completion evidence — 2026-09-01\n\n"
        f"Implementation commit `{EVIDENCE_SHA}` passed exact-head CI run `{RUN_ID}`:\n\n"
        "- legacy TypeScript/Cloudflare verification, PWA build, binding generation and Worker dry-run passed;\n"
        "- Rust format, Clippy, 28/28 native tests, doctests and dependency/source policy passed;\n"
        "- the default Wasm artifact was 363 raw / 258 gzip bytes with zero imports and no product ABI;\n"
        "- the feature-gated self-test artifact was 8,790 raw / 4,142 gzip bytes with zero imports;\n"
        "- coverage was 99.60% lines, 96.75% branches, 100% functions and 97.38% regions;\n"
        "- `Cargo.lock` and the excluded `fuzz/Cargo.lock` were consumed with `--locked`;\n"
        "- Cloudflare, Google, provider, recovery and workload receipts were `NOT EXECUTED`.\n\n"
        "M1 is complete. M2 canonical JSON/identity, M3–M4 domain authority, M5 ABI promotion and M6–M7\n"
        "shadow/cutover/removal remain open. TypeScript/Cloudflare remains the active product authority.\n"
    )
    path.write_text(packet.rstrip() + completion)


def main() -> None:
    update_readiness_plan()
    update_gap_register()
    update_packet()

    for path in (
        Path("docs/implementation/production-readiness-plan.md"),
        Path("docs/implementation/gap-register.md"),
        Path("docs/agent-work/ER-00-workspace-and-verification-gates.md"),
    ):
        if "\r" in path.read_text():
            raise SystemExit(f"unexpected CRLF in {path}")


if __name__ == "__main__":
    main()
