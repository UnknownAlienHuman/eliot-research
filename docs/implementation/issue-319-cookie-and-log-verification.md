# Issue #319 cookie and URL-log verification boundary

Reviewed 2026-10-09. This records a bounded source and documentation review. It is not a browser capture, a current Access configuration readback, or a Cloudflare telemetry query. No account settings were changed.

## Source findings

- Core uses the incoming URL for route selection and dispatch. Its trace helper accepts only a bounded, character-checked Ray identifier or generates a random identifier. Problem responses contain fixed status and error metadata plus that trace identifier; they do not include the request URL.
- Core distinguishes owner requests from service-token requests when mapping verified Access identity to route authority. It does not issue the Access authorization cookie. Cookie attributes are controlled by Access, outside this handler.
- The Google OAuth callback passes its URL to a strict parser that extracts only allowlisted callback fields. The handler redirects with a fixed outcome and `no-store` / `no-referrer` headers. The reviewed path does not send the raw callback URL to a logging or persistence sink.
- No `console.*` call in the reviewed Core source emits a request URL. The Access JWKS failure warning bounds its diagnostic text and removes URL and credential-like substrings before logging.

These source checks do not establish what Cloudflare persisted for a deployed invocation. The platform-generated invocation record is a separate logging path.

## Current documentation

- Cloudflare Workers Logs documentation, last updated 2026-10-02, says invocation logs contain request/response metadata and that a fetch invocation message can include the request URL. Cloudflare's current configuration schema describes `redactQueryString` as removing query strings from request URLs in logs and traces, with a default of `false`. This is documented behavior, not proof of a particular deployment's value or event output.
- Cloudflare Access authorization-cookie documentation, last updated 2026-08-03, describes optional `SameSite` values (`None`, `Lax`, `Strict`), says `HttpOnly` is enabled by default, and documents the optional `CF_Binding` cookie. Cloudflare cautions against Binding Cookie for non-browser tools. These are supported controls, not a recommendation for an uninspected profile.

## Acceptance still unverified

The current #319 thread reports a configuration readback, but its latest telemetry attempt could not discover the required event fields and no exact event query was run. Therefore there is no event-level evidence that a unique synthetic query marker is absent while safe route, operation, generation, error, and Ray correlation remains available. The setting readback alone does not prove log contents or historical-log deletion.

The issue thread also leaves actual browser response-cookie attributes unverified. Source review cannot substitute for both a selected-profile configuration readback and a real owner-browser response. The machine/service-token path must remain a separate compatibility check; no cookie setting should be changed based on source inspection alone.

To close these gaps, retain exact profile/configuration/deployment identity only in the private operator record, then capture one bounded synthetic request and query its exact persisted event using natively cataloged fields. Separately capture the actual owner-browser response-cookie attributes without recording cookie values, and confirm the intended machine-client flow remains usable. Do not widen or replay a probe when telemetry discovery fails.

## References

- [Issue #319](https://github.com/UnknownAlienHuman/eliot-research/issues/319)
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#observability)
- [Cloudflare Access authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
