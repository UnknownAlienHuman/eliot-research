//! Strict bounded parser for `eliotr.test-vectors.canonical-body.v1`.

#![forbid(unsafe_code)]

use core::fmt;
use std::collections::BTreeSet;

use eliotr_canonical::{
    GENERATION_ALPHABET_CODE, GENERATION_LENGTH_CODE, GENERATION_PREFIX_CODE,
    GENERATION_TOKEN_BYTES, JSON_DEPTH_LIMIT_CODE, JSON_DUPLICATE_KEY_CODE,
    JSON_INPUT_TOO_LARGE_CODE, JSON_INVALID_UTF8_CODE, JSON_ITEM_LIMIT_CODE,
    JSON_MEMBER_LIMIT_CODE, JSON_NODE_LIMIT_CODE, JSON_NUMBER_CODE, JSON_OUTPUT_TOO_LARGE_CODE,
    JSON_STRING_TOO_LARGE_CODE, JSON_SYNTAX_CODE, JSON_UNICODE_CODE,
};

use super::model::{
    CANONICAL_BODY_COLUMNS_HEADER, CANONICAL_BODY_PROTOCOL_HEADER,
    CANONICAL_BODY_SCHEMA_GENERATION, CanonicalBodyExpectedError, CanonicalBodyExpectedOutcome,
    CanonicalBodyOperation, CanonicalBodyVector, CanonicalBodyVectorSet,
    MAX_CANONICAL_BODY_VECTOR_CASE_ID_BYTES, MAX_CANONICAL_BODY_VECTOR_CASES,
    MAX_CANONICAL_BODY_VECTOR_FRAME_BYTES, MAX_CANONICAL_BODY_VECTOR_PAYLOAD_BYTES,
};

const GENERATION_HEADER: &str = "# schema_generation=1";
const COLUMN_COUNT: usize = 6;

/// Exact reason a canonical-body fixture frame was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalBodyParseErrorKind {
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
pub struct CanonicalBodyParseError {
    line: usize,
    kind: CanonicalBodyParseErrorKind,
}

impl CanonicalBodyParseError {
    fn new(line: usize, kind: CanonicalBodyParseErrorKind) -> Self {
        Self { line, kind }
    }

    /// Returns the one-based line, or zero for whole-frame rejection.
    #[must_use]
    pub const fn line(&self) -> usize {
        self.line
    }

    /// Returns the exact rejection kind.
    #[must_use]
    pub const fn kind(&self) -> &CanonicalBodyParseErrorKind {
        &self.kind
    }
}

impl fmt::Display for CanonicalBodyParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid canonical-body vector frame at line {}: {:?}",
            self.line, self.kind
        )
    }
}

impl std::error::Error for CanonicalBodyParseError {}

