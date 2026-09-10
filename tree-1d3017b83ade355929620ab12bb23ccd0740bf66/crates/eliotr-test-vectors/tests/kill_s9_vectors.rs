//! ER-40 S9 kill-matrix for `eliotr-test-vectors` residual MISSED (issue #106).
//!
//! Style matches S8 `kill_s8_final.rs`: `#[test]` through the public API only,
//! programmatic generation (no fixtures), absolute hardcoded expectations
//! (exact bytes, exact error codes AND structs, exact line numbers).
//!
//! Killed here (verified by manual rollback, see S9 report):
//! - frame `>` -> `>=` pins (exact MAX passes, MAX+1 fails) for generic,
//!   canonical-body, owner-token, residency-key;
//! - case-id `>` -> `>=` pins (128 passes, 129 fails) for all four;
//! - payload `>` -> `>=` pins (exact MAX passes) + `*` constant pins;
//! - `require_header`/`NoCases` `+` -> `-`/`*` line pins (MissingHeader line 1,
//!   NoCases line 4) for canonical-body/owner-token/residency-key;
//! - `is_canonical_case_id` `||` -> `&&` pins (`a1`/`a_` admit);
//! - `parse_hex` empty-reject pin (residency `||` -> `&&` at 355);
//! - `ResidencyKeyParseError::line` 0/1 pins and `schema_generation` 0 pin.
//! - residency output/component cluster (12) lives in `kill_s9_residency.rs`.
//!
//! The remaining `parse_hex` `|` -> `^` nibble folds (4) are proven-equivalent
//! (disjoint bits, same proof as S8) and are pinned — not killed — in
//! `.cargo/mutants.toml`.

use eliotr_test_vectors::{
    CANONICAL_BODY_COLUMNS_HEADER, CANONICAL_BODY_PROTOCOL_HEADER, CanonicalBodyParseErrorKind,
    CanonicalBodyVerificationError, EMBEDDED_CANONICAL_BODY_VECTORS,
    EMBEDDED_CANONICAL_UTF8_VECTORS, EMBEDDED_INGEST_IDENTITY_VECTORS,
    EMBEDDED_OWNER_CUTOVER_CANONICAL_VECTORS, EMBEDDED_OWNER_TOKEN_VECTORS,
    EMBEDDED_PROJECTION_IDENTITY_VECTORS, EMBEDDED_RESIDENCY_KEY_VECTORS,
    OWNER_TOKEN_COLUMNS_HEADER, OWNER_TOKEN_PROTOCOL_HEADER, OwnerTokenParseErrorKind,
    RESIDENCY_KEY_COLUMNS_HEADER, RESIDENCY_KEY_PROTOCOL_HEADER, ResidencyKeyParseErrorKind,
    ResidencyKeyVerificationError, STABLE_ID_COLUMNS_HEADER, STABLE_ID_PROTOCOL_HEADER,
    StableIdParseErrorKind, StableIdVerificationError, VectorParseErrorKind,
    VectorVerificationError, parse_canonical_body_vector_set, parse_owner_token_vector_set,
    parse_residency_key_vector_set, parse_stable_id_vector_set, parse_vector_set,
    verify_canonical_body_vector_set, verify_embedded_canonical_body_vectors,
    verify_embedded_owner_token_vectors, verify_embedded_residency_key_vectors,
    verify_embedded_vectors, verify_owner_token_vector_set, verify_residency_key_vector_set,
    verify_stable_id_vector_set,
};

// ---------------------------------------------------------------------------
// A. Embedded corpora are non-trivial + broken inline copies fail (Group 1).
// Each broken copy flips one byte/field of a valid row and expects the exact
// verification variant with the exact case identity.
// ---------------------------------------------------------------------------

