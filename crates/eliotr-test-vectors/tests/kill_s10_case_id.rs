//! ER-40 S10 `is_canonical_case_id` cluster (issue #106).
//!
//! Through the public API only. Pins the `&&` -> `||` survivor in
//! `is_canonical_case_id` (residency_key/parser.rs:279, canonical_body/parser.rs:242):
//! a case id is canonical only when the first byte is ASCII-lowercase AND every
//! byte is lowercase/digit/underscore. The `||` mutant admits `a!` (bad tail)
//! and `A1` (bad head), so both shapes must be rejected.

use eliotr_test_vectors::{
    CANONICAL_BODY_COLUMNS_HEADER, CANONICAL_BODY_PROTOCOL_HEADER, CanonicalBodyParseErrorKind,
    RESIDENCY_KEY_COLUMNS_HEADER, RESIDENCY_KEY_PROTOCOL_HEADER, ResidencyKeyParseErrorKind,
    parse_canonical_body_vector_set, parse_residency_key_vector_set,
};

const RESIDENCY_DIGEST_HEX: &str = "30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";

fn residency_frame(row: &str) -> String {
    format!(
        "{RESIDENCY_KEY_PROTOCOL_HEADER}\n# schema_generation=1\n{RESIDENCY_KEY_COLUMNS_HEADER}\n{row}\n"
    )
}

fn canonical_body_frame(row: &str) -> String {
    format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{row}\n"
    )
}

#[test]
fn residency_key_rejects_non_canonical_case_id_shapes() {
    // `a!`: canonical head, non-canonical tail. `A1`: non-canonical head,
    // canonical tail. Both must fail closed; the `||` mutant admits both.
    for bad in ["a!", "A1", "A", "a-b", "_lead"] {
        let row = format!("{bad}|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|00|-");
        assert!(
            matches!(
                parse_residency_key_vector_set(&residency_frame(&row)),
                Err(error)
                    if matches!(error.kind(), ResidencyKeyParseErrorKind::InvalidCaseId)
            ),
            "non-canonical case id admitted: {bad}"
        );
    }
}

#[test]
fn canonical_body_rejects_non_canonical_case_id_shapes() {
    for bad in ["a!", "A1", "A", "a-b", "_lead"] {
        let row = format!("{bad}|sha256|61|ok|-|-");
        assert!(
            matches!(
                parse_canonical_body_vector_set(&canonical_body_frame(&row)),
                Err(error)
                    if matches!(error.kind(), CanonicalBodyParseErrorKind::InvalidCaseId)
            ),
            "non-canonical case id admitted: {bad}"
        );
    }
}
