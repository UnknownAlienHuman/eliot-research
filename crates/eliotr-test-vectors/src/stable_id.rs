//! Strict M2 stable-ID vectors shared by TypeScript, native Rust and Rust/Wasm.

#![forbid(unsafe_code)]

mod evaluator;
mod model;
mod parser;

pub use evaluator::{
    StableIdVerificationError, verify_embedded_stable_id_vectors, verify_stable_id_vector_set,
};
pub use model::{
    STABLE_ID_COLUMNS_HEADER, STABLE_ID_PROTOCOL, STABLE_ID_PROTOCOL_HEADER,
    STABLE_ID_SCHEMA_GENERATION, StableIdExpectedError, StableIdExpectedOutcome, StableIdOperation,
    StableIdVector, StableIdVectorSet,
};
pub use parser::{StableIdParseError, StableIdParseErrorKind, parse_stable_id_vector_set};

/// Exact committed product-neutral `stable-id.v1` fixture bytes.
pub const EMBEDDED_STABLE_ID_VECTORS: &str = include_str!("../fixtures/stable-id.v1.txt");

/// Exact committed ingest and projection identity-family fixture bytes.
pub const EMBEDDED_INGEST_IDENTITY_VECTORS: &str =
    include_str!("../fixtures/ingest-identities.v1.txt");

/// Parses and executes the ingest identity corpus with the generic stable-ID kernel.
///
/// # Errors
///
/// Returns the first strict parse or byte-for-byte semantic mismatch.
pub fn verify_embedded_ingest_identity_vectors() -> Result<(), StableIdVerificationError> {
    let vectors = parse_stable_id_vector_set(EMBEDDED_INGEST_IDENTITY_VECTORS)?;
    verify_stable_id_vector_set(&vectors)
}

#[cfg(test)]
mod tests {
    use super::verify_embedded_ingest_identity_vectors;

    #[test]
    fn ingest_identity_vectors_pass_natively() {
        assert_eq!(verify_embedded_ingest_identity_vectors(), Ok(()));
    }
}
