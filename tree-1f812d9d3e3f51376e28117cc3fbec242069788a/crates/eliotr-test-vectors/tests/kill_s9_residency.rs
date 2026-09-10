//! ER-40 S9 residency-key canonical-output cluster (issue #106).
//!
//! Through the public API only, absolute `InvalidOutputShape` expectations.
//! Pins `is_canonical_output` `||` -> `&&` (398-402), `is_canonical_component`
//! `-> true`, `<` -> `==`/`>`, `||` -> `&&`, `|` -> `&`/`^`, `<<` -> `>>`.

use eliotr_test_vectors::{
    RESIDENCY_KEY_COLUMNS_HEADER, RESIDENCY_KEY_PROTOCOL_HEADER, ResidencyKeyParseErrorKind,
    parse_residency_key_vector_set,
};

const RESIDENCY_DIGEST_HEX: &str = "30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";

fn residency_frame(row: &str) -> String {
    format!(
        "{RESIDENCY_KEY_PROTOCOL_HEADER}\n# schema_generation=1\n{RESIDENCY_KEY_COLUMNS_HEADER}\n{row}\n"
    )
}

fn output_hex_of(text: &str) -> String {
    let mut hex = String::new();
    for byte in text.as_bytes() {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn assert_invalid_output(output_text: &str) {
    let output_hex = output_hex_of(output_text);
    let row = format!("bad|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|{output_hex}|-");
    assert!(matches!(
        parse_residency_key_vector_set(&residency_frame(&row)),
        Err(error)
            if matches!(
                error.kind(),
                ResidencyKeyParseErrorKind::InvalidOutputShape
            )
    ));
}

#[test]
fn residency_output_wrong_segment_count_rejects() {
    assert_invalid_output("object-residency-key.v1/s/a/c/k/r/e/sha256");
    assert_invalid_output(
        "object-residency-key.v1/s/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/extra",
    );
}

#[test]
fn residency_output_wrong_version_and_algorithm_rejects() {
    assert_invalid_output(
        "object-residency-key.v2/s/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert_invalid_output(
        "object-residency-key.v1/s/a/c/k/r/e/sha512/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
}

#[test]
fn residency_output_empty_segment_and_digest_shape_rejects() {
    assert_invalid_output(
        "object-residency-key.v1//a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert_invalid_output("object-residency-key.v1/s/a/c/k/r/e/sha256/0123456789abcdef");
    assert_invalid_output(
        "object-residency-key.v1/s/a/c/k/r/e/sha256/0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
    );
}

#[test]
fn residency_output_noncanonical_component_rejects() {
    assert_invalid_output(
        "object-residency-key.v1/%2fa/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert_invalid_output(
        "object-residency-key.v1/%41/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert_invalid_output(
        "object-residency-key.v1/%2G/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert_invalid_output(
        "object-residency-key.v1/%/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
}

#[test]
fn residency_output_component_escape_boundaries_reject() {
    assert_invalid_output(
        "object-residency-key.v1/s%2/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    let canonical = "object-residency-key.v1/%20/a/c/k/r/e/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let output_hex = output_hex_of(canonical);
    let row = format!("good|73|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|ok|{output_hex}|-");
    assert!(parse_residency_key_vector_set(&residency_frame(&row)).is_ok());
}

#[test]
fn residency_field_too_large_rejects_with_exact_budget() {
    let oversized_hex = "00".repeat(1024 + 1);
    assert_eq!(oversized_hex.len(), 2050);
    let row = format!(
        "big|{oversized_hex}|61|63|6b|72|65|{RESIDENCY_DIGEST_HEX}|error|-|ELIOTR_RESIDENCY_KEY_IDENTIFIER_TOO_LONG"
    );
    assert!(matches!(
        parse_residency_key_vector_set(&residency_frame(&row)),
        Err(error)
            if matches!(
                error.kind(),
                ResidencyKeyParseErrorKind::FieldTooLarge {
                    actual_bytes: 1025,
                    max_bytes: 1024,
                    ..
                }
            ) && error.line() == 4
    ));
}
