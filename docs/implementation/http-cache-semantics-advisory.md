# `http-cache-semantics` Dependabot alert

Checked 2026-10-09. Dependabot alert [#28](https://github.com/UnknownAlienHuman/eliot-research/security/dependabot/28) remains open for `http-cache-semantics`, with vulnerable range `<=4.2.0` and `first_patched_version: null`. The current [GHSA](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) has the same range and no patched version.

## Dependency path and reachability evidence

The current pnpm path is `@eliotr/pwa` (dev dependency) → `astro@7.2.8` → `http-cache-semantics@4.2.0`. The workspace manifest pins Astro in `devDependencies`; `pnpm why -r http-cache-semantics` reports this single path. The PWA source and installed Astro JavaScript inspected in the source review contain no direct call or import of `http-cache-semantics` (Astro declares it in its package manifest).

This establishes a tooling dependency path, not a demonstrated product request consumer. It is reachability evidence only: it is not an exploitability finding or assurance that the vulnerable behavior is unreachable in every toolchain execution.

## Upstream status and remediation boundary

The npm registry currently identifies `4.3.0` as the latest release. Although it lies beyond the GHSA's stated `<=4.2.0` range, it is **not a verified root-cause fix**. Do not upgrade or override to `4.3.0` solely to clear the alert or treat the range boundary as proof of remediation.

The proposed cache-reuse/revalidation correction remains unmerged in upstream [PR #63](https://github.com/kornelski/http-cache-semantics/pull/63). The advisory dispute remains open in [GitHub Advisory Database issue #10139](https://github.com/github/advisory-database/issues/10139); the upstream [issue #56](https://github.com/kornelski/http-cache-semantics/issues/56) records the maintainer's objection to the original Set-Cookie claim. These unresolved upstream positions do not provide a patched version or a project-local workaround. The advisory's consumer-side cache workarounds do not map to a demonstrated PWA cache consumer here.

## Next proven-fix update

Keep alert #28 open. Revisit after upstream publishes a version whose released source demonstrably fixes the relevant cache-reuse behavior, or GitHub corrects/withdraws the advisory. Then update through Astro's dependency resolution or a pnpm override to that verified version and confirm the lockfile resolves it. Do not substitute a version-range bypass for that evidence.
