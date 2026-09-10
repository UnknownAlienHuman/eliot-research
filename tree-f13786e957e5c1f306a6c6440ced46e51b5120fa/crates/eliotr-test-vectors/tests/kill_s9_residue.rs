//! ER-40 S9 residue for `eliotr-test-vectors` MISSED (issue #106).
//!
//! - 7 `verify_embedded_* -> Ok(())` wrappers: each test pins the underlying
//!   `verify_*_vector_set` logic with an inline one-byte-broken copy expecting
//!   the exact `Err` variant, plus asserts the embedded corpus itself is `Ok`.
//!   Rollback probe (see report): replacing any wrapper with `Ok(())` does NOT
//!   fail these tests, because the wrappers take no input and the committed
//!   fixtures are valid — both original and mutant return `Ok(())`. They are
//!   therefore uncoverable by black-box tests and are excluded as
//!   proven-equivalent (same shape as S8); the tests below document the
//!   underlying semantics.
//! - `schema_generation -> 0` killers: one test asserting `== 1` for every
//!   family (generic, stable-id, canonical-body, owner-token, residency-key).
//!   The `-> 1` twins are tautological (`1 == 1`) and are excluded.

use eliotr_test_vectors::{
    CANONICAL_BODY_COLUMNS_HEADER, CANONICAL_BODY_PROTOCOL_HEADER, CanonicalBodyVerificationError,
    EMBEDDED_CANONICAL_BODY_VECTORS, EMBEDDED_CANONICAL_UTF8_VECTORS,
    EMBEDDED_INGEST_IDENTITY_VECTORS, EMBEDDED_OWNER_CUTOVER_CANONICAL_VECTORS,
    EMBEDDED_OWNER_TOKEN_VECTORS, EMBEDDED_PROJECTION_IDENTITY_VECTORS,
    EMBEDDED_RESIDENCY_KEY_VECTORS, OWNER_TOKEN_COLUMNS_HEADER, OWNER_TOKEN_PROTOCOL_HEADER,
    OwnerTokenVerificationError, RESIDENCY_KEY_COLUMNS_HEADER, RESIDENCY_KEY_PROTOCOL_HEADER,
    ResidencyKeyVerificationError, STABLE_ID_COLUMNS_HEADER, STABLE_ID_PROTOCOL_HEADER,
    StableIdVerificationError, VectorVerificationError, parse_canonical_body_vector_set,
    parse_owner_token_vector_set, parse_residency_key_vector_set, parse_stable_id_vector_set,
    parse_vector_set, verify_canonical_body_vector_set, verify_embedded_canonical_body_vectors,
    verify_embedded_owner_token_vectors, verify_embedded_residency_key_vectors,
    verify_embedded_vectors, verify_owner_token_vector_set, verify_residency_key_vector_set,
    verify_stable_id_vector_set,
};

#[test]
fn s9r_generic_broken_output_fails() {
    assert_eq!(verify_embedded_vectors(), Ok(()));
    let parsed = parse_vector_set(EMBEDDED_CANONICAL_UTF8_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(!set.cases().is_empty());
    let broken = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
s9r_generic_broken|1|61|ok|62|-
";
    let parsed = parse_vector_set(broken);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        eliotr_test_vectors::verify_vector_set(&set),
        Err(VectorVerificationError::OutputMismatch { case_id })
            if case_id == "s9r_generic_broken"
    ));
}

#[test]
fn s9r_ingest_broken_output_fails() {
    assert_eq!(
        eliotr_test_vectors::verify_embedded_ingest_identity_vectors(),
        Ok(())
    );
    let parsed = parse_stable_id_vector_set(EMBEDDED_INGEST_IDENTITY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(!set.cases().is_empty());
    let row = "s9r_ingest_broken|derive_stable_id|736f75726365|ok|736f757263652d303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303031|-";
    let frame = format!(
        "{STABLE_ID_PROTOCOL_HEADER}\n# schema_generation=1\n{STABLE_ID_COLUMNS_HEADER}\n{row}\n"
    );
    let parsed = parse_stable_id_vector_set(&frame);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        verify_stable_id_vector_set(&set),
        Err(StableIdVerificationError::OutputMismatch { case_id })
            if case_id == "s9r_ingest_broken"
    ));
}

#[test]
fn s9r_projection_unexpected_success_fails() {
    assert_eq!(
        eliotr_test_vectors::verify_embedded_projection_identity_vectors(),
        Ok(())
    );
    let parsed = parse_stable_id_vector_set(EMBEDDED_PROJECTION_IDENTITY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(!set.cases().is_empty());
    let row = "s9r_projection_broken|derive_stable_id|736f75726365|error|-|ELIOTR_STABLE_ID_PREFIX";
    let frame = format!(
        "{STABLE_ID_PROTOCOL_HEADER}\n# schema_generation=1\n{STABLE_ID_COLUMNS_HEADER}\n{row}\n"
    );
    let parsed = parse_stable_id_vector_set(&frame);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        verify_stable_id_vector_set(&set),
        Err(StableIdVerificationError::UnexpectedSuccess { case_id })
            if case_id == "s9r_projection_broken"
    ));
}

