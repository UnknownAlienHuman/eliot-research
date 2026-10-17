# ER-49: legacy frontend claim-history audit

**Status:** superseded for current implementation by [ADR-0019](../adr/0019-compact-refactoring.md).
**Current work authority:** [`backend-entrypoints.md`](../implementation/backend-entrypoints.md).

This document describes the former ER-49 static checkpoint and temporal claim validator. It is retained only
to explain the historical registry, checker, and claim files. ER-49 is not an active scheduler, prerequisite,
or acceptance gate for the compact refactor programme. New work does not add claim JSON or require
claim-before-source Git ancestry.

## Owned paths

- `docs/agent-work/frontend-owner-checkpoints.json`
- `scripts/check-frontend-owner-checkpoints.mjs`
- `scripts/test-frontend-owner-checkpoints.mjs`

These entries reproduce the historical packet mapping only. They do not reserve current write scope or impose
an active checker, test, claim or scheduling gate.

Historical ER-47/ER-48 claim files also remain available for optional audit.

Do not modify or delete old claims merely to make a new task pass. The checker remains fail-closed for its
original protocol; it is not the path-ownership mechanism for current implementation.

Current tasks use one authorized manager checkout/worktree. The manager assigns exact allowed paths and
acceptance evidence, runs parallel tasks only on disjoint paths, and serializes shared composition points,
manifests, routes, SQL, Worker and CI. Existing application, security, UI, integration and release acceptance
continues to apply independently of this historical audit.
