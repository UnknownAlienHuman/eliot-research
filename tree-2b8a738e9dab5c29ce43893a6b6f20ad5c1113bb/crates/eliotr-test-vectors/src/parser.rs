//! Strict, bounded parser for the dependency-free M1 fixture frame.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::fmt;

use eliotr_canonical::{UTF8_INVALID_CODE, UTF8_TOO_LARGE_CODE};

use crate::model::{
    CanonicalUtf8Vector, ExpectedError, ExpectedOutcome, MAX_VECTOR_CASE_ID_BYTES,
    MAX_VECTOR_CASES, MAX_VECTOR_FRAME_BYTES, MAX_VECTOR_PAYLOAD_BYTES, VECTOR_PROTOCOL_HEADER,
    VECTOR_SCHEMA_GENERATION, VectorSet,
};

const GENERATION_HEADER: &str = "# schema_generation=1";
const COLUMNS_HEADER: &str = "# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code";
const COLUMN_COUNT: usize = 6;

/// Exact reason a fixture frame was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VectorParseErrorKind {
    /// The complete UTF-8 frame exceeded its explicit byte budget.
    FrameTooLarge {
        /// Observed frame length in bytes.
        actual_bytes: usize,
        /// Maximum admitted frame length in bytes.
        max_bytes: usize,
    },
    /// A required header was absent.
    MissingHeader {
        /// Exact required header.
        expected: &'static str,
    },
    /// A header was present but unknown or out of order.
    UnexpectedHeader {
        /// Exact required header or row kind.
        expected: &'static str,
    },
    /// A blank line appeared inside the strict frame.
    UnexpectedBlankLine,
    /// The declared case count exceeded the explicit frame budget.
    TooManyCases {
        /// Maximum admitted number of cases.
        max_cases: usize,
    },
    /// A case row did not contain the exact column count.
    WrongColumnCount {
        /// Observed column count.
        actual: usize,
    },
    /// A case identity exceeded its explicit ASCII byte budget.
    CaseIdTooLong {
        /// Observed identity length in bytes.
        actual_bytes: usize,
        /// Maximum admitted identity length in bytes.
        max_bytes: usize,
    },
    /// A case identity was empty or outside the canonical ASCII grammar.
    InvalidCaseId,
    /// A case identity appeared more than once.
    DuplicateCaseId,
    /// The byte limit was not a canonical unsigned 32-bit decimal integer.
    InvalidMaxBytes,
    /// The byte limit used a non-canonical leading zero.
    NonCanonicalMaxBytes,
    /// A byte field was empty, odd-length, uppercase, or non-hexadecimal.
    InvalidHex {
        /// Name of the rejected field.
        field: &'static str,
    },
    /// A decoded byte field exceeded its explicit byte budget.
    PayloadTooLarge {
        /// Name of the rejected field.
        field: &'static str,
        /// Observed decoded length in bytes.
        actual_bytes: usize,
        /// Maximum admitted decoded length in bytes.
        max_bytes: usize,
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

/// Parses the strict, versioned, architecture-independent M1 vector frame.
///
/// Unknown headers, blank lines, fields, outcome values, error codes, duplicate identities,
/// non-canonical integers, and every explicit resource limit fail closed before semantic execution.
///
/// # Errors
///
/// Returns [`VectorParseError`] at the first rejected line or at line zero when the whole frame is
/// rejected before line parsing.
pub fn parse_vector_set(input: &str) -> Result<VectorSet, VectorParseError> {
    if input.len() > MAX_VECTOR_FRAME_BYTES {
        return Err(VectorParseError::new(
            0,
            VectorParseErrorKind::FrameTooLarge {
                actual_bytes: input.len(),
                max_bytes: MAX_VECTOR_FRAME_BYTES,
            },
        ));
    }

    let lines: Vec<(usize, &str)> = input
        .lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line))
        .collect();

    require_header(&lines, 0, VECTOR_PROTOCOL_HEADER)?;
    require_header(&lines, 1, GENERATION_HEADER)?;
    require_header(&lines, 2, COLUMNS_HEADER)?;

    let mut case_ids = BTreeSet::new();
    let mut cases = Vec::new();

    for &(line_number, line) in lines.iter().skip(3) {
        if line.is_empty() {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::UnexpectedBlankLine,
            ));
        }
        if line.starts_with('#') {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::UnexpectedHeader {
                    expected: "a case row",
                },
            ));
        }
        if cases.len() == MAX_VECTOR_CASES {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::TooManyCases {
                    max_cases: MAX_VECTOR_CASES,
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
        if case_id.len() > MAX_VECTOR_CASE_ID_BYTES {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::CaseIdTooLong {
                    actual_bytes: case_id.len(),
                    max_bytes: MAX_VECTOR_CASE_ID_BYTES,
                },
            ));
        }
        if !is_canonical_case_id(case_id) {
            return Err(VectorParseError::new(
                line_number,
                VectorParseErrorKind::InvalidCaseId,
            ));
        }
        if !case_ids.insert(case_id) {
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
            VectorParseErrorKind::UnexpectedHeader { expected },
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

fn parse_max_bytes(value: &str, line: usize) -> Result<u32, VectorParseError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(VectorParseError::new(
            line,
            VectorParseErrorKind::InvalidMaxBytes,
        ));
    }
    if value.len() > 1 && value.starts_with('0') {
        return Err(VectorParseError::new(
            line,
            VectorParseErrorKind::NonCanonicalMaxBytes,
        ));
    }

    value
        .parse::<u32>()
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

    let decoded_bytes = value.len() / 2;
    if decoded_bytes > MAX_VECTOR_PAYLOAD_BYTES {
        return Err(VectorParseError::new(
            line,
            VectorParseErrorKind::PayloadTooLarge {
                field,
                actual_bytes: decoded_bytes,
                max_bytes: MAX_VECTOR_PAYLOAD_BYTES,
            },
        ));
    }

    let mut bytes = Vec::with_capacity(decoded_bytes);
    for pair in value.as_bytes().as_chunks::<2>().0 {
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
