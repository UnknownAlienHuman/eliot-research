//! Portable shell for the Eliot Research deterministic kernel.
//!
//! The default build exposes no product ABI. The optional `m1-self-test-export` feature retains the M1
//! verifier and adds CI-only M2 canonical-body, stable-ID and named-family verifiers. None is a product
//! operation or an authority cutover.
//!
//! The two version-stamp exports below are always present: they are metadata, not product operations,
//! so a TypeScript consumer can verify ABI compatibility before invoking any future operation.

use eliotr_canonical::{KERNEL_ABI_VERSION_PACKED, KERNEL_SCHEMA_GENERATION};

/// Packed kernel ABI version stamp: `major << 16 | minor << 8 | patch`.
///
/// Always exported (not feature-gated): consumers read it before invoking any operation and
/// fail closed on incompatibility via [`check_envelope`]. The `_v1` suffix names the stamp
/// query protocol, not the ABI version value.
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_kernel_abi_version_v1() -> u32 {
    KERNEL_ABI_VERSION_PACKED
}

/// Kernel schema-generation stamp. Always exported alongside [`eliotr_kernel_abi_version_v1`];
/// the generation must match the consumer's exactly.
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_kernel_schema_generation_v1() -> u32 {
    KERNEL_SCHEMA_GENERATION
}

/// Executes every embedded migration vector family.
#[must_use]
pub fn embedded_vectors_pass() -> bool {
    eliotr_test_vectors::verify_embedded_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_canonical_body_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_stable_id_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_ingest_identity_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_projection_identity_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_owner_cutover_canonical_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_owner_token_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_residency_key_vectors().is_ok()
        && eliotr_test_vectors::verify_embedded_scope_snapshot_identity_vectors().is_ok()
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

/// CI-only scalar M2 ingest identity-family export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_ingest_identity_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_ingest_identity_vectors().is_ok())
}

/// CI-only scalar M2 projection identity-family export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_projection_identity_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_projection_identity_vectors().is_ok())
}

/// CI-only scalar M2 owner-cutover canonical-family export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_owner_cutover_canonical_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_owner_cutover_canonical_vectors().is_ok())
}

/// CI-only scalar M2 owner-token vector export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_owner_token_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_owner_token_vectors().is_ok())
}

/// CI-only scalar M2 object-residency-key vector export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_residency_key_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_residency_key_vectors().is_ok())
}

/// CI-only scalar M2 scope-snapshot-identity vector export.
#[cfg(feature = "m1-self-test-export")]
#[unsafe(no_mangle)]
pub extern "C" fn eliotr_m2_verify_embedded_scope_snapshot_identity_vectors_v1() -> u32 {
    u32::from(eliotr_test_vectors::verify_embedded_scope_snapshot_identity_vectors().is_ok())
}

#[cfg(test)]
mod tests {
    use super::{
        eliotr_kernel_abi_version_v1, eliotr_kernel_schema_generation_v1, embedded_vectors_pass,
    };
    use eliotr_canonical::{
        ABI_VERSION_MALFORMED_CODE, KERNEL_ABI_VERSION, KERNEL_ABI_VERSION_PACKED,
        KERNEL_SCHEMA_GENERATION, check_envelope,
    };

    #[test]
    fn every_embedded_vector_family_passes_natively() {
        assert!(embedded_vectors_pass());
    }

    #[test]
    fn version_stamps_match_the_canonical_constants() {
        assert_eq!(eliotr_kernel_abi_version_v1(), KERNEL_ABI_VERSION_PACKED);
        assert_eq!(
            eliotr_kernel_schema_generation_v1(),
            KERNEL_SCHEMA_GENERATION
        );
    }

    #[test]
    fn envelope_gate_accepts_the_kernel_own_version() {
        assert_eq!(
            check_envelope(KERNEL_ABI_VERSION, KERNEL_SCHEMA_GENERATION),
            Ok(())
        );
    }

    #[test]
    fn envelope_gate_fails_closed_on_malformed_version() {
        let result = check_envelope("1.0", KERNEL_SCHEMA_GENERATION);
        let code = match result {
            Err(failure) => failure.code(),
            Ok(()) => "unexpected-ok",
        };
        assert_eq!(code, ABI_VERSION_MALFORMED_CODE);
    }
}
