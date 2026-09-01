//! Strict shared conformance vectors for the Eliot Research Rust migration.
//!
//! The fixture is intentionally dependency-free and line-oriented so the exact same committed bytes
//! can be evaluated by TypeScript, native Rust, and the compiled Rust/Wasm self-test.

#![forbid(unsafe_code)]

mod evaluator;
mod model;
mod parser;

pub use evaluator::{VectorVerificationError, verify_embedded_vectors, verify_vector_set};
pub use model::{
    CanonicalUtf8Vector, ExpectedError, ExpectedOutcome, VECTOR_PROTOCOL, VECTOR_SCHEMA_GENERATION,
    VectorSet,
};
pub use parser::{VectorParseError, VectorParseErrorKind, parse_vector_set};

/// Exact committed M1 fixture bytes embedded into native Rust and Rust/Wasm builds.
pub const EMBEDDED_CANONICAL_UTF8_VECTORS: &str = include_str!("../fixtures/canonical-utf8.v1.txt");
