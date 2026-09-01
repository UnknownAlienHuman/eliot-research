use eliotr_test_vectors::{
    CANONICAL_BODY_COLUMNS_HEADER, CANONICAL_BODY_PROTOCOL_HEADER,
    CANONICAL_BODY_SCHEMA_GENERATION, CanonicalBodyOperation, CanonicalBodyParseErrorKind,
    EMBEDDED_CANONICAL_BODY_VECTORS, parse_canonical_body_vector_set,
    verify_embedded_canonical_body_vectors,
};

fn frame(row: &str) -> String {
    format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{row}\n"
    )
}

fn assert_kind(source: &str, expected: CanonicalBodyParseErrorKind) {
    let result = parse_canonical_body_vector_set(source);
    assert!(matches!(result, Err(error) if error.kind() == &expected));
}

#[test]
fn parses_and_executes_the_embedded_corpus() {
    let parsed = parse_canonical_body_vector_set(EMBEDDED_CANONICAL_BODY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(vectors) = parsed else {
        return;
    };
    assert_eq!(
        vectors.schema_generation(),
        CANONICAL_BODY_SCHEMA_GENERATION
    );
    assert!(vectors.cases().len() >= 20);
    assert!(
        vectors
            .cases()
            .iter()
            .any(|case| case.operation() == CanonicalBodyOperation::CanonicalizeJson)
    );
    assert!(
        vectors
            .cases()
            .iter()
            .any(|case| case.operation() == CanonicalBodyOperation::Sha256)
    );
    assert!(
        vectors
            .cases()
            .iter()
            .any(|case| case.operation() == CanonicalBodyOperation::ValidateGeneration)
    );
    assert_eq!(verify_embedded_canonical_body_vectors(), Ok(()));
}

#[test]
fn rejects_frame_and_header_failures() {
    let oversized = "x".repeat(1024 * 1024 + 1);
    assert_kind(
        &oversized,
        CanonicalBodyParseErrorKind::FrameTooLarge {
            actual_bytes: oversized.len(),
            max_bytes: 1024 * 1024,
        },
    );
    assert_kind(
        "",
        CanonicalBodyParseErrorKind::MissingHeader {
            expected: CANONICAL_BODY_PROTOCOL_HEADER,
        },
    );
    assert_kind(
        &frame("case|sha256|-|ok|00|-").replacen("canonical-body.v1", "unknown.v1", 1),
        CanonicalBodyParseErrorKind::UnexpectedHeader {
            expected: CANONICAL_BODY_PROTOCOL_HEADER,
        },
    );
    assert_kind(
        &format!(
            "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n\ncase|sha256|-|ok|{}|-\n",
            "00".repeat(32)
        ),
        CanonicalBodyParseErrorKind::UnexpectedBlankLine,
    );
    assert_kind(
        &format!(
            "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n# late=true\n"
        ),
        CanonicalBodyParseErrorKind::UnexpectedHeader {
            expected: "a case row",
        },
    );
}

#[test]
fn rejects_case_identity_and_shape_failures() {
    assert_kind(
        &frame("case|sha256|-|ok|00|-|extra"),
        CanonicalBodyParseErrorKind::WrongColumnCount { actual: 7 },
    );
    let long_id = "a".repeat(129);
    assert_kind(
        &frame(&format!("{long_id}|sha256|-|ok|{}|-", "00".repeat(32))),
        CanonicalBodyParseErrorKind::CaseIdTooLong {
            actual_bytes: 129,
            max_bytes: 128,
        },
    );
    assert_kind(
        &frame(&format!("Bad-ID|sha256|-|ok|{}|-", "00".repeat(32))),
        CanonicalBodyParseErrorKind::InvalidCaseId,
    );
    let duplicate = format!(
        "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\ncase|sha256|-|ok|{}|-\ncase|sha256|-|ok|{}|-\n",
        "00".repeat(32),
        "00".repeat(32)
    );
    assert_kind(&duplicate, CanonicalBodyParseErrorKind::DuplicateCaseId);

    let rows = (0..=4096)
        .map(|index| format!("c{index}|sha256|-|ok|{}|-", "00".repeat(32)))
        .collect::<Vec<_>>()
        .join("\n");
    assert_kind(
        &format!(
            "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{rows}\n"
        ),
        CanonicalBodyParseErrorKind::TooManyCases { max_cases: 4096 },
    );
}

#[test]
fn rejects_operation_hex_and_payload_failures() {
    assert_kind(
        &frame("case|unknown|-|ok|-|-"),
        CanonicalBodyParseErrorKind::InvalidOperation,
    );
    for value in ["", "a", "0A", "gg"] {
        assert_kind(
            &frame(&format!("case|canonicalize_json|{value}|ok|6e756c6c|-")),
            CanonicalBodyParseErrorKind::InvalidHex { field: "input_hex" },
        );
    }
    let oversized_hex = "00".repeat(256 * 1024 + 1);
    assert_kind(
        &frame(&format!(
            "case|canonicalize_json|{oversized_hex}|ok|6e756c6c|-"
        )),
        CanonicalBodyParseErrorKind::PayloadTooLarge {
            field: "input_hex",
            actual_bytes: 256 * 1024 + 1,
            max_bytes: 256 * 1024,
        },
    );
}

#[test]
fn rejects_outcome_error_and_output_shape_failures() {
    assert_kind(
        &frame("case|canonicalize_json|6e756c6c|maybe|6e756c6c|-"),
        CanonicalBodyParseErrorKind::InvalidExpectedOutcome,
    );
    assert_kind(
        &frame("case|canonicalize_json|6e756c6c|ok|6e756c6c|ELIOTR_JSON_SYNTAX"),
        CanonicalBodyParseErrorKind::InconsistentOutcome,
    );
    assert_kind(
        &frame("case|canonicalize_json|6e756c6c|error|6e756c6c|ELIOTR_JSON_SYNTAX"),
        CanonicalBodyParseErrorKind::InconsistentOutcome,
    );
    assert_kind(
        &frame("case|canonicalize_json|6e756c6c|error|-|ELIOTR_UNKNOWN"),
        CanonicalBodyParseErrorKind::UnknownErrorCode,
    );
    assert_kind(
        &frame("case|sha256|-|error|-|ELIOTR_JSON_SYNTAX"),
        CanonicalBodyParseErrorKind::IncompatibleError,
    );
    assert_kind(
        &frame("case|sha256|-|ok|00|-"),
        CanonicalBodyParseErrorKind::InvalidOutputShape,
    );
    assert_kind(
        &frame("case|validate_generation|-|ok|00|-"),
        CanonicalBodyParseErrorKind::InvalidOutputShape,
    );
    assert_kind(
        &format!(
            "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n"
        ),
        CanonicalBodyParseErrorKind::NoCases,
    );
}

#[test]
fn parse_errors_are_bounded_and_content_free() {
    let result = parse_canonical_body_vector_set(&frame("case|unknown|-|ok|-|-"));
    let Err(error) = result else {
        return;
    };
    assert_eq!(error.line(), 4);
    let message = error.to_string();
    assert!(message.starts_with("invalid canonical-body vector frame"));
    assert!(!message.contains("case|unknown"));
}
