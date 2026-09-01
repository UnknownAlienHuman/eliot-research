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

/// Exact committed M2 fixture bytes embedded into native Rust and Rust/Wasm builds.
pub const EMBEDDED_CANONICAL_BODY_VECTORS: &str = include_str!("../fixtures/canonical-body.v1.txt");