/// Parses the strict versioned M2 frame.
///
/// # Errors
///
/// Returns the first bounded parse or schema error.
pub fn parse_canonical_body_vector_set(
    input: &str,
) -> Result<CanonicalBodyVectorSet, CanonicalBodyParseError> {
    if input.len() > MAX_CANONICAL_BODY_VECTOR_FRAME_BYTES {
        return Err(CanonicalBodyParseError::new(
            0,
            CanonicalBodyParseErrorKind::FrameTooLarge {
                actual_bytes: input.len(),
                max_bytes: MAX_CANONICAL_BODY_VECTOR_FRAME_BYTES,
            },
        ));
    }

    let lines: Vec<(usize, &str)> = input
        .lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line))
        .collect();
    require_header(&lines, 0, CANONICAL_BODY_PROTOCOL_HEADER)?;
    require_header(&lines, 1, GENERATION_HEADER)?;
    require_header(&lines, 2, CANONICAL_BODY_COLUMNS_HEADER)?;

    let mut case_ids = BTreeSet::new();
    let mut cases = Vec::new();
    for &(line_number, line) in lines.iter().skip(3) {
        if line.is_empty() {
            return Err(CanonicalBodyParseError::new(
                line_number,
                CanonicalBodyParseErrorKind::UnexpectedBlankLine,
            ));
        }
        if line.starts_with('#') {
            return Err(CanonicalBodyParseError::new(
                line_number,
                CanonicalBodyParseErrorKind::UnexpectedHeader {
                    expected: "a case row",
                },
            ));
        }
        if cases.len() == MAX_CANONICAL_BODY_VECTOR_CASES {
            return Err(CanonicalBodyParseError::new(
                line_number,
                CanonicalBodyParseErrorKind::TooManyCases {
                    max_cases: MAX_CANONICAL_BODY_VECTOR_CASES,
                },
            ));
        }

        let columns: Vec<&str> = line.split('|').collect();
        if columns.len() != COLUMN_COUNT {
            return Err(CanonicalBodyParseError::new(
                line_number,
                CanonicalBodyParseErrorKind::WrongColumnCount {
                    actual: columns.len(),
                },
            ));
        }

        let case_id = columns[0];
        if case_id.len() > MAX_CANONICAL_BODY_VECTOR_CASE_ID_BYTES {
            return Err(CanonicalBodyParseError::new(
                line_number,
                CanonicalBodyParseErrorKind::CaseIdTooLong {
                    actual_bytes: case_id.len(),
                    max_bytes: MAX_CANONICAL_BODY_VECTOR_CASE_ID_BYTES,
                },
            ));
        }
        if !is_canonical_case_id(case_id) {
            return Err(CanonicalBodyParseError::new(
                line_number,
                CanonicalBodyParseErrorKind::InvalidCaseId,
            ));
        }
        if !case_ids.insert(case_id) {
            return Err(CanonicalBodyParseError::new(
                line_number,
                CanonicalBodyParseErrorKind::DuplicateCaseId,
            ));
        }

        let operation = parse_operation(columns[1], line_number)?;
        let input_bytes = parse_hex(columns[2], "input_hex", line_number)?;
        let expected = parse_expected(operation, columns[3], columns[4], columns[5], line_number)?;
        cases.push(CanonicalBodyVector::new(
            case_id.to_owned(),
            operation,
            input_bytes,
            expected,
        ));
    }

    if cases.is_empty() {
        return Err(CanonicalBodyParseError::new(
            lines.last().map_or(1, |(line, _)| *line + 1),
            CanonicalBodyParseErrorKind::NoCases,
        ));
    }
    Ok(CanonicalBodyVectorSet::new(
        CANONICAL_BODY_SCHEMA_GENERATION,
        cases,
    ))
}

