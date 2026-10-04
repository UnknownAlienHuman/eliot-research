# ADR-0014: Verified Managed OAuth MCP transition during maintenance

- Status: accepted for the owner-directed functional integration checkpoint.
- Date: 2026-10-03.
- Scope: the existing Worker's dedicated `/mcp` Access configuration.

## Context

The owner approved a separate Cloudflare Access application for `/mcp`, using
Cloudflare Managed OAuth and the existing owner identity. Native application
and policy readback confirms its distinct audience and 24-hour session. The
ordinary PWA Access application retains its audience and 168-hour session.

Changing the generated MCP variables is a separate transition from research
runtime configuration, route updates and the AI Search namespace binding.
Those existing intents do not authorize an MCP Access change. A generic
relaxation of Worker variable comparison would hide unrelated drift.

## Decision

1. Use the official Cloudflare MCP OAuth connection for GET-only
   `provision-cloudflare-access.mjs --verify-existing`. Derive configuration
   from its supported Access receipt and actual application/policy readback.
   A local plan or a manually assembled receipt cannot replace that readback.
2. An independent narrow maintenance intent pins the active Worker identity
   and configuration, candidate source and generated configuration, and the
   verified dedicated MCP Access authority. It covers only `MCP_HOSTNAME`,
   `MCP_ACCESS_TEAM_DOMAIN`, `MCP_ACCESS_AUDIENCE` and
   `MCP_ACCESS_AUTH_PROFILE`, with the profile set to `managed-oauth` and removal
   of `MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID` and
   `MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS`.
3. Preserve the ordinary PWA Access authority. Require the dedicated audience
   to differ, the hostname and `/mcp` destination to match the existing Worker,
   and the verified policy to admit only the approved owner identity. The
   transition cannot create an Access application, issue credentials or widen
   its policy.
4. Keep the research runtime transition allowlist unchanged. Route and AI
   Search intents may accompany this intent, with each authorizing only its
   own changes. All other variables, bindings, source inputs and capability
   checks retain their exact comparison rules.
5. Revalidate pinned local inputs and the live baseline before upload, then
   require exact candidate binding readback. Failure or an uncertain upload
   keeps the existing recovery semantics; it does not permit a blind repeat.

## Acceptance boundary

An Access application, receipt or deployed configuration does not establish
client interoperability. Acceptance requires the native client OAuth login,
MCP initialization and tool listing, current-project authorization, exact source
reading, query/run behavior and citation access. No copied browser cookie,
service-token impersonation or custom OAuth service is introduced.
