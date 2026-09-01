//! Strict bounded parser for `eliotr.test-vectors.stable-id.v1`.

#![forbid(unsafe_code)]

use core::fmt;
use std::collections::BTreeSet;

use eliotr_canonical::{
    STABLE_ID_ALPHABET_CODE, STABLE_ID_INPUT_TOO_LARGE_CODE, STABLE_ID_LENGTH_CODE,
    STABLE_ID_NUL_CODE, STABLE_ID_PART_TOO_LARGE_CODE, STABLE_ID_PREFIX_CODE,
    STABLE_ID_PREFIX_TOO_LARGE_CODE, STABLE_ID_TOO_MANY_PARTS_CODE, STABLE_ID_UTF8_CODE,
    validate_stable_id,
};

use super::model::{
    MAX_STABLE_ID_VECTOR_CASE_ID_BYTES, MAX_STABLE_ID_VECTOR_CASES,
    MAX_STABLE_ID_VECTOR_FRAME_BYTES, MAX_STABLE_ID_VECTOR_PAYLOAD_BYTES, STABLE_ID_COLUMNS_HEADER,
    STABLE_ID_PROTOCOL_HEADER, STABLE_ID_SCHEMA_GENERATION, StableIdExpectedError,
    StableIdExpectedOutcome, StableIdOperation, StableIdVector, StableIdVectorSet,
};

const GENERATION_HEADER: &str = "# schema_generation=1";
const COLUMN_COUNT: usize = 6;

/// Exact reason a stable-ID fixture frame was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StableIdParseErrorKind {
    FrameTooLarge {
        actual_bytes: usize,
        max_bytes: usize,
    },
    MissingHeader {
        expected: &'static str,
    },
    UnexpectedHeader {
        expected: &'static str,
    },
    UnexpectedBlankLine,
    TooManyCases {
        max_cases: usize,
    },
    WrongColumnCount {
        actual: usize,
    },
    CaseIdTooLong {
        actual_bytes: usize,
        max_bytes: usize,
    },
    InvalidCaseId,
    DuplicateCaseId,
    InvalidOperation,
    InvalidHex {
        field: &'static str,
    },
    PayloadTooLarge {
        field: &'static str,
        actual_bytes: usize,
        max_bytes: usize,
    },
    InvalidExpectedOutcome,
    InconsistentOutcome,
    UnknownErrorCode,
    IncompatibleError,
    InvalidOutputShape,
    NoCases,
}

/// Location-bearing, content-free fixture rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StableIdParseError {
    line: usize,
    kind: StableIdParseErrorKind,
}

impl StableIdParseError {
    fn new(line: usize, kind: StableIdParseErrorKind) -> Self {
        Self { line, kind }
    }

    /// Returns the one-based line, or zero for whole-frame rejection.
    #[must_use]
    pub const fn line(&self) -> usize {
        self.line
    }

    /// Returns the exact rejection kind.
    #[must_use]
    pub const fn kind(&self) -> &StableIdParseErrorKind {
        &self.kind
    }
}

impl fmt::Display for StableIdParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid stable-ID vector frame at line {}: {:?}",
            self.line, self.kind
        )
    }
}

impl std::error::Error for StableIdParseError {}

