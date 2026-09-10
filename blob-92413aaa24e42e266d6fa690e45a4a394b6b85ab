use eliotr_test_vectors::{
    EMBEDDED_OWNER_TOKEN_VECTORS, OWNER_TOKEN_COLUMNS_HEADER, OWNER_TOKEN_PROTOCOL_HEADER,
    OWNER_TOKEN_SCHEMA_GENERATION, OwnerTokenOperation, OwnerTokenParseErrorKind,
    parse_owner_token_vector_set, verify_embedded_owner_token_vectors,
};

fn frame(row: &str) -> String {
    format!(
        "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{row}\n"
    )
}

fn assert_kind(source: &str, expected: OwnerTokenParseErrorKind) {
    let result = parse_owner_token_vector_set(source);
    assert!(matches!(result, Err(error) if error.kind() == &expected));
}

fn find_output(case_id: &str) -> Option<Vec<u8>> {
    let set = parse_owner_token_vector_set(EMBEDDED_OWNER_TOKEN_VECTORS).ok()?;
    for case in set.cases() {
        if case.case_id() == case_id {
            let eliotr_test_vectors::OwnerTokenExpectedOutcome::Success { output } =
                case.expected()
            else {
                return None;
            };
            return Some(output.clone());
        }
    }
    None
}

#[test]
fn parses_and_executes_the_embedded_corpus() {
    let parsed = parse_owner_token_vector_set(EMBEDDED_OWNER_TOKEN_VECTORS);
    assert!(parsed.is_ok());
    let Ok(vectors) = parsed else {
        return;
    };
    assert_eq!(vectors.schema_generation(), OWNER_TOKEN_SCHEMA_GENERATION);
    assert!(vectors.cases().len() >= 50);
    assert!(
        vectors
            .cases()
            .iter()
            .any(|case| case.operation() == OwnerTokenOperation::DeriveOwnerToken)
    );
    assert!(
        vectors
            .cases()
            .iter()
            .any(|case| case.operation() == OwnerTokenOperation::ValidateOwnerToken)
    );
    assert_eq!(verify_embedded_owner_token_vectors(), Ok(()));
}

#[test]
fn changed_identity_changes_the_token_while_canonical_forms_agree() {
    let (
        Some(canonical),
        Some(changed_ns),
        Some(changed_inc),
        Some(whitespace),
        Some(escaped),
        Some(validated),
    ) = (
        find_output("derive_local_imports"),
        find_output("derive_changed_namespace"),
        find_output("derive_changed_incarnation"),
        find_output("derive_whitespace_tuple"),
        find_output("derive_escaped_incarnation"),
        find_output("validate_token"),
    )
    else {
        return;
    };
    assert!(canonical.starts_with(b"owner-"));
    assert_eq!(canonical.len(), 70);
    assert_ne!(canonical, changed_ns);
    assert_ne!(canonical, changed_inc);
    assert_eq!(canonical, whitespace);
    assert_eq!(canonical, escaped);
    assert_eq!(canonical, validated);
}

#[test]
fn crlf_transport_parses_identically() {
    let crlf = EMBEDDED_OWNER_TOKEN_VECTORS.replace('\n', "\r\n");
    let parsed = parse_owner_token_vector_set(&crlf);
    assert!(parsed.is_ok());
    let (Ok(lf), Ok(crlf)) = (
        parse_owner_token_vector_set(EMBEDDED_OWNER_TOKEN_VECTORS),
        parsed,
    ) else {
        return;
    };
    assert_eq!(lf.cases().len(), crlf.cases().len());
    assert_eq!(
        eliotr_test_vectors::verify_owner_token_vector_set(&crlf),
        Ok(())
    );
}

#[test]
fn rejects_frame_and_header_failures() {
    let oversized = "x".repeat(1024 * 1024 + 1);
    assert_kind(
        &oversized,
        OwnerTokenParseErrorKind::FrameTooLarge {
            actual_bytes: oversized.len(),
            max_bytes: 1024 * 1024,
        },
    );
    assert_kind(
        "",
        OwnerTokenParseErrorKind::MissingHeader {
            expected: OWNER_TOKEN_PROTOCOL_HEADER,
        },
    );
    assert_kind(
        &frame("case|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE").replacen(
            "owner-token.v1",
            "unknown.v1",
            1,
        ),
        OwnerTokenParseErrorKind::UnexpectedHeader {
            expected: OWNER_TOKEN_PROTOCOL_HEADER,
        },
    );
    assert_kind(
        &frame("case|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE").replacen(
            "# schema_generation=1",
            "# schema_generation=2",
            1,
        ),
        OwnerTokenParseErrorKind::UnexpectedHeader {
            expected: "# schema_generation=1",
        },
    );
    assert_kind(
        &format!(
            "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n\ncase|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE\n"
        ),
        OwnerTokenParseErrorKind::UnexpectedBlankLine,
    );
    assert_kind(
        &format!(
            "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n# late=true\n"
        ),
        OwnerTokenParseErrorKind::UnexpectedHeader {
            expected: "a case row",
        },
    );
}