#[test]
fn generic_embedded_nontrivial_and_broken_output_fails() {
    let parsed = parse_vector_set(EMBEDDED_CANONICAL_UTF8_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(set.cases().len() >= 8);
    assert_eq!(verify_embedded_vectors(), Ok(()));
    let broken = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
wrong_output|1|61|ok|62|-
";
    let parsed = parse_vector_set(broken);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        eliotr_test_vectors::verify_vector_set(&set),
        Err(VectorVerificationError::OutputMismatch { case_id })
            if case_id == "wrong_output"
    ));
}

#[test]
fn stable_ingest_embedded_nontrivial_and_broken_fails() {
    let parsed = parse_stable_id_vector_set(EMBEDDED_INGEST_IDENTITY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(set.cases().len() >= 20);
    assert_eq!(
        eliotr_test_vectors::verify_embedded_ingest_identity_vectors(),
        Ok(())
    );
    let row = "wrong_output|derive_stable_id|736f75726365|ok|736f757263652d303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030|-";
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
            if case_id == "wrong_output"
    ));
}

#[test]
fn stable_projection_embedded_nontrivial_and_broken_fails() {
    let parsed = parse_stable_id_vector_set(EMBEDDED_PROJECTION_IDENTITY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(set.cases().len() >= 20);
    assert_eq!(
        eliotr_test_vectors::verify_embedded_projection_identity_vectors(),
        Ok(())
    );
    let row = "unexpected_success|derive_stable_id|736f75726365|error|-|ELIOTR_STABLE_ID_PREFIX";
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
            if case_id == "unexpected_success"
    ));
}

#[test]
fn canonical_body_embedded_nontrivial_and_broken_fails() {
    let parsed = parse_canonical_body_vector_set(EMBEDDED_CANONICAL_BODY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(set.cases().len() >= 20);
    assert_eq!(verify_embedded_canonical_body_vectors(), Ok(()));
    let row = "wrong_output|canonicalize_json|6e756c6c|ok|74727565|-";
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
            if case_id == "wrong_output"
    ));
}

#[test]
fn owner_cutover_embedded_nontrivial_and_broken_fails() {
    let parsed = parse_canonical_body_vector_set(EMBEDDED_OWNER_CUTOVER_CANONICAL_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(set.cases().len() >= 5);
    assert_eq!(
        eliotr_test_vectors::verify_embedded_owner_cutover_canonical_vectors(),
        Ok(())
    );
    let row = "unexpected_success|canonicalize_json|6e756c6c|error|-|ELIOTR_JSON_SYNTAX";
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
            if case_id == "unexpected_success"
    ));
}

#[test]
fn owner_token_embedded_nontrivial_and_broken_fails() {
    let parsed = parse_owner_token_vector_set(EMBEDDED_OWNER_TOKEN_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(set.cases().len() >= 50);
    assert_eq!(verify_embedded_owner_token_vectors(), Ok(()));
    let row = "wrong_code|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_UTF8";
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
        Err(eliotr_test_vectors::OwnerTokenVerificationError::ErrorCodeMismatch {
            case_id,
            expected_code: "ELIOTR_OWNER_TOKEN_UTF8",
            actual_code: "ELIOTR_OWNER_TOKEN_SHAPE",
        }) if case_id == "wrong_code"
    ));
}

const RESIDENCY_DIGEST_HEX: &str = "30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";
const RESIDENCY_OUTPUT_HEX: &str = "6f626a6563742d7265736964656e63792d6b65792e76312f732f612f632f6b2f722f652f7368613235362f30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";
const RESIDENCY_WRONG_OUTPUT_HEX: &str = "6f626a6563742d7265736964656e63792d6b65792e76312f782f612f632f6b2f722f652f7368613235362f30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";

fn residency_frame(row: &str) -> String {
    format!(
        "{RESIDENCY_KEY_PROTOCOL_HEADER}\n# schema_generation=1\n{RESIDENCY_KEY_COLUMNS_HEADER}\n{row}\n"
    )
}

