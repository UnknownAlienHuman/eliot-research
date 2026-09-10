//! Strict `scope-snapshot-identity.v1` vectors shared by TypeScript, native Rust and Rust/Wasm.
//!
//! The family binds `scopeSnapshotIdentityPayload`, `scopeSnapshotDigestPayload` and
//! `expectedSnapshotIdentity`: canonical identity bytes, SHA-256, `scope-` stable IDs and
//! snapshot digests, with typed content-free errors. No normalization, resolution,
//! persistence, expiry or D1 logic is ported; TypeScript remains the product authority.
//!
//! The family is split into cohesive internal modules: `model` (typed corpus),
//! `parser` (strict frame parser) and `evaluator` (deterministic execution). This file
//! is the single public family API; no second family is introduced.

#![forbid(unsafe_code)]

mod evaluator;
mod model;
mod parser;

pub use evaluator::{
    ScopeSnapshotIdentityVerificationError, verify_embedded_scope_snapshot_identity_vectors,
    verify_scope_snapshot_identity_vector_set,
};
pub use model::{
    SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER, SCOPE_SNAPSHOT_IDENTITY_PROTOCOL,
    SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER, SCOPE_SNAPSHOT_IDENTITY_SCHEMA_GENERATION,
    ScopeSnapshotIdentityExpectedError, ScopeSnapshotIdentityExpectedOutcome,
    ScopeSnapshotIdentityOperation, ScopeSnapshotIdentityVector, ScopeSnapshotIdentityVectorSet,
};
pub use parser::{
    ScopeSnapshotIdentityParseError, ScopeSnapshotIdentityParseErrorKind,
    parse_scope_snapshot_identity_vector_set,
};

/// Exact committed `scope-snapshot-identity.v1` fixture bytes.
pub const EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS: &str =
    include_str!("../fixtures/scope-snapshot-identity.v1.txt");

#[cfg(test)]
mod tests {
    use super::ScopeSnapshotIdentityOperation;
    use super::verify_embedded_scope_snapshot_identity_vectors;

    #[test]
    fn scope_snapshot_identity_vectors_pass_natively() {
        assert_eq!(verify_embedded_scope_snapshot_identity_vectors(), Ok(()));
    }

    #[test]
    fn operation_tokens_are_stable() {
        assert_eq!(
            ScopeSnapshotIdentityOperation::DeriveSnapshotIdentity.token(),
            "derive_snapshot_identity"
        );
        assert_eq!(
            ScopeSnapshotIdentityOperation::VerifySnapshotIdentity.token(),
            "verify_snapshot_identity"
        );
    }
}
