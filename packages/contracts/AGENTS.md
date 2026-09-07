# Agent ER-01 — contracts

Read `docs/agent-work/ER-01-contracts.md`. Own every public wire shape/closed enum; no platform imports.
Strict schemas fail closed on unknown load-bearing fields. Field changes require protocol/generation bump,
fixture update, compatibility note, and T0/T1 tests.
