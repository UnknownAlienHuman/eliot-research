//! Portable shell for the Eliot Research deterministic kernel.
//!
//! Migration phase M1 proves that the shared committed fixture bytes compile and execute natively and
//! as `wasm32-unknown-unknown`. Product ABI exports remain absent until the versioned M5 ABI packet.
//!
//! The optional `m1-self-test-export` feature adds one CI-only scalar export. Rust 2024 requires the
//! `no_mangle` attribute to be acknowledged as unsafe; no unsafe block or memory access is used here.
//! Pure authority crates remain `#![forbid(unsafe_code)]`.

/// Executes the exact embedded M1 fixture corpus.
#[must_use]
pub fn embedded_vectors_pass() -> bool {
    eliotr_test_vectors::verify_embedded_vectors().is_ok()
}

/// CI-only scalar self-test export.
///
/// This export is not part of the Eliot Research product ABI and is compiled only by the M1
/// differential gate.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m1_verify_embedded_vectors_v1() -> u32 {
    u32::from(embedded_vectors_pass())
}

#[cfg(test)]
mod tests {
    use super::embedded_vectors_pass;

    #[test]
    fn embedded_vectors_pass_natively() {
        assert!(embedded_vectors_pass());
    }
}