/// Parses one strict, versioned stable-ID fixture frame.
///
/// # Errors
///
/// Returns the first bounded parse, schema, compatibility, or expected-output-shape error.
pub fn parse_stable_id_vector_set(input: &str) -> Result<StableIdVectorSet, StableIdParseError> {
    if input.len() > MAX_STABLE_ID_VECTOR_FRAME_BYTES {
        return Err(StableIdParseError::new(
            0,
            StableIdParseErrorKind::FrameTooLarge {
                actual_bytes: input.len(),
                max_bytes: MAX_STABLE_ID_VECTOR_FRAME_BYTES,
            },
        ));
    }

    let lines: Vec<(usize, &str)> = input
        .lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line))
        .collect();
    require_header(&lines, 0, STABLE_ID_PROTOCOL_HEADER)?;
    require_header(&lines, 1, GENERATION_HEADER)?;
    require_header(&lines, 2, STABLE_ID_COLUMNS_HEADER)?;

    let mut case_ids = BTreeSet::new();
    let mut cases = Vec::new();
    for &(line_number, line) in lines.iter().skip(3) {
        if line.is_empty() {
            return Err(StableIdParseError::new(
                line_number,
                StableIdParseErrorKind::UnexpectedBlankLine,
            ));
        }
        if line.starts_with('#') {
            return Err(StableIdParseError::new(
                line_number,
                StableIdParseErrorKind::UnexpectedHeader {
                    expected: "a case row",
                },
            ));
        }
        if cases.len() == MAX_STABLE_ID_VECTOR_CASES {
            return Err(StableIdParseError::new(
                line_number,
                StableIdParseErrorKind::TooManyCases {
                    max_cases: MAX_STABLE_ID_VECTOR_CASES,
                },
            ));
        }

        let columns: Vec<&str> = line.split('|').collect();
        if columns.len() != COLUMN_COUNT {
            return Err(StableIdParseError::new(
                line_number,
                StableIdParseErrorKind::WrongColumnCount {
                    actual: columns.len(),
                },
            ));
        }

        let case_id = columns[0];
        if case_id.len() > MAX_STABLE_ID_VECTOR_CASE_ID_BYTES {
            return Err(StableIdParseError::new(
                line_number,
                StableIdParseErrorKind::CaseIdTooLong {
                    actual_bytes: case_id.len(),
                    max_bytes: MAX_STABLE_ID_VECTOR_CASE_ID_BYTES,
                },
            ));
        }
        if !is_canonical_case_id(case_id) {
            return Err(StableIdParseError::new(
                line_number,
                StableIdParseErrorKind::InvalidCaseId,
            ));
        }
        if !case_ids.insert(case_id) {
            return Err(StableIdParseError::new(
                line_number,
                StableIdParseErrorKind::DuplicateCaseId,
            ));
        }

        let operation = parse_operation(columns[1], line_number)?;
        let input_bytes = parse_hex(columns[2], "input_hex", line_number)?;
        let expected = parse_expected(operation, columns[3], columns[4], columns[5], line_number)?;
        cases.push(StableIdVector::new(
            case_id.to_owned(),
            operation,
            input_bytes,
            expected,
        ));
    }

    if cases.is_empty() {
        return Err(StableIdParseError::new(
            lines.last().map_or(1, |(line, _)| *line + 1),
            StableIdParseErrorKind::NoCases,
        ));
    }

    Ok(StableIdVectorSet::new(STABLE_ID_SCHEMA_GENERATION, cases))
}

