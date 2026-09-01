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
    STABLE_ID_SCHEMA_GENERATION, StableIdExpectedError, StableIdExpectedOutcome,
    StableIdOperation, StableIdVector, StableIdVectorSet,
};
pub use parser::{StableIdParseError, StableIdParseErrorKind, parse_stable_id_vector_set};

/// Exact committed `stable-id.v1` fixture bytes embedded into native Rust and Rust/Wasm builds.
pub const EMBEDDED_STABLE_ID_VECTORS: &str = include_str!("../fixtures/stable-id.v1.txt");
