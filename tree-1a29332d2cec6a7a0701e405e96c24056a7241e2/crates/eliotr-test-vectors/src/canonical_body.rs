//! Strict M2 canonical-body vectors shared by TypeScript, native Rust and Rust/Wasm.

#![forbid(unsafe_code)]

mod evaluator;
mod model;
mod parser;

pub use evaluator::{
    CanonicalBodyVerificationError, verify_canonical_body_vector_set,
    verify_embedded_canonical_body_vectors,
};
pub use model::{
    CANONICAL_BODY_COLUMNS_HEADER, CANONICAL_BODY_PROTOCOL, CANONICAL_BODY_PROTOCOL_HEADER,
    CANONICAL_BODY_SCHEMA_GENERATION, CanonicalBodyExpectedError, CanonicalBodyExpectedOutcome,
    CanonicalBodyOperation, CanonicalBodyVector, CanonicalBodyVectorSet,
};
pub use parser::{
    CanonicalBodyParseError, CanonicalBodyParseErrorKind, parse_canonical_body_vector_set,
};

/// Exact committed product-neutral M2 fixture bytes.
pub const EMBEDDED_CANONICAL_BODY_VECTORS: &str = include_str!("../fixtures/canonical-body.v1.txt");

/// Exact committed `source.owner-cutover.v1` canonical-body and digest fixture bytes.
pub const EMBEDDED_OWNER_CUTOVER_CANONICAL_VECTORS: &str =
    include_str!("../fixtures/owner-cutover-canonical.v1.txt");

/// Parses and executes the owner-cutover canonical-body corpus with the generic M2 kernel.
///
/// # Errors
///
/// Returns the first strict parse or byte-for-byte semantic mismatch.
pub fn verify_embedded_owner_cutover_canonical_vectors()
-> Result<(), CanonicalBodyVerificationError> {
    let vectors = parse_canonical_body_vector_set(EMBEDDED_OWNER_CUTOVER_CANONICAL_VECTORS)?;
    verify_canonical_body_vector_set(&vectors)
}

#[cfg(test)]
mod tests {
    use super::verify_embedded_owner_cutover_canonical_vectors;

    #[test]
    fn owner_cutover_canonical_vectors_pass_natively() {
        assert_eq!(verify_embedded_owner_cutover_canonical_vectors(), Ok(()));
    }
}