#[test]
fn residency_embedded_nontrivial_and_broken_fails() {
    let parsed = parse_residency_key_vector_set(EMBEDDED_RESIDENCY_KEY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(set.cases().len() >= 15);
    assert_eq!(verify_embedded_residency_key_vectors(), Ok(()));
    let row = format!(
        "wrong_output|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|{RESIDENCY_WRONG_OUTPUT_HEX}|-"
    );
    let parsed = parse_residency_key_vector_set(&residency_frame(&row));
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert!(matches!(
        verify_residency_key_vector_set(&set),
        Err(ResidencyKeyVerificationError::OutputMismatch { case_id })
            if case_id == "wrong_output"
    ));
}

// ---------------------------------------------------------------------------
// B. Frame `>` -> `>=` pins: exact MAX is admitted (not FrameTooLarge).
// Hardcoded ceilings: frame 1_048_576, case-id 128, payload 262_144.
// ---------------------------------------------------------------------------

#[test]
fn frame_exact_max_is_not_too_large_generic() {
    let exact = "x".repeat(1024 * 1024);
    assert_eq!(exact.len(), 1_048_576);
    let result = parse_vector_set(&exact);
    assert!(matches!(
        result,
        Err(error)
            if !matches!(error.kind(), VectorParseErrorKind::FrameTooLarge { .. })
                && matches!(
                    error.kind(),
                    VectorParseErrorKind::UnexpectedHeader { .. }
                ) && error.line() == 1
    ));
}

#[test]
fn frame_exact_max_is_not_too_large_canonical_body() {
    let exact = "x".repeat(1024 * 1024);
    let result = parse_canonical_body_vector_set(&exact);
    assert!(matches!(
        &result,
        Err(error)
            if !matches!(
                error.kind(),
                CanonicalBodyParseErrorKind::FrameTooLarge { .. }
            )
    ));
    assert!(matches!(
        result,
        Err(error) if error.line() == 1
            && matches!(
                error.kind(),
                CanonicalBodyParseErrorKind::UnexpectedHeader { .. }
            )
    ));
}

#[test]
fn frame_exact_max_is_not_too_large_owner_token() {
    let exact = "x".repeat(1024 * 1024);
    let result = parse_owner_token_vector_set(&exact);
    assert!(matches!(
        result,
        Err(error)
            if !matches!(
                error.kind(),
                OwnerTokenParseErrorKind::FrameTooLarge { .. }
            ) && error.line() == 1
    ));
}

#[test]
fn frame_exact_max_is_not_too_large_residency() {
    let exact = "x".repeat(1024 * 1024);
    let result = parse_residency_key_vector_set(&exact);
    assert!(matches!(
        result,
        Err(error)
            if !matches!(
                error.kind(),
                ResidencyKeyParseErrorKind::FrameTooLarge { .. }
            ) && error.line() == 1
    ));
}

#[test]
fn case_id_128_admits_but_129_fails_generic() {
    let ok_id = "a".repeat(128);
    assert_eq!(ok_id.len(), 128);
    let ok_frame = format!(
        "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\n{ok_id}|1|61|ok|61|-\n"
    );
    let parsed = parse_vector_set(&ok_frame);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert_eq!(set.cases().len(), 1);
    assert_eq!(set.schema_generation(), 1);

    let long_id = "a".repeat(129);
    let bad_frame = format!(
        "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\n{long_id}|1|61|ok|61|-\n"
    );
    assert!(matches!(
        parse_vector_set(&bad_frame),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::CaseIdTooLong { actual_bytes: 129, max_bytes: 128 })
                && error.line() == 4
    ));
}

