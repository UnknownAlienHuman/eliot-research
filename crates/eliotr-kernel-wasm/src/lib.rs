//! Portable shell for the Eliot Research deterministic kernel.
//!
//! The default build exposes no product ABI. The optional `m1-self-test-export` feature retains the M1
//! verifier and adds CI-only M2 canonical-body, stable-ID and named-family verifiers. None is a product
//! operation or an authority cutover.

/// Executes every embedded migration vector family.
#[must_use]
pub fn embedded_vectors_pass() -> bool {
    eliotr_test_vectors::verify_embedded_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_canonical_body_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_stable_id_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_owner_cutover_canonical_vectors().is_ok()
}

/// CI-only scalar M1 UTF-8 vector export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m1_verify_embedded_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_vectors().is_ok())
}

/// CI-only scalar M2 canonical-body vector export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_canonical_body_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_canonical_body_vectors().is_ok())
}

/// CI-only scalar M2 stable-ID vector export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_stable_id_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_stable_id_vectors().is_ok())
}

/// CI-only scalar M2 owner-cutover canonical-family export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_owner_cutover_canonical_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_owner_cutover_canonical_vectors().is_ok())
}

#[cfg(test)]
mod tests {
    use super::embedded_vectors_pass;

    #[test]
    fn every_embedded_vector_family_passes_natively() {
        assert!(embedded_vectors_pass());
    }
}
