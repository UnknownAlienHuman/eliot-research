//! Strict parser for the dependency-free M1 fixture frame.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::fmt;

use eliotr_canonical::{UTF8_INVALID_CODE, UTF8_TOO_LARGE_CODE};

use crate::model::{
    CanonicalUtf8Vector, ExpectedError, ExpectedOutcome, VECTOR_PROTOCOL, VECTOR_SCHEMA_GENERATION,
    VectorSet,
};

const PROTOCOL_HEADER: &str = "# protocol=eliotr.test-vectors.canonical-utf8.v1";
const GENERATION_HEADER: &str = "# schema_generation=1";
const COLUMNS_HEADER: &str = "# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code";
const COLUMN_COUNT: usize = 6;

/// Exact reason a fixture frame was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VectorParseErrorKind {
    /// A required header was absent.
    MissingHeader {
        /// Exact required header.
        expected: &'static str,
    },
    /// A header was present but unknown or out of order.
    UnexpectedHeader {
        /// Exact required header.
        expected: &'static str,
        /// Observed line.
        actual: String,
    },
    /// A case row did not contain the exact column count.
    WrongColumnCount {
        /// Observed column count.
        actual: usize,
    },
    /// A case identity was empty or outside the canonical ASCII grammar.
    InvalidCaseId,
    /// A case identity appeared more than once.
    DuplicateCaseId,
    /// The byte limit was not an unsigned decimal integer.
    InvalidMaxBytes,
    /// The byte limit used a non-canonical leading zero.
    NonCanonicalMaxBytes,
    /// A byte field was empty, odd-length, uppercase, or non-hexadecimal.
    InvalidHex {
        /// Name of the rejected field.
        field: &'static str,
    },
    /// The expected outcome token was not `ok` or `error`.
    InvalidExpectedOutcome,
    /// Success and error columns contradicted the declared outcome.
    InconsistentOutcome,
    /// An error code was not part of the M1 typed error vocabulary.
    UnknownErrorCode,
    /// The frame contained no cases.
    NoCases,
}

/// Location-bearing strict fixture error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VectorParseError {
    line: usize,
    kind: VectorParseErrorKind,
}

impl VectorParseError {
    fn new(line: usize, kind: VectorParseErrorKind) -> Self {
        Self { line, kind }
    }

    /// Returns the one-based line number associated with the rejection.
    #[must_use]
    pub const fn line(&self) -> usize {
        self.line
    }

    /// Returns the exact rejection kind.
    #[must_use]
    pub const fn kind(&self) -> &VectorParseErrorKind {
        &self.kind
    }
}

impl fmt::Display for VectorParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid Eliot Research vector frame at line {}: {:?}",
            self.line, self.kind
        )
    }
}

impl std::error::Error for VectorParseError {}

/// Parses the strict, versioned M1 vector frame.
///
/// Unknown headers, fields, outcome values, error codes, duplicate identities, and non-canonical
/// integers fail closed.
///
/// # Errors
///
/// Returns [`VectorParseError`] at the first rejected line.
pub fn parse_vector_set(input: &str) -> Result<VectorSet, VectorParseError> {
    let lines: Vec<(usize, &str)> = input
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let one_based = index + 1;
            (!line.is_empty()).then_some((one_based, line))
        })
        .collect();

    require_header(&lines, 0, PROTOCOL_HEADER)?;
    require_header(&lines, 1, GENERATION_HEADER)?;
    require_header(&lines, 2, COLUMNS_HEADER)?;

    let mut case_ids = BTreeSet::new();
    let mut cases = Vec::new();

    for &(line_number, line) in lines.iter().skip(3) {
        if line.starts_with('#') {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::UnexpectedHeader {
                    expected: "a case row",
                    actual: line.to_owned(),
                },
            ));
        }

        let columns: Vec<&str> = line.split('|').collect();
        if columns.len() != COLUMN_COUNT {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::WrongColumnCount {
                    actual: columns.len(),
                },
            ));
        }

        let case_id = columns[0];
        if !is_canonical_case_id(case_id) {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::InvalidCaseId,
            ));
        }
        if !case_ids.insert(case_id.to_owned()) {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::DuplicateCaseId,
            ));
        }

        let max_bytes = parse_max_bytes(columns[1], line_number)?;
        let input_bytes = parse_hex(columns[2], "input_hex", line_number)?;
        let expected = parse_expected(columns[3], columns[4], columns[5], line_number)?;

        cases.push(CanonicalUtf8Vector::new(
            case_id.to_owned(),
            max_bytes,
            input_bytes,
            expected,
        ));
    }

    if cases.is_empty() {
        return Err(VectorParseError::new(
            lines.last().map_or(1, |(line, _)| *line + 1),
            VectorParseErrorKind::NoCases,
        ));
    }

    debug_assert_eq!(
        VECTOR_PROTOCOL,
        PROTOCOL_HEADER.trim_start_matches("# protocol=")
    );

    Ok(VectorSet::new(VECTOR_SCHEMA_GENERATION, cases))
}

fn require_header(
    lines: &[(usize, &str)],
    index: usize,
    expected: &'static str,
) -> Result<(), VectorParseError> {
    let Some(&(line_number, actual)) = lines.get(index) else {
        return Err(VectorParseError::new(
            index + 1,
            VectorParseErrorKind::MissingHeader { expected },
        ));
    };

    if actual != expected {
        return Err(VectorParseError::new(
            line_number,
            VectorParseErrorKind::UnexpectedHeader {
                expected,
                actual: actual.to_owned(),
            },
        ));
    }

    Ok(())
}

