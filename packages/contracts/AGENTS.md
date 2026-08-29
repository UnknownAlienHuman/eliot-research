# Agent ER-01 — contracts

Read `docs/agent-work/ER-01-contracts.md`. This package owns every public wire shape and closed enum.
Do not import platform code. Schemas are strict: unknown load-bearing fields fail closed. Changing a
field requires a protocol/generation bump, fixture update, compatibility note, and T0/T1 tests.
