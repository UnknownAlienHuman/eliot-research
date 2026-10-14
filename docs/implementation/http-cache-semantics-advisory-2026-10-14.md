# http-cache-semantics advisory disposition

Observed October 14, 2026. Dependabot alert #28 remains open for
GHSA-ch52-4w7c-c8xp / CVE-2026-93748. This record establishes the current
consumer and emitted-artifact scope; it does not remediate the dependency.

The lock pins `http-cache-semantics@4.2.0` through Astro 7.2.8, which is a
development dependency of `apps/eliotr-pwa`. The vulnerable stale-hit branch
can reuse a shared response with a sufficiently large or unbounded request
`max-stale`. The package's matching checks do not independently bind a user
identity. npm published 4.3.0 on October 4 from
`b1d4bd682fbab0252985de45219f4e7497c0067c`; its source retains this branch.
Changing the lock to 4.3.0 is therefore not an accepted fix for this advisory.

The observed Astro consumer, `astro/dist/assets/build/remote.js`, uses
`storable()` and `timeToLive()` for remote-image build caching, and revalidates
using `no-cache`. It does not call the affected `evaluateRequest()` or
`satisfiesWithoutRevalidation()` methods. Current PWA source has no
`astro:assets`, `Image`, `Picture` or `getImage` entry.

The installed maintenance source `c465ec4d`, Worker version
`4a4524e8-871d-46b8-986f-d8d89e20a385`, has a retained owning compiler graph and
deployment receipt. The current Worker graph contains neither this package nor
the Astro remote-image helper in its modules or absent dependency IDs. The
checked current client JavaScript also has no package or `CachePolicy`
reference. No current product path into the reported stale-hit API was found.
This is bounded source/compiler-output evidence, not a guarantee about future
dependencies or every host tool invocation.

The GHSA reports no first patched version. The CVE remains published and its
record was updated October 12. Upstream issue #56 was closed after a maintainer
disputed the Set-Cookie premise; PR #63 remains unmerged. Its `_allowsReuse`
guard and regression cases are candidate repair evidence, not a released fix.
Keep the alert open and reconsider the consumer path before any upgrade or
dismissal. No application-source patch, version override or dismissal was made.

If a shared-cache caller is introduced, the focused verifier must show that a
stale shared Set-Cookie response without explicit `public`/`immutable` cannot
be reused under unbounded or large `max-stale`. Also cover shared
`proxy-revalidate`, fresh responses and explicit opt-in behavior.

References:

- [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
- [CVE-2026-93748](https://www.cve.org/CVERecord?id=CVE-2026-93748)
- [Upstream 4.3.0 stale-hit code](https://github.com/kornelski/http-cache-semantics/blob/b1d4bd682fbab0252985de45219f4e7497c0067c/index.js#L429)
- [Upstream issue #56](https://github.com/kornelski/http-cache-semantics/issues/56)
- [Unmerged candidate PR #63](https://github.com/kornelski/http-cache-semantics/pull/63)