#[test]
fn s9r_canonical_body_broken_output_fails() {
    assert_eq!(verify_embedded_canonical_body_vectors(), Ok(()));
    let parsed = parse_canonical_body_vector_set(EMBEDDED_CANONICAL_BODY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(!set.cases().is_empty());
    let row = "s9r_canonical_broken|canonicalize_json|6e756c6c|ok|74727565|-";
    let frame = format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{row}\n"
    );
    let parsed = parse_canonical_body_vector_set(&frame);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        verify_canonical_body_vector_set(&set),
        Err(CanonicalBodyVerificationError::OutputMismatch { case_id })
            if case_id == "s9r_canonical_broken"
    ));
}

#[test]
fn s9r_owner_cutover_unexpected_success_fails() {
    assert_eq!(
        eliotr_test_vectors::verify_embedded_owner_cutover_canonical_vectors(),
        Ok(())
    );
    let parsed = parse_canonical_body_vector_set(EMBEDDED_OWNER_CUTOVER_CANONICAL_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(!set.cases().is_empty());
    let row = "s9r_cutover_broken|canonicalize_json|6e756c6c|error|-|ELIOTR_JSON_SYNTAX";
    let frame = format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{row}\n"
    );
    let parsed = parse_canonical_body_vector_set(&frame);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        verify_canonical_body_vector_set(&set),
        Err(CanonicalBodyVerificationError::UnexpectedSuccess { case_id })
            if case_id == "s9r_cutover_broken"
    ));
}

#[test]
fn s9r_owner_token_wrong_code_fails() {
    assert_eq!(verify_embedded_owner_token_vectors(), Ok(()));
    let parsed = parse_owner_token_vector_set(EMBEDDED_OWNER_TOKEN_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(!set.cases().is_empty());
    let row = "s9r_owner_broken|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_UTF8";
    let frame = format!(
        "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{row}\n"
    );
    let parsed = parse_owner_token_vector_set(&frame);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        verify_owner_token_vector_set(&set),
        Err(OwnerTokenVerificationError::ErrorCodeMismatch {
            case_id,
            expected_code: "ELIOTR_OWNER_TOKEN_UTF8",
            actual_code: "ELIOTR_OWNER_TOKEN_SHAPE",
        }) if case_id == "s9r_owner_broken"
    ));
}

const S9R_RESIDENCY_DIGEST_HEX: &str = "30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";
const S9R_RESIDENCY_OUTPUT_HEX: &str = "6f626a6563742d7265736964656e63792d6b65792e76312f732f612f632f6b2f722f652f7368613235362f30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";
const S9R_RESIDENCY_WRONG_HEX: &str = "6f626a6563742d7265736964656e63792d6b65792e76312f782f612f632f6b2f722f652f7368613235362f30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";

fn s9r_residency_frame(row: &str) -> String {
    format!(
        "{RESIDENCY_KEY_PROTOCOL_HEADER}\n# schema_generation=1\n{RESIDENCY_KEY_COLUMNS_HEADER}\n{row}\n"
    )
}

#[test]
fn s9r_residency_broken_output_fails() {
    assert_eq!(verify_embedded_residency_key_vectors(), Ok(()));
    let parsed = parse_residency_key_vector_set(EMBEDDED_RESIDENCY_KEY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(!set.cases().is_empty());
    let row = format!(
        "s9r_residency_broken|73|61|63|6b|72|65|{S9R_RESIDENCY_DIGEST_HEX}|ok|{S9R_RESIDENCY_WRONG_HEX}|-"
    );
    let parsed = parse_residency_key_vector_set(&s9r_residency_frame(&row));
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        verify_residency_key_vector_set(&set),
        Err(ResidencyKeyVerificationError::OutputMismatch { case_id })
            if case_id == "s9r_residency_broken"
    ));
    let _ = S9R_RESIDENCY_OUTPUT_HEX;
}

#[test]
fn s9r_schema_generations_are_one() {
    let generic = parse_vector_set(EMBEDDED_CANONICAL_UTF8_VECTORS);
    assert!(generic.is_ok());
    let Ok(set) = generic else {
        return;
    };
    assert_eq!(set.schema_generation(), 1);

    let ingest = parse_stable_id_vector_set(EMBEDDED_INGEST_IDENTITY_VECTORS);
    assert!(ingest.is_ok());
    let Ok(set) = ingest else {
        return;
    };
    assert_eq!(set.schema_generation(), 1);

    let canonical = parse_canonical_body_vector_set(EMBEDDED_CANONICAL_BODY_VECTORS);
    assert!(canonical.is_ok());
    let Ok(set) = canonical else {
        return;
    };
    assert_eq!(set.schema_generation(), 1);

    let owner = parse_owner_token_vector_set(EMBEDDED_OWNER_TOKEN_VECTORS);
    assert!(owner.is_ok());
    let Ok(set) = owner else {
        return;
    };
    assert_eq!(set.schema_generation(), 1);

    let residency = parse_residency_key_vector_set(EMBEDDED_RESIDENCY_KEY_VECTORS);
    assert!(residency.is_ok());
    let Ok(set) = residency else {
        return;
    };
    assert_eq!(set.schema_generation(), 1);
}
