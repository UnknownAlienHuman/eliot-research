# ADR-0013: Empty semantic revision constraint repair

Status: accepted for the bounded owner maintenance lane.
Date: 2026-10-03.

## Problem

Migration 0097 checks semantic revision identifiers with positive GLOB patterns
of 100 and 512 bytes. Cloudflare D1 limits LIKE/GLOB patterns to 50 bytes.
The authoritative revision writer therefore fails before it can persist an
otherwise valid configuration. Editing the already-applied migration would
break migration lineage.

## Decision

Add one forward migration, 0108, replacing those two predicates with equivalent
length, prefix and short negative-character-class checks. Keep the seven
columns, primary/unique keys, JSON and byte bounds, protocol checks and both
immutability triggers unchanged.

Permit this operation only when `research_semantic_config_revision` is empty.
The migration must assert emptiness before dropping or replacing the product
table. A nonempty table or an unexpected guard object fails closed; it must not
delete data, copy rows, perform cleanup or select an alternate migration path.
The assertion uses a regular transient guard table with a strict value check
and an INSERT/SELECT of the emptiness predicate. It is removed only after the
assertion succeeds. No unsafe PRAGMA or schema-catalog edit is permitted.

The deployment SQL classifier may recognize only this exact target and guarded
constraint repair. Its ordinary prohibition of table rebuilds, row copies,
backfills, arbitrary drops and scans remains in force. A different table,
weakened/missing guard, changed column or constraint, extra effect, or alternate
row-copy path must be rejected.

Use a fresh intent covering the full pending migration suffix. Pin the exact
source/configuration, SQL bytes, live before-schema and expected after-schema;
retain the operation's currentness, deadline, SQL/probe bounds and Time Travel
bookmark. Only successful live ledger and after-schema readback accepts the
operation. A prior four-migration intent cannot authorize the new suffix.

## Evidence and limits

A bounded primary D1 read observed no semantic revision row before preparation.
That observation motivates this narrow repair and does not replace its SQL
precondition or the executor's fresh schema checks. Private account receipts
remain outside the repository.

This decision repairs configuration persistence only. It grants no model,
billing, search qualification, backup restore or product release authority.
The D1 pattern limit is documented in the
[official limits](https://developers.cloudflare.com/d1/platform/limits/).