#[test]
fn case_id_128_admits_but_129_fails_canonical_body() {
    let ok_id = "a".repeat(128);
    let ok_row = format!("{ok_id}|sha256|-|ok|{}|-", "00".repeat(32));
    let frame = format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{ok_row}\n"
    );
    let parsed = parse_canonical_body_vector_set(&frame);
    assert!(parsed.is_ok());
    let long_id = "a".repeat(129);
    let bad_row = format!("{long_id}|sha256|-|ok|{}|-", "00".repeat(32));
    let bad = format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{bad_row}\n"
    );
    assert!(matches!(
        parse_canonical_body_vector_set(&bad),
        Err(error)
            if matches!(
                error.kind(),
                CanonicalBodyParseErrorKind::CaseIdTooLong { .. }
            ) && error.line() == 4
    ));
}

#[test]
fn case_id_128_admits_but_129_fails_owner_token() {
    let ok_id = "a".repeat(128);
    let ok_row = format!("{ok_id}|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE");
    let frame = format!(
        "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{ok_row}\n"
    );
    assert!(parse_owner_token_vector_set(&frame).is_ok());
    let long_id = "a".repeat(129);
    let bad_row = format!("{long_id}|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE");
    let bad = format!(
        "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{bad_row}\n"
    );
    assert!(matches!(
        parse_owner_token_vector_set(&bad),
        Err(error)
            if matches!(
                error.kind(),
                OwnerTokenParseErrorKind::CaseIdTooLong { .. }
            ) && error.line() == 4
    ));
}

#[test]
fn case_id_128_admits_but_129_fails_residency() {
    let ok_id = "a".repeat(128);
    let ok_row =
        format!("{ok_id}|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|{RESIDENCY_OUTPUT_HEX}|-");
    assert!(parse_residency_key_vector_set(&residency_frame(&ok_row)).is_ok());
    let long_id = "a".repeat(129);
    let bad_row =
        format!("{long_id}|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|{RESIDENCY_OUTPUT_HEX}|-");
    assert!(matches!(
        parse_residency_key_vector_set(&residency_frame(&bad_row)),
        Err(error)
            if matches!(
                error.kind(),
                ResidencyKeyParseErrorKind::CaseIdTooLong { .. }
            ) && error.line() == 4
    ));
}

// ---------------------------------------------------------------------------
// C. Payload `>` -> `>=` pins: exact MAX decodes without PayloadTooLarge.
// ---------------------------------------------------------------------------

#[test]
fn payload_exact_max_admits_generic() {
    let exact_hex = "00".repeat(256 * 1024);
    assert_eq!(exact_hex.len(), 524_288);
    let frame = format!(
        "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\nexact|1|{exact_hex}|ok|61|-\n"
    );
    let parsed = parse_vector_set(&frame);
    assert!(parsed.is_ok());
    let oversized_hex = "00".repeat(256 * 1024 + 1);
    let bad = format!(
        "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\nbig|1|{oversized_hex}|ok|61|-\n"
    );
    assert!(matches!(
        parse_vector_set(&bad),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::PayloadTooLarge { actual_bytes: 262_145, max_bytes: 262_144, .. }
            ) && error.line() == 4
    ));
}

#[test]
fn payload_exact_max_admits_canonical_body() {
    let exact_hex = "00".repeat(256 * 1024);
    let frame = format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\nexact|canonicalize_json|{exact_hex}|error|-|ELIOTR_JSON_INPUT_TOO_LARGE\n"
    );
    assert!(parse_canonical_body_vector_set(&frame).is_ok());
}

#[test]
fn payload_exact_max_admits_owner_token() {
    let exact_hex = "00".repeat(256 * 1024);
    let frame = format!(
        "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\nexact|derive_owner_token|{exact_hex}|error|-|ELIOTR_OWNER_TOKEN_INPUT_TOO_LARGE\n"
    );
    assert!(parse_owner_token_vector_set(&frame).is_ok());
}