fn require_header(
    lines: &[(usize, &str)],
    index: usize,
    expected: &'static str,
) -> Result<(), CanonicalBodyParseError> {
    let Some(&(line_number, actual)) = lines.get(index) else {
        return Err(CanonicalBodyParseError::new(
            index + 1,
            CanonicalBodyParseErrorKind::MissingHeader { expected },
        ));
    };
    if actual != expected {
        return Err(CanonicalBodyParseError::new(
            line_number,
            CanonicalBodyParseErrorKind::UnexpectedHeader { expected },
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

fn parse_operation(
    token: &str,
    line: usize,
) -> Result<CanonicalBodyOperation, CanonicalBodyParseError> {
    match token {
        "canonicalize_json" => Ok(CanonicalBodyOperation::CanonicalizeJson),
        "sha256" => Ok(CanonicalBodyOperation::Sha256),
        "validate_generation" => Ok(CanonicalBodyOperation::ValidateGeneration),
        _ => Err(CanonicalBodyParseError::new(
            line,
            CanonicalBodyParseErrorKind::InvalidOperation,
        )),
    }
}

fn parse_expected(
    operation: CanonicalBodyOperation,
    token: &str,
    output_hex: &str,
    error_code: &str,
    line: usize,
) -> Result<CanonicalBodyExpectedOutcome, CanonicalBodyParseError> {
    match token {
        "ok" => {
            if error_code != "-" {
                return Err(CanonicalBodyParseError::new(
                    line,
                    CanonicalBodyParseErrorKind::InconsistentOutcome,
                ));
            }
            let output = parse_hex(output_hex, "output_hex", line)?;
            if matches!(operation, CanonicalBodyOperation::Sha256) && output.len() != 32
                || matches!(operation, CanonicalBodyOperation::ValidateGeneration)
                    && output.len() != GENERATION_TOKEN_BYTES
            {
                return Err(CanonicalBodyParseError::new(
                    line,
                    CanonicalBodyParseErrorKind::InvalidOutputShape,
                ));
            }
            Ok(CanonicalBodyExpectedOutcome::Success { output })
        }
        "error" => {
            if output_hex != "-" {
                return Err(CanonicalBodyParseError::new(
                    line,
                    CanonicalBodyParseErrorKind::InconsistentOutcome,
                ));
            }
            let error = parse_error_code(error_code, line)?;
            if !error.compatible_with(operation) {
                return Err(CanonicalBodyParseError::new(
                    line,
                    CanonicalBodyParseErrorKind::IncompatibleError,
                ));
            }
            Ok(CanonicalBodyExpectedOutcome::Error(error))
        }
        _ => Err(CanonicalBodyParseError::new(
            line,
            CanonicalBodyParseErrorKind::InvalidExpectedOutcome,
        )),
    }
}

fn parse_error_code(
    code: &str,
    line: usize,
) -> Result<CanonicalBodyExpectedError, CanonicalBodyParseError> {
    let error = match code {
        JSON_INPUT_TOO_LARGE_CODE => CanonicalBodyExpectedError::JsonInputTooLarge,
        JSON_INVALID_UTF8_CODE => CanonicalBodyExpectedError::JsonInvalidUtf8,
        JSON_SYNTAX_CODE => CanonicalBodyExpectedError::JsonSyntax,
        JSON_DUPLICATE_KEY_CODE => CanonicalBodyExpectedError::JsonDuplicateKey,
        JSON_DEPTH_LIMIT_CODE => CanonicalBodyExpectedError::JsonDepthLimit,
        JSON_MEMBER_LIMIT_CODE => CanonicalBodyExpectedError::JsonMemberLimit,
        JSON_ITEM_LIMIT_CODE => CanonicalBodyExpectedError::JsonItemLimit,
        JSON_NODE_LIMIT_CODE => CanonicalBodyExpectedError::JsonNodeLimit,
        JSON_STRING_TOO_LARGE_CODE => CanonicalBodyExpectedError::JsonStringTooLarge,
        JSON_NUMBER_CODE => CanonicalBodyExpectedError::JsonNumber,
        JSON_UNICODE_CODE => CanonicalBodyExpectedError::JsonUnicode,
        JSON_OUTPUT_TOO_LARGE_CODE => CanonicalBodyExpectedError::JsonOutputTooLarge,
        GENERATION_LENGTH_CODE => CanonicalBodyExpectedError::GenerationLength,
        GENERATION_PREFIX_CODE => CanonicalBodyExpectedError::GenerationPrefix,
        GENERATION_ALPHABET_CODE => CanonicalBodyExpectedError::GenerationAlphabet,
        _ => {
            return Err(CanonicalBodyParseError::new(
                line,
                CanonicalBodyParseErrorKind::UnknownErrorCode,
            ));
        }
    };
    Ok(error)
}

fn parse_hex(
    value: &str,
    field: &'static str,
    line: usize,
) -> Result<Vec<u8>, CanonicalBodyParseError> {
    if value == "-" {
        return Ok(Vec::new());
    }
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err(CanonicalBodyParseError::new(
            line,
            CanonicalBodyParseErrorKind::InvalidHex { field },
        ));
    }
    let decoded_bytes = value.len() / 2;
    if decoded_bytes > MAX_CANONICAL_BODY_VECTOR_PAYLOAD_BYTES {
        return Err(CanonicalBodyParseError::new(
            line,
            CanonicalBodyParseErrorKind::PayloadTooLarge {
                field,
                actual_bytes: decoded_bytes,
                max_bytes: MAX_CANONICAL_BODY_VECTOR_PAYLOAD_BYTES,
            },
        ));
    }

    let mut bytes = Vec::with_capacity(decoded_bytes);
    for pair in value.as_bytes().as_chunks::<2>().0 {
        let (Some(high), Some(low)) = (hex_nibble(pair[0]), hex_nibble(pair[1])) else {
            return Err(CanonicalBodyParseError::new(
                line,
                CanonicalBodyParseErrorKind::InvalidHex { field },
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