fn is_canonical_case_id(case_id: &str) -> bool {
    let mut bytes = case_id.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn parse_max_bytes(value: &str, line: usize) -> Result<usize, VectorParseError> {
    if value.len() > 1 && value.starts_with('0') {
        return Err(VectorParseError::new(
            line,
            VectorParseErrorKind::NonCanonicalMaxBytes,
        ));
    }

    value
        .parse::<usize>()
        .map_err(|_error| VectorParseError::new(line, VectorParseErrorKind::InvalidMaxBytes))
}

fn parse_expected(
    token: &str,
    output_hex: &str,
    error_code: &str,
    line: usize,
) -> Result<ExpectedOutcome, VectorParseError> {
    match token {
        "ok" => {
            if error_code != "-" {
                return Err(VectorParseError::new(
                    line,
                    VectorParseErrorKind::InconsistentOutcome,
                ));
            }
            let output = parse_hex(output_hex, "output_hex", line)?;
            Ok(ExpectedOutcome::Success { output })
        }
        "error" => {
            if output_hex != "-" {
                return Err(VectorParseError::new(
                    line,
                    VectorParseErrorKind::InconsistentOutcome,
                ));
            }
            let expected = match error_code {
                UTF8_TOO_LARGE_CODE => ExpectedError::TooLarge,
                UTF8_INVALID_CODE => ExpectedError::InvalidUtf8,
                _ => {
                    return Err(VectorParseError::new(
                        line,
                        VectorParseErrorKind::UnknownErrorCode,
                    ));
                }
            };
            Ok(ExpectedOutcome::Error(expected))
        }
        _ => Err(VectorParseError::new(
            line,
            VectorParseErrorKind::InvalidExpectedOutcome,
        )),
    }
}

fn parse_hex(value: &str, field: &'static str, line: usize) -> Result<Vec<u8>, VectorParseError> {
    if value == "-" {
        return Ok(Vec::new());
    }
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err(VectorParseError::new(
            line,
            VectorParseErrorKind::InvalidHex { field },
        ));
    }

    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let high = hex_nibble(pair[0]);
        let low = hex_nibble(pair[1]);
        let (Some(high), Some(low)) = (high, low) else {
            return Err(VectorParseError::new(
                line,
                VectorParseErrorKind::InvalidHex { field },
            ));
        };
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{VectorParseErrorKind, parse_vector_set};

    const VALID: &str = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
case_one|1|61|ok|61|-
";

    #[test]
    fn parses_the_canonical_frame() {
        let result = parse_vector_set(VALID);
        assert!(matches!(result, Ok(set) if set.cases().len() == 1));
    }

    #[test]
    fn rejects_unknown_protocol() {
        let input = VALID.replacen(
            "eliotr.test-vectors.canonical-utf8.v1",
            "eliotr.test-vectors.unknown.v1",
            1,
        );
        assert!(matches!(
            parse_vector_set(&input),
            Err(error)
                if matches!(
                    error.kind(),
                    VectorParseErrorKind::UnexpectedHeader { .. }
                )
        ));
    }

    #[test]
    fn rejects_missing_columns_header() {
        let input = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
";
        assert!(matches!(
            parse_vector_set(input),
            Err(error)
                if matches!(error.kind(), VectorParseErrorKind::MissingHeader { .. })
        ));
    }

    #[test]
    fn rejects_an_extra_column() {
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
    fn rejects_invalid_and_duplicate_case_ids() {
        let invalid = VALID.replace("case_one", "Case-One");
        assert!(matches!(
            parse_vector_set(&invalid),
            Err(error)
                if matches!(error.kind(), VectorParseErrorKind::InvalidCaseId)
        ));

        let duplicate = format!("{VALID}case_one|1|62|ok|62|-\n");
        assert!(matches!(
            parse_vector_set(&duplicate),
            Err(error)
                if matches!(error.kind(), VectorParseErrorKind::DuplicateCaseId)
        ));
    }

    #[test]
    fn rejects_invalid_and_noncanonical_limits() {
        let invalid = VALID.replace("|1|61|", "|x|61|");
        assert!(matches!(
            parse_vector_set(&invalid),
            Err(error)
                if matches!(error.kind(), VectorParseErrorKind::InvalidMaxBytes)
        ));

        let leading_zero = VALID.replace("|1|61|", "|01|61|");
        assert!(matches!(
            parse_vector_set(&leading_zero),
            Err(error)
                if matches!(
                    error.kind(),
                    VectorParseErrorKind::NonCanonicalMaxBytes
                )
        ));
    }

    #[test]
    fn rejects_malformed_hex() {
        for value in ["", "a", "0A", "gg"] {
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
    fn rejects_a_frame_without_cases() {
        let input = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
";
        assert!(matches!(
            parse_vector_set(input),
            Err(error) if matches!(error.kind(), VectorParseErrorKind::NoCases)
        ));
    }

    #[test]
    fn reports_one_based_line_numbers() {
        let input = VALID.replace("|1|61|", "|01|61|");
        assert!(matches!(parse_vector_set(&input), Err(error) if error.line() == 4));
    }
}
