# Owner-web maintenance runtime transition

`eliotr.maintenance-route-update.v2` retains the exact v1 route, source-head,
account, hostname, active deployment/version, generation and empty service
principal pins. It additionally requires exactly this `runtime_compatibility`:

```json
{
  "compatibility_date": "2026-08-28",
  "baseline_flags": [],
  "candidate_flags": ["enhanced_error_serialization"]
}
```

This closed profile supports the error-serialization flag already declared by
the source Worker configuration. It permits no date change, other flag,
removal, unknown field or combined binding bootstrap. V1 continues to require
the existing version's flags to match the candidate flags exactly.

Before upload, the ordinary Worker verifier reads the pinned old version and
checks its flags against the declared empty baseline. It still checks every
other runtime, binding and authority field. The same baseline is checked again
immediately before upload, together with unchanged intent bytes and active
deployment identity. The candidate config is never changed by this comparison.
All post-upload Worker reads compare the actual new version against the source
candidate flags. The deployment receipt retains the exact transition and
intent digest. A successful intent load alone does not establish deployment.

The focused verifier is `node scripts/test-deployment-route-runtime-compatibility.mjs`.
Live output and the existing guarded deployment remain required to establish
that the transition was applied.

`eliotr.maintenance-route-update.v3` adds exactly one declared binding transition:
`browser_binding: { baseline_present: false, candidate: { name: "BROWSER", type: "browser" } }`.
The source candidate must contain exactly `browser: { binding: "BROWSER" }`.
Its baseline verification view omits that binding; an unexpected existing
Browser binding therefore fails the ordinary undeclared-binding check. All
post-upload reads require the source Browser binding and type. V1 and V2 retain
their original behavior. No other resource addition or combined bootstrap is
admitted. This attaches the service already named by source configuration;
successful binding readback does not prove a Browser capture operation.

The flag difference above is declared metadata: Cloudflare documents enhanced
error serialization as the default since 2026-04-21, before this compatibility
date. No change from legacy to enhanced runtime behavior is claimed.