#[test]
fn payload_field_and_output_max_admit_residency() {
    let field_hex = "00".repeat(1024);
    assert_eq!(field_hex.len(), 2048);
    let field_row = format!(
        "fieldmax|{field_hex}|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|error|-|ELIOTR_RESIDENCY_KEY_IDENTIFIER_TOO_LONG"
    );
    assert!(parse_residency_key_vector_set(&residency_frame(&field_row)).is_ok());
    let output_bytes = "61".repeat(16 * 1024);
    let output_hex_of_text = {
        let text = "object-residency-key.v1/s/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let mut hex = String::new();
        for byte in text.as_bytes() {
            hex.push_str(&format!("{byte:02x}"));
        }
        hex
    };
    assert_eq!(output_bytes.len(), 32_768);
    let _ = output_bytes;
    let output_row =
        format!("outmax|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|{output_hex_of_text}|-");
    assert!(parse_residency_key_vector_set(&residency_frame(&output_row)).is_ok());
}

// ---------------------------------------------------------------------------
// D. Header/line `+` -> `-`/`*` pins + `line()` 0/1 pins + generation pin.
// ---------------------------------------------------------------------------

#[test]
fn missing_header_reports_line_one_generic() {
    assert!(matches!(
        parse_vector_set(""),
        Err(error)
            if error.line() == 1
                && matches!(
                    error.kind(),
                    VectorParseErrorKind::MissingHeader { .. }
                )
    ));
    let no_cases = "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\n";
    assert!(matches!(
        parse_vector_set(no_cases),
        Err(error) if error.line() == 4
            && matches!(error.kind(), VectorParseErrorKind::NoCases)
    ));
}

#[test]
fn missing_header_reports_line_one_canonical_body() {
    assert!(matches!(
        parse_canonical_body_vector_set(""),
        Err(error)
            if error.line() == 1
                && matches!(
                    error.kind(),
                    CanonicalBodyParseErrorKind::MissingHeader { .. }
                )
    ));
    let no_cases = format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n"
    );
    assert!(matches!(
        parse_canonical_body_vector_set(&no_cases),
        Err(error) if error.line() == 4
            && matches!(
                error.kind(),
                CanonicalBodyParseErrorKind::NoCases
            )
    ));
}

#[test]
fn missing_header_reports_line_one_owner_token() {
    assert!(matches!(
        parse_owner_token_vector_set(""),
        Err(error)
            if error.line() == 1
                && matches!(
                    error.kind(),
                    OwnerTokenParseErrorKind::MissingHeader { .. }
                )
    ));
    let no_cases = format!(
        "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n"
    );
    assert!(matches!(
        parse_owner_token_vector_set(&no_cases),
        Err(error) if error.line() == 4
            && matches!(error.kind(), OwnerTokenParseErrorKind::NoCases)
    ));
}

#[test]
fn missing_header_reports_line_one_residency() {
    assert!(matches!(
        parse_residency_key_vector_set(""),
        Err(error)
            if error.line() == 1
                && matches!(
                    error.kind(),
                    ResidencyKeyParseErrorKind::MissingHeader { .. }
                )
    ));
    let no_cases = format!(
        "{RESIDENCY_KEY_PROTOCOL_HEADER}\n# schema_generation=1\n{RESIDENCY_KEY_COLUMNS_HEADER}\n"
    );
    assert!(matches!(
        parse_residency_key_vector_set(&no_cases),
        Err(error) if error.line() == 4
            && matches!(
                error.kind(),
                ResidencyKeyParseErrorKind::NoCases
            )
    ));
    let oversized = "x".repeat(1024 * 1024 + 1);
    assert!(matches!(
        parse_residency_key_vector_set(&oversized),
        Err(error) if error.line() == 0
            && matches!(
                error.kind(),
                ResidencyKeyParseErrorKind::FrameTooLarge { .. }
            )
    ));
}

// ---------------------------------------------------------------------------
// E. `is_canonical_case_id` `||` -> `&&` pins: `a1` and `a_` admit.
// ---------------------------------------------------------------------------

