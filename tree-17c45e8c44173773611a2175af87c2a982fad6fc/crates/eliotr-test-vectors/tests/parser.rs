use eliotr_test_vectors::{
    MAX_VECTOR_CASE_ID_BYTES, MAX_VECTOR_CASES, MAX_VECTOR_FRAME_BYTES, MAX_VECTOR_MAX_BYTES,
    MAX_VECTOR_PAYLOAD_BYTES, VECTOR_SCHEMA_GENERATION, VectorParseErrorKind, parse_vector_set,
};

const VALID: &str = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
case_one|1|61|ok|61|-
";

#[test]
fn parses_the_canonical_frame_and_exposes_typed_fields() {
    let result = parse_vector_set(VALID);
    assert!(matches!(
        result,
        Ok(set)
            if set.schema_generation() == VECTOR_SCHEMA_GENERATION
                && set.cases().len() == 1
                && set.cases()[0].case_id() == "case_one"
                && set.cases()[0].max_bytes() == 1
                && set.cases()[0].input() == b"a"
    ));
}

#[test]
fn rejects_an_oversized_frame_before_line_parsing() {
    let input = "x".repeat(MAX_VECTOR_FRAME_BYTES + 1);
    assert!(matches!(
        parse_vector_set(&input),
        Err(error)
            if error.line() == 0
                && matches!(
                    error.kind(),
                    VectorParseErrorKind::FrameTooLarge {
                        actual_bytes,
                        max_bytes,
                    } if *actual_bytes == MAX_VECTOR_FRAME_BYTES + 1
                        && *max_bytes == MAX_VECTOR_FRAME_BYTES
                )
    ));
}

#[test]
fn rejects_unknown_or_missing_headers() {
    let unknown = VALID.replacen(
        "eliotr.test-vectors.canonical-utf8.v1",
        "eliotr.test-vectors.unknown.v1",
        1,
    );
    assert!(matches!(
        parse_vector_set(&unknown),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::UnexpectedHeader { .. }
            )
    ));

    let missing = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
";
    assert!(matches!(
        parse_vector_set(missing),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::MissingHeader { .. })
    ));
}

#[test]
fn rejects_blank_lines_and_late_headers() {
    let blank = VALID.replace("case_one", "\ncase_one");
    assert!(matches!(
        parse_vector_set(&blank),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::UnexpectedBlankLine)
    ));

    let late_header = VALID.replace("case_one|1|61|ok|61|-", "# extra=true");
    assert!(matches!(
        parse_vector_set(&late_header),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::UnexpectedHeader {
                    expected: "a case row"
                }
            )
    ));
}

#[test]
fn rejects_more_than_the_bounded_case_count() {
    let mut input = String::from(
        "# protocol=eliotr.test-vectors.canonical-utf8.v1\n\
# schema_generation=1\n\
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code\n",
    );
    for index in 0..=MAX_VECTOR_CASES {
        input.push_str(&format!("case_{index}|1|61|ok|61|-\n"));
    }
    assert!(input.len() < MAX_VECTOR_FRAME_BYTES);
    assert!(matches!(
        parse_vector_set(&input),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::TooManyCases { max_cases }
                    if *max_cases == MAX_VECTOR_CASES
            )
    ));
}

#[test]
fn rejects_wrong_column_count() {
    let input = VALID.replace("|-\n", "|-|extra\n");
    assert!(matches!(
        parse_vector_set(&input),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::WrongColumnCount { actual: 7 }
            )
    ));
}

#[test]
fn rejects_long_invalid_and_duplicate_case_ids() {
    let long_id = format!("{}|1|61|ok|61|-", "a".repeat(MAX_VECTOR_CASE_ID_BYTES + 1));
    let too_long = VALID.replace("case_one|1|61|ok|61|-", &long_id);
    assert!(matches!(
        parse_vector_set(&too_long),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::CaseIdTooLong { .. })
    ));

    for invalid_id in ["", "Case-One", "case-one"] {
        let invalid = VALID.replace("case_one", invalid_id);
        assert!(matches!(
            parse_vector_set(&invalid),
            Err(error)
                if matches!(error.kind(), VectorParseErrorKind::InvalidCaseId)
        ));
    }

    let duplicate = format!("{VALID}case_one|1|62|ok|62|-\n");
    assert!(matches!(
        parse_vector_set(&duplicate),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::DuplicateCaseId)
    ));
}

