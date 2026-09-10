//! Cross-cutting integration tests for `scope-snapshot-identity.v1`.
//!
//! Thin single surface for the family: cohesive modules live in
//! `tests/scope_snapshot_identity/` (`common`, `derive`, `timestamps`,
//! `boundaries`, `vectors`) so every file stays below 600 physical lines.
//! All named positive/negative/boundary/differential cases are retained;
//! no second family is introduced. TypeScript remains the authority;
//! this family is `IMPLEMENTED_NOT_LIVE`.

#![forbid(unsafe_code)]

#[path = "scope_snapshot_identity/boundaries.rs"]
mod boundaries;
#[path = "scope_snapshot_identity/common.rs"]
mod common;
#[path = "scope_snapshot_identity/derive.rs"]
mod derive;
#[path = "scope_snapshot_identity/timestamps.rs"]
mod timestamps;
#[path = "scope_snapshot_identity/vectors.rs"]
mod vectors;