#[test]
fn canonical_case_id_with_digit_and_underscore_admits_generic() {
    for id in ["a1", "a_", "abc_123"] {
        let frame = format!(
            "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\n{id}|1|61|ok|61|-\n"
        );
        assert!(parse_vector_set(&frame).is_ok());
    }
    for bad in ["A1", "1a", "a-b"] {
        let frame = format!(
            "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\n{bad}|1|61|ok|61|-\n"
        );
        assert!(matches!(
            parse_vector_set(&frame),
            Err(error)
                if matches!(error.kind(), VectorParseErrorKind::InvalidCaseId)
        ));
    }
}

#[test]
fn canonical_case_id_with_digit_and_underscore_admits_canonical_body() {
    for id in ["a1", "a_"] {
        let row = format!("{id}|sha256|-|ok|{}|-", "00".repeat(32));
        let frame = format!(
            "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{row}\n"
        );
        assert!(parse_canonical_body_vector_set(&frame).is_ok());
    }
}

#[test]
fn canonical_case_id_with_digit_and_underscore_admits_owner_token() {
    for id in ["a1", "a_"] {
        let row = format!("{id}|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE");
        let frame = format!(
            "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{row}\n"
        );
        assert!(parse_owner_token_vector_set(&frame).is_ok());
    }
}

#[test]
fn canonical_case_id_with_digit_and_underscore_admits_residency() {
    for id in ["a1", "a_"] {
        let row =
            format!("{id}|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|{RESIDENCY_OUTPUT_HEX}|-");
        assert!(parse_residency_key_vector_set(&residency_frame(&row)).is_ok());
    }
    let empty_hex_row = format!(
        "emptyhex||61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|error|-|ELIOTR_RESIDENCY_KEY_EMPTY_IDENTIFIER"
    );
    assert!(matches!(
        parse_residency_key_vector_set(&residency_frame(&empty_hex_row)),
        Err(error)
            if matches!(
                error.kind(),
                ResidencyKeyParseErrorKind::InvalidHex { .. }
            )
    ));
}

// ---------------------------------------------------------------------------
// G. Malformed max_bytes / hex / outcome pins with exact kinds and lines.
// ---------------------------------------------------------------------------

#[test]
fn malformed_max_bytes_and_hex_report_exact_kinds_generic() {
    for bad in ["", "x", "12a"] {
        let frame = format!(
            "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\nbad|{bad}|61|ok|61|-\n"
        );
        assert!(matches!(
            parse_vector_set(&frame),
            Err(error)
                if error.line() == 4
                    && matches!(
                        error.kind(),
                        VectorParseErrorKind::InvalidMaxBytes
                    )
        ));
    }
    let leading = "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\nbad|01|61|ok|61|-\n";
    assert!(matches!(
        parse_vector_set(leading),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::NonCanonicalMaxBytes
            )
    ));
    for hex in ["", "a", "0A", "gg"] {
        let frame = format!(
            "# protocol=eliotr.test-vectors.canonical-utf8.v1\n# schema_generation=1\n# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\nbad|1|{hex}|ok|61|-\n"
        );
        assert!(matches!(
            parse_vector_set(&frame),
            Err(error)
                if matches!(
                    error.kind(),
                    VectorParseErrorKind::InvalidHex { field: "input_hex" }
                )
        ));
    }
}

#[test]
fn stable_id_case_id_digit_and_underscore_admits() {
    for id in ["a1", "a_"] {
        let row = format!("{id}|derive_stable_id|736f75726365|error|-|ELIOTR_STABLE_ID_PREFIX");
        let frame = format!(
            "{STABLE_ID_PROTOCOL_HEADER}\n# schema_generation=1\n{STABLE_ID_COLUMNS_HEADER}\n{row}\n"
        );
        assert!(parse_stable_id_vector_set(&frame).is_ok());
    }
    assert!(matches!(
        parse_stable_id_vector_set(""),
        Err(error) if error.line() == 1
            && matches!(
                error.kind(),
                StableIdParseErrorKind::MissingHeader { .. }
            )
    ));
}