#[test]
fn rejects_case_identity_and_shape_failures() {
    assert_kind(
        &frame("case|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE|extra"),
        OwnerTokenParseErrorKind::WrongColumnCount { actual: 7 },
    );
    let long_id = "a".repeat(129);
    assert_kind(
        &frame(&format!(
            "{long_id}|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE"
        )),
        OwnerTokenParseErrorKind::CaseIdTooLong {
            actual_bytes: 129,
            max_bytes: 128,
        },
    );
    for bad in ["Bad-ID", "__proto__", "_leading", "0case"] {
        assert_kind(
            &frame(&format!(
                "{bad}|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE"
            )),
            OwnerTokenParseErrorKind::InvalidCaseId,
        );
    }
    let duplicate = format!(
        "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\ncase|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE\ncase|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE\n"
    );
    assert_kind(&duplicate, OwnerTokenParseErrorKind::DuplicateCaseId);

    let rows = (0..=4096)
        .map(|index| format!("c{index}|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_kind(
        &format!(
            "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{rows}\n"
        ),
        OwnerTokenParseErrorKind::TooManyCases { max_cases: 4096 },
    );
}

#[test]
fn rejects_operation_hex_and_payload_failures() {
    assert_kind(
        &frame("case|unknown|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE"),
        OwnerTokenParseErrorKind::InvalidOperation,
    );
    for value in ["", "a", "0A", "gg"] {
        assert_kind(
            &frame(&format!(
                "case|derive_owner_token|{value}|error|-|ELIOTR_OWNER_TOKEN_SHAPE"
            )),
            OwnerTokenParseErrorKind::InvalidHex { field: "input_hex" },
        );
    }
    let oversized_hex = "00".repeat(256 * 1024 + 1);
    assert_kind(
        &frame(&format!(
            "case|derive_owner_token|{oversized_hex}|error|-|ELIOTR_OWNER_TOKEN_SHAPE"
        )),
        OwnerTokenParseErrorKind::PayloadTooLarge {
            field: "input_hex",
            actual_bytes: 256 * 1024 + 1,
            max_bytes: 256 * 1024,
        },
    );
}

#[test]
fn rejects_outcome_error_and_output_shape_failures() {
    assert_kind(
        &frame("case|derive_owner_token|5b5d|maybe|-|-"),
        OwnerTokenParseErrorKind::InvalidExpectedOutcome,
    );
    assert_kind(
        &frame("case|derive_owner_token|5b5d|ok|-|ELIOTR_OWNER_TOKEN_SHAPE"),
        OwnerTokenParseErrorKind::InconsistentOutcome,
    );
    assert_kind(
        &frame("case|derive_owner_token|5b5d|error|00|ELIOTR_OWNER_TOKEN_SHAPE"),
        OwnerTokenParseErrorKind::InconsistentOutcome,
    );
    assert_kind(
        &frame("case|derive_owner_token|5b5d|error|-|ELIOTR_UNKNOWN"),
        OwnerTokenParseErrorKind::UnknownErrorCode,
    );
    assert_kind(
        &frame("case|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_PREFIX"),
        OwnerTokenParseErrorKind::IncompatibleError,
    );
    assert_kind(
        &frame("case|validate_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_NAMESPACE"),
        OwnerTokenParseErrorKind::IncompatibleError,
    );
    assert_kind(
        &frame("case|derive_owner_token|5b5d|ok|61|-"),
        OwnerTokenParseErrorKind::InvalidOutputShape,
    );
    assert_kind(
        &frame(
            "case|validate_owner_token|5b5d|ok|6f776e65722d30303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030|-",
        ),
        OwnerTokenParseErrorKind::InvalidOutputShape,
    );
    assert_kind(
        &format!(
            "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n"
        ),
        OwnerTokenParseErrorKind::NoCases,
    );
}

#[test]
fn parse_errors_are_bounded_and_content_free() {
    let result = parse_owner_token_vector_set(&frame("case|unknown|5b5d|error|-|-"));
    let Err(error) = result else {
        return;
    };
    assert_eq!(error.line(), 4);
    let message = error.to_string();
    assert!(message.starts_with("invalid owner-token vector frame"));
    assert!(!message.contains("case|unknown"));
}