fn require_header(
    lines: &[(usize, &str)],
    index: usize,
    expected: &'static str,
) -> Result<(), StableIdParseError> {
    let Some(&(line_number, actual)) = lines.get(index) else {
        return Err(StableIdParseError::new(
            index + 1,
            StableIdParseErrorKind::MissingHeader { expected },
        ));
    };
    if actual != expected {
        return Err(StableIdParseError::new(
            line_number,
            StableIdParseErrorKind::UnexpectedHeader { expected },
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

fn parse_operation(token: &str, line: usize) -> Result<StableIdOperation, StableIdParseError> {
    match token {
        "derive_stable_id" => Ok(StableIdOperation::DeriveStableId),
        "validate_stable_id" => Ok(StableIdOperation::ValidateStableId),
        _ => Err(StableIdParseError::new(
            line,
            StableIdParseErrorKind::InvalidOperation,
        )),
    }
}

fn parse_expected(
    operation: StableIdOperation,
    token: &str,
    output_hex: &str,
    error_code: &str,
    line: usize,
) -> Result<StableIdExpectedOutcome, StableIdParseError> {
    match token {
        "ok" => {
            if error_code != "-" {
                return Err(StableIdParseError::new(
                    line,
                    StableIdParseErrorKind::InconsistentOutcome,
                ));
            }
            let output = parse_hex(output_hex, "output_hex", line)?;
            if validate_stable_id(&output).is_err() {
                return Err(StableIdParseError::new(
                    line,
                    StableIdParseErrorKind::InvalidOutputShape,
                ));
            }
            Ok(StableIdExpectedOutcome::Success { output })
        }
        "error" => {
            if output_hex != "-" {
                return Err(StableIdParseError::new(
                    line,
                    StableIdParseErrorKind::InconsistentOutcome,
                ));
            }
            let expected = parse_error_code(error_code, line)?;
            if !expected.compatible_with(operation) {
                return Err(StableIdParseError::new(
                    line,
                    StableIdParseErrorKind::IncompatibleError,
                ));
            }
            Ok(StableIdExpectedOutcome::Error(expected))
        }
        _ => Err(StableIdParseError::new(
            line,
            StableIdParseErrorKind::InvalidExpectedOutcome,
        )),
    }
}

fn parse_error_code(code: &str, line: usize) -> Result<StableIdExpectedError, StableIdParseError> {
    let error = match code {
        STABLE_ID_INPUT_TOO_LARGE_CODE => StableIdExpectedError::InputTooLarge,
        STABLE_ID_PREFIX_TOO_LARGE_CODE => StableIdExpectedError::PrefixTooLarge,
        STABLE_ID_PREFIX_CODE => StableIdExpectedError::InvalidPrefix,
        STABLE_ID_TOO_MANY_PARTS_CODE => StableIdExpectedError::TooManyParts,
        STABLE_ID_PART_TOO_LARGE_CODE => StableIdExpectedError::PartTooLarge,
        STABLE_ID_NUL_CODE => StableIdExpectedError::InteriorNul,
        STABLE_ID_UTF8_CODE => StableIdExpectedError::InvalidUtf8,
        STABLE_ID_LENGTH_CODE => StableIdExpectedError::InvalidLength,
        STABLE_ID_ALPHABET_CODE => StableIdExpectedError::InvalidAlphabet,
        _ => {
            return Err(StableIdParseError::new(
                line,
                StableIdParseErrorKind::UnknownErrorCode,
            ));
        }
    };
    Ok(error)
}

fn parse_hex(value: &str, field: &'static str, line: usize) -> Result<Vec<u8>, StableIdParseError> {
    if value == "-" {
        return Ok(Vec::new());
    }
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err(StableIdParseError::new(
            line,
            StableIdParseErrorKind::InvalidHex { field },
        ));
    }

    let decoded_bytes = value.len() / 2;
    if decoded_bytes > MAX_STABLE_ID_VECTOR_PAYLOAD_BYTES {
        return Err(StableIdParseError::new(
            line,
            StableIdParseErrorKind::PayloadTooLarge {
                field,
                actual_bytes: decoded_bytes,
                max_bytes: MAX_STABLE_ID_VECTOR_PAYLOAD_BYTES,
            },
        ));
    }

    let mut bytes = Vec::with_capacity(decoded_bytes);
    for pair in value.as_bytes().as_chunks::<2>().0 {
        let (Some(high), Some(low)) = (hex_nibble(pair[0]), hex_nibble(pair[1])) else {
            return Err(StableIdParseError::new(
                line,
                StableIdParseErrorKind::InvalidHex { field },
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
    use super::{StableIdParseErrorKind, parse_stable_id_vector_set};
    use crate::{STABLE_ID_COLUMNS_HEADER, STABLE_ID_PROTOCOL_HEADER};

    fn frame(row: &str) -> String {
        format!(
            "{STABLE_ID_PROTOCOL_HEADER}\n# schema_generation=1\n{STABLE_ID_COLUMNS_HEADER}\n{row}\n"
        )
    }

    #[test]
    fn parses_one_canonical_case() {
        let parsed = parse_stable_id_vector_set(&frame(
            "source|derive_stable_id|736f75726365|ok|736f757263652d343163663637393462613432303062383339633533353331353535663066333939386466346362623031613464356362|-",
        ));
        assert!(matches!(parsed, Ok(set) if set.cases().len() == 1));
    }

    #[test]
    fn rejects_headers_blank_lines_shape_and_identity_failures() {
        assert!(matches!(
            parse_stable_id_vector_set(""),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::MissingHeader { .. })
        ));
        assert!(matches!(
            parse_stable_id_vector_set(&frame("\nsource|derive_stable_id|736f75726365|error|-|ELIOTR_STABLE_ID_PREFIX")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::UnexpectedBlankLine)
        ));
        assert!(matches!(
            parse_stable_id_vector_set(&frame("source|derive_stable_id|x")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::WrongColumnCount { .. })
        ));
        assert!(matches!(
            parse_stable_id_vector_set(&frame("Source|derive_stable_id|736f75726365|error|-|ELIOTR_STABLE_ID_PREFIX")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::InvalidCaseId)
        ));
    }

    #[test]
    fn rejects_operation_hex_outcome_and_error_failures() {
        assert!(matches!(
            parse_stable_id_vector_set(&frame("source|unknown|736f75726365|error|-|ELIOTR_STABLE_ID_PREFIX")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::InvalidOperation)
        ));
        assert!(matches!(
            parse_stable_id_vector_set(&frame("source|derive_stable_id|0A|error|-|ELIOTR_STABLE_ID_PREFIX")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::InvalidHex { .. })
        ));
        assert!(matches!(
            parse_stable_id_vector_set(&frame("source|derive_stable_id|736f75726365|maybe|-|-")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::InvalidExpectedOutcome)
        ));
        assert!(matches!(
            parse_stable_id_vector_set(&frame("source|derive_stable_id|736f75726365|error|-|ELIOTR_UNKNOWN")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::UnknownErrorCode)
        ));
        assert!(matches!(
            parse_stable_id_vector_set(&frame("source|validate_stable_id|736f75726365|error|-|ELIOTR_STABLE_ID_TOO_MANY_PARTS")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::IncompatibleError)
        ));
    }

    #[test]
    fn rejects_invalid_success_output_shape() {
        assert!(matches!(
            parse_stable_id_vector_set(&frame("source|derive_stable_id|736f75726365|ok|61|-")),
            Err(error) if matches!(error.kind(), StableIdParseErrorKind::InvalidOutputShape)
        ));
    }
}
