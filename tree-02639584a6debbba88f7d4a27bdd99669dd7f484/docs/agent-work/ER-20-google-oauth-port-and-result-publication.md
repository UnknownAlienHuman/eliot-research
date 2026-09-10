# ER-20: Google OAuth port and result publication

**Slice:** 0
**Depends on:** ER-13, ER-14, ER-18
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/google-drive-exchange/src/port.ts`
- `packages/google-drive-exchange/src/token-vault.ts`
- `packages/google-drive-exchange/src/result-publisher.ts`

## Read only

- `packages/contracts/src/drive-exchange.ts`
- `docs/implementation/security-checklist.md`

## Architecture extracts

- §12.8–12.10
- §13.5–13.6

## Required implementation

- Implement small fetch-based Drive/Docs/Sheets port; no Google SDK.
- Use drive.file + offline auth, verify dedicated subject/email, AES-GCM refresh-token vault, short-lived access token cache and reauth state.
- Publish delivery Doc/RESULTS only after canonical artifact + D1 terminal receipt; read back row/metadata.

## Acceptance

- Revocation stops only Drive path.
- Testing-mode token is not production-ready.
- Drive revision/history is diagnostic and never canonical evidence.

## Mandatory negative boundary

Return invalid_grant during result publication and prove ERC artifact remains available while connector becomes REAUTH_REQUIRED.

## Handoff contract

Produce:
- Google REST port
- token vault
- result delivery/readback

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