#[test]
fn rejects_invalid_noncanonical_and_out_of_range_limits() {
    let overflow = (u64::from(MAX_VECTOR_MAX_BYTES) + 1).to_string();
    for invalid in ["", "x", "-1", &overflow] {
        let input = VALID.replace("|1|61|", &format!("|{invalid}|61|"));
        assert!(matches!(
            parse_vector_set(&input),
            Err(error)
                if matches!(error.kind(), VectorParseErrorKind::InvalidMaxBytes)
        ));
    }

    let leading_zero = VALID.replace("|1|61|", "|01|61|");
    assert!(matches!(
        parse_vector_set(&leading_zero),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::NonCanonicalMaxBytes
            )
    ));

    let maximum = VALID.replace("|1|61|", &format!("|{MAX_VECTOR_MAX_BYTES}|61|"));
    assert!(parse_vector_set(&maximum).is_ok());
}

#[test]
fn rejects_malformed_hex_without_decoding() {
    for value in ["", "a", "0A", "g0", "0g"] {
        let input = VALID.replace("|61|ok|", &format!("|{value}|ok|"));
        assert!(matches!(
            parse_vector_set(&input),
            Err(error)
                if matches!(
                    error.kind(),
                    VectorParseErrorKind::InvalidHex {
                        field: "input_hex"
                    }
                )
        ));
    }
}

#[test]
fn rejects_oversized_decoded_payloads_before_allocation() {
    let oversized_hex = "00".repeat(MAX_VECTOR_PAYLOAD_BYTES + 1);
    let input_case = VALID.replace("|61|ok|61|-", &format!("|{oversized_hex}|ok|-|-"));
    assert!(matches!(
        parse_vector_set(&input_case),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::PayloadTooLarge {
                    field: "input_hex",
                    actual_bytes,
                    max_bytes,
                } if *actual_bytes == MAX_VECTOR_PAYLOAD_BYTES + 1
                    && *max_bytes == MAX_VECTOR_PAYLOAD_BYTES
            )
    ));

    let output_case = VALID.replace("|ok|61|-", &format!("|ok|{oversized_hex}|-"));
    assert!(matches!(
        parse_vector_set(&output_case),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::PayloadTooLarge {
                    field: "output_hex",
                    ..
                }
            )
    ));
}

#[test]
fn rejects_unknown_outcomes_and_error_codes() {
    let unknown_outcome = VALID.replace("|ok|61|-", "|maybe|61|-");
    assert!(matches!(
        parse_vector_set(&unknown_outcome),
        Err(error)
            if matches!(
                error.kind(),
                VectorParseErrorKind::InvalidExpectedOutcome
            )
    ));

    let unknown_code = VALID.replace("|ok|61|-", "|error|-|ELIOTR_UNKNOWN");
    assert!(matches!(
        parse_vector_set(&unknown_code),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::UnknownErrorCode)
    ));
}

#[test]
fn rejects_inconsistent_outcome_columns() {
    let success_with_error = VALID.replace("|ok|61|-", "|ok|61|ELIOTR_UTF8_INVALID");
    assert!(matches!(
        parse_vector_set(&success_with_error),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::InconsistentOutcome)
    ));

    let error_with_output = VALID.replace("|ok|61|-", "|error|61|ELIOTR_UTF8_INVALID");
    assert!(matches!(
        parse_vector_set(&error_with_output),
        Err(error)
            if matches!(error.kind(), VectorParseErrorKind::InconsistentOutcome)
    ));
}

#[test]
fn rejects_a_frame_without_cases_and_formats_bounded_errors() {
    let input = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
";
    let result = parse_vector_set(input);
    assert!(matches!(
        result,
        Err(ref error) if matches!(error.kind(), VectorParseErrorKind::NoCases)
    ));
    assert!(matches!(result, Err(error) if error.to_string().contains("line 4")));
}
