//! Strict bounded parser for `eliotr.test-vectors.owner-token.v1`.

#![forbid(unsafe_code)]

use core::fmt;
use std::collections::BTreeSet;

use eliotr_canonical::{
    OWNER_TOKEN_ALPHABET_CODE, OWNER_TOKEN_INCARNATION_CODE, OWNER_TOKEN_INPUT_TOO_LARGE_CODE,
    OWNER_TOKEN_LENGTH_CODE, OWNER_TOKEN_NAMESPACE_CODE, OWNER_TOKEN_OWNER_CODE,
    OWNER_TOKEN_PREFIX_CODE, OWNER_TOKEN_REVISION_CODE, OWNER_TOKEN_SCHEMA_CODE,
    OWNER_TOKEN_SHAPE_CODE, OWNER_TOKEN_STATE_CODE, OWNER_TOKEN_SYNTAX_CODE,
    OWNER_TOKEN_UNICODE_CODE, OWNER_TOKEN_UTF8_CODE, validate_owner_token,
};

use super::model::{
    MAX_OWNER_TOKEN_VECTOR_CASE_ID_BYTES, MAX_OWNER_TOKEN_VECTOR_CASES,
    MAX_OWNER_TOKEN_VECTOR_FRAME_BYTES, MAX_OWNER_TOKEN_VECTOR_PAYLOAD_BYTES,
    OWNER_TOKEN_COLUMNS_HEADER, OWNER_TOKEN_PROTOCOL_HEADER, OWNER_TOKEN_SCHEMA_GENERATION,
    OwnerTokenExpectedError, OwnerTokenExpectedOutcome, OwnerTokenOperation, OwnerTokenVector,
    OwnerTokenVectorSet,
};

const GENERATION_HEADER: &str = "# schema_generation=1";
const COLUMN_COUNT: usize = 6;

/// Exact reason an owner-token fixture frame was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerTokenParseErrorKind {
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
pub struct OwnerTokenParseError {
    line: usize,
    kind: OwnerTokenParseErrorKind,
}

impl OwnerTokenParseError {
    fn new(line: usize, kind: OwnerTokenParseErrorKind) -> Self {
        Self { line, kind }
    }

    /// Returns the one-based line, or zero for whole-frame rejection.
    #[must_use]
    pub const fn line(&self) -> usize {
        self.line
    }

    /// Returns the exact rejection kind.
    #[must_use]
    pub const fn kind(&self) -> &OwnerTokenParseErrorKind {
        &self.kind
    }
}

impl fmt::Display for OwnerTokenParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid owner-token vector frame at line {}: {:?}",
            self.line, self.kind
        )
    }
}

impl std::error::Error for OwnerTokenParseError {}

/// Parses one strict, versioned owner-token fixture frame.
///
/// CR and CRLF line endings are not normalized here: committed fixtures are LF bytes and the
/// JavaScript reference normalizes transport line endings before parsing, so both runtimes
/// evaluate identical case rows.
///
/// # Errors
///
/// Returns the first bounded parse, schema, compatibility, or expected-output-shape error.
pub fn parse_owner_token_vector_set(
    input: &str,
) -> Result<OwnerTokenVectorSet, OwnerTokenParseError> {
    if input.len() > MAX_OWNER_TOKEN_VECTOR_FRAME_BYTES {
        return Err(OwnerTokenParseError::new(
            0,
            OwnerTokenParseErrorKind::FrameTooLarge {
                actual_bytes: input.len(),
                max_bytes: MAX_OWNER_TOKEN_VECTOR_FRAME_BYTES,
            },
        ));
    }

    let lines: Vec<(usize, &str)> = input
        .lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line))
        .collect();
    require_header(&lines, 0, OWNER_TOKEN_PROTOCOL_HEADER)?;
    require_header(&lines, 1, GENERATION_HEADER)?;
    require_header(&lines, 2, OWNER_TOKEN_COLUMNS_HEADER)?;

    let mut case_ids = BTreeSet::new();
    let mut cases = Vec::new();
    for &(line_number, line) in lines.iter().skip(3) {
        if line.is_empty() {
            return Err(OwnerTokenParseError::new(
                line_number,
                OwnerTokenParseErrorKind::UnexpectedBlankLine,
            ));
        }
        if line.starts_with('#') {
            return Err(OwnerTokenParseError::new(
                line_number,
                OwnerTokenParseErrorKind::UnexpectedHeader {
                    expected: "a case row",
                },
            ));
        }
        if cases.len() == MAX_OWNER_TOKEN_VECTOR_CASES {
            return Err(OwnerTokenParseError::new(
                line_number,
                OwnerTokenParseErrorKind::TooManyCases {
                    max_cases: MAX_OWNER_TOKEN_VECTOR_CASES,
                },
            ));
        }

        let columns: Vec<&str> = line.split('|').collect();
        if columns.len() != COLUMN_COUNT {
            return Err(OwnerTokenParseError::new(
                line_number,
                OwnerTokenParseErrorKind::WrongColumnCount {
                    actual: columns.len(),
                },
            ));
        }

        let case_id = columns[0];
        if case_id.len() > MAX_OWNER_TOKEN_VECTOR_CASE_ID_BYTES {
            return Err(OwnerTokenParseError::new(
                line_number,
                OwnerTokenParseErrorKind::CaseIdTooLong {
                    actual_bytes: case_id.len(),
                    max_bytes: MAX_OWNER_TOKEN_VECTOR_CASE_ID_BYTES,
                },
            ));
        }
        if !is_canonical_case_id(case_id) {
            return Err(OwnerTokenParseError::new(
                line_number,
                OwnerTokenParseErrorKind::InvalidCaseId,
            ));
        }
        if !case_ids.insert(case_id) {
            return Err(OwnerTokenParseError::new(
                line_number,
                OwnerTokenParseErrorKind::DuplicateCaseId,
            ));
        }

        let operation = parse_operation(columns[1], line_number)?;
        let input_bytes = parse_hex(columns[2], "input_hex", line_number)?;
        let expected = parse_expected(
            operation,
            &input_bytes,
            columns[3],
            columns[4],
            columns[5],
            line_number,
        )?;
        cases.push(OwnerTokenVector::new(
            case_id.to_owned(),
            operation,
            input_bytes,
            expected,
        ));
    }

    if cases.is_empty() {
        return Err(OwnerTokenParseError::new(
            lines.last().map_or(1, |(line, _)| *line + 1),
            OwnerTokenParseErrorKind::NoCases,
        ));
    }

    Ok(OwnerTokenVectorSet::new(
        OWNER_TOKEN_SCHEMA_GENERATION,
        cases,
    ))
}

