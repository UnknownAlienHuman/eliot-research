//! Strict M2 owner-token vectors shared by TypeScript, native Rust and Rust/Wasm.

#![forbid(unsafe_code)]

mod evaluator;
mod model;
mod parser;

pub use evaluator::verify_owner_token_vector_set;
pub use evaluator::{OwnerTokenVerificationError, verify_embedded_owner_token_vectors};
pub use model::{
    OWNER_TOKEN_COLUMNS_HEADER, OWNER_TOKEN_PROTOCOL, OWNER_TOKEN_PROTOCOL_HEADER,
    OWNER_TOKEN_SCHEMA_GENERATION, OwnerTokenExpectedError, OwnerTokenExpectedOutcome,
    OwnerTokenOperation, OwnerTokenVector, OwnerTokenVectorSet,
};
pub use parser::{OwnerTokenParseError, OwnerTokenParseErrorKind, parse_owner_token_vector_set};

/// Exact committed `eliotr.source-owner.initial.v1` owner-token fixture bytes.
pub const EMBEDDED_OWNER_TOKEN_VECTORS: &str = include_str!("../fixtures/owner-token.v1.txt");

#[cfg(test)]
mod tests {
    use super::verify_embedded_owner_token_vectors;

    #[test]
    fn owner_token_vectors_pass_natively() {
        assert_eq!(verify_embedded_owner_token_vectors(), Ok(()));
    }
}
