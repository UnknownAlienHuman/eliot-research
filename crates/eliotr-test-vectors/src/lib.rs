//! Strict shared conformance vectors for the Eliot Research Rust migration.
//!
//! Every fixture is dependency-free and line-oriented so the same committed bytes can be evaluated by
//! TypeScript, native Rust, and the compiled Rust/Wasm self-test.

#![forbid(unsafe_code)]

mod canonical_body;
mod evaluator;
mod model;
mod parser;
mod stable_id;

pub use canonical_body::*;
pub use evaluator::{VectorVerificationError, verify_embedded_vectors, verify_vector_set};
pub use model::{
    CanonicalUtf8Vector, ExpectedError, ExpectedOutcome, MAX_VECTOR_CASE_ID_BYTES,
    MAX_VECTOR_CASES, MAX_VECTOR_FRAME_BYTES, MAX_VECTOR_MAX_BYTES, MAX_VECTOR_PAYLOAD_BYTES,
    VECTOR_PROTOCOL, VECTOR_SCHEMA_GENERATION, VectorSet,
};
pub use parser::{VectorParseError, VectorParseErrorKind, parse_vector_set};
pub use stable_id::*;

/// Exact committed M1 fixture bytes embedded into native Rust and Rust/Wasm builds.
pub const EMBEDDED_CANONICAL_UTF8_VECTORS: &str = include_str!("../fixtures/canonical-utf8.v1.txt");
