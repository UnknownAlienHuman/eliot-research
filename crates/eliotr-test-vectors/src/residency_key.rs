//! Strict `object-residency-key.v1` vectors shared by TypeScript, native Rust and Rust/Wasm.

#![forbid(unsafe_code)]

mod evaluator;
mod model;
mod parser;

pub use evaluator::{
    ResidencyKeyVerificationError, verify_embedded_residency_key_vectors,
    verify_residency_key_vector_set,
};
pub use model::{
    RESIDENCY_KEY_COLUMNS_HEADER, RESIDENCY_KEY_PROTOCOL, RESIDENCY_KEY_PROTOCOL_HEADER,
    RESIDENCY_KEY_SCHEMA_GENERATION, ResidencyKeyExpectedError, ResidencyKeyExpectedOutcome,
    ResidencyKeyVector, ResidencyKeyVectorSet,
};
pub use parser::{
    ResidencyKeyParseError, ResidencyKeyParseErrorKind, parse_residency_key_vector_set,
};

/// Exact committed `object-residency-key.v1` fixture bytes.
pub const EMBEDDED_RESIDENCY_KEY_VECTORS: &str = include_str!("../fixtures/residency-key.v1.txt");