fn require_header(
    lines: &[(usize, &str)],
    index: usize,
    expected: &'static str,
) -> Result<(), OwnerTokenParseError> {
    let Some(&(line_number, actual)) = lines.get(index) else {
        return Err(OwnerTokenParseError::new(
            index + 1,
            OwnerTokenParseErrorKind::MissingHeader { expected },
        ));
    };
    if actual != expected {
        return Err(OwnerTokenParseError::new(
            line_number,
            OwnerTokenParseErrorKind::UnexpectedHeader { expected },
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

fn parse_operation(token: &str, line: usize) -> Result<OwnerTokenOperation, OwnerTokenParseError> {
    match token {
        "derive_owner_token" => Ok(OwnerTokenOperation::DeriveOwnerToken),
        "validate_owner_token" => Ok(OwnerTokenOperation::ValidateOwnerToken),
        _ => Err(OwnerTokenParseError::new(
            line,
            OwnerTokenParseErrorKind::InvalidOperation,
        )),
    }
}

fn parse_expected(
    operation: OwnerTokenOperation,
    input: &[u8],
    token: &str,
    output_hex: &str,
    error_code: &str,
    line: usize,
) -> Result<OwnerTokenExpectedOutcome, OwnerTokenParseError> {
    match token {
        "ok" => {
            if error_code != "-" {
                return Err(OwnerTokenParseError::new(
                    line,
                    OwnerTokenParseErrorKind::InconsistentOutcome,
                ));
            }
            let output = parse_hex(output_hex, "output_hex", line)?;
            if validate_owner_token(&output).is_err() {
                return Err(OwnerTokenParseError::new(
                    line,
                    OwnerTokenParseErrorKind::InvalidOutputShape,
                ));
            }
            if operation == OwnerTokenOperation::ValidateOwnerToken && output != input {
                return Err(OwnerTokenParseError::new(
                    line,
                    OwnerTokenParseErrorKind::InvalidOutputShape,
                ));
            }
            Ok(OwnerTokenExpectedOutcome::Success { output })
        }
        "error" => {
            if output_hex != "-" {
                return Err(OwnerTokenParseError::new(
                    line,
                    OwnerTokenParseErrorKind::InconsistentOutcome,
                ));
            }
            let expected = parse_error_code(error_code, line)?;
            if !expected.compatible_with(operation) {
                return Err(OwnerTokenParseError::new(
                    line,
                    OwnerTokenParseErrorKind::IncompatibleError,
                ));
            }
            Ok(OwnerTokenExpectedOutcome::Error(expected))
        }
        _ => Err(OwnerTokenParseError::new(
            line,
            OwnerTokenParseErrorKind::InvalidExpectedOutcome,
        )),
    }
}

fn parse_error_code(
    code: &str,
    line: usize,
) -> Result<OwnerTokenExpectedError, OwnerTokenParseError> {
    let error = match code {
        OWNER_TOKEN_INPUT_TOO_LARGE_CODE => OwnerTokenExpectedError::InputTooLarge,
        OWNER_TOKEN_UTF8_CODE => OwnerTokenExpectedError::InvalidUtf8,
        OWNER_TOKEN_SYNTAX_CODE => OwnerTokenExpectedError::Syntax,
        OWNER_TOKEN_UNICODE_CODE => OwnerTokenExpectedError::Unicode,
        OWNER_TOKEN_SHAPE_CODE => OwnerTokenExpectedError::Shape,
        OWNER_TOKEN_SCHEMA_CODE => OwnerTokenExpectedError::Schema,
        OWNER_TOKEN_NAMESPACE_CODE => OwnerTokenExpectedError::Namespace,
        OWNER_TOKEN_INCARNATION_CODE => OwnerTokenExpectedError::Incarnation,
        OWNER_TOKEN_OWNER_CODE => OwnerTokenExpectedError::Owner,
        OWNER_TOKEN_REVISION_CODE => OwnerTokenExpectedError::Revision,
        OWNER_TOKEN_STATE_CODE => OwnerTokenExpectedError::State,
        OWNER_TOKEN_LENGTH_CODE => OwnerTokenExpectedError::InvalidLength,
        OWNER_TOKEN_PREFIX_CODE => OwnerTokenExpectedError::Prefix,
        OWNER_TOKEN_ALPHABET_CODE => OwnerTokenExpectedError::InvalidAlphabet,
        _ => {
            return Err(OwnerTokenParseError::new(
                line,
                OwnerTokenParseErrorKind::UnknownErrorCode,
            ));
        }
    };
    Ok(error)
}

fn parse_hex(
    value: &str,
    field: &'static str,
    line: usize,
) -> Result<Vec<u8>, OwnerTokenParseError> {
    if value == "-" {
        return Ok(Vec::new());
    }
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err(OwnerTokenParseError::new(
            line,
            OwnerTokenParseErrorKind::InvalidHex { field },
        ));
    }

    let decoded_bytes = value.len() / 2;
    if decoded_bytes > MAX_OWNER_TOKEN_VECTOR_PAYLOAD_BYTES {
        return Err(OwnerTokenParseError::new(
            line,
            OwnerTokenParseErrorKind::PayloadTooLarge {
                field,
                actual_bytes: decoded_bytes,
                max_bytes: MAX_OWNER_TOKEN_VECTOR_PAYLOAD_BYTES,
            },
        ));
    }

    let mut bytes = Vec::with_capacity(decoded_bytes);
    for pair in value.as_bytes().as_chunks::<2>().0 {
        let (Some(high), Some(low)) = (hex_nibble(pair[0]), hex_nibble(pair[1])) else {
            return Err(OwnerTokenParseError::new(
                line,
                OwnerTokenParseErrorKind::InvalidHex { field },
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
    use super::{OwnerTokenParseErrorKind, parse_owner_token_vector_set};
    use crate::{OWNER_TOKEN_COLUMNS_HEADER, OWNER_TOKEN_PROTOCOL_HEADER};

    fn frame(row: &str) -> String {
        format!(
            "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{row}\n"
        )
    }

    #[test]
    fn rejects_headers_blank_lines_shape_and_identity_failures() {
        assert!(matches!(
            parse_owner_token_vector_set(""),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::MissingHeader { .. })
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("\nderive_owner_token|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::UnexpectedBlankLine)
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|derive_owner_token|x")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::WrongColumnCount { .. })
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("__proto__|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::InvalidCaseId)
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("Source|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::InvalidCaseId)
        ));
    }

    #[test]
    fn rejects_operation_hex_outcome_and_error_failures() {
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|unknown|5b5d|error|-|ELIOTR_OWNER_TOKEN_SHAPE")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::InvalidOperation)
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|derive_owner_token|0A|error|-|ELIOTR_OWNER_TOKEN_SHAPE")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::InvalidHex { .. })
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|derive_owner_token|5b5d|maybe|-|-")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::InvalidExpectedOutcome)
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|derive_owner_token|5b5d|error|-|ELIOTR_UNKNOWN")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::UnknownErrorCode)
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|validate_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_NAMESPACE")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::IncompatibleError)
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_PREFIX")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::IncompatibleError)
        ));
    }

    #[test]
    fn rejects_invalid_success_output_shape() {
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|derive_owner_token|5b5d|ok|61|-")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::InvalidOutputShape)
        ));
        assert!(matches!(
            parse_owner_token_vector_set(&frame("source|validate_owner_token|5b5d|ok|61|-")),
            Err(error) if matches!(error.kind(), OwnerTokenParseErrorKind::InvalidOutputShape)
        ));
    }
}
