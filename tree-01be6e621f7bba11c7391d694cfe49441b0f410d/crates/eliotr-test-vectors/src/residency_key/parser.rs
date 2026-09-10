//! Strict bounded parser for `eliotr.test-vectors.residency-key.v1`.

#![forbid(unsafe_code)]

use core::fmt;
use std::collections::BTreeSet;

use eliotr_canonical::{
    OBJECT_RESIDENCY_KEY_DIGEST_ALGORITHM, OBJECT_RESIDENCY_KEY_VERSION,
    RESIDENCY_KEY_DIGEST_ALPHABET_CODE, RESIDENCY_KEY_DIGEST_LENGTH_CODE,
    RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE, RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE,
    RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE, RESIDENCY_KEY_UTF8_CODE,
};

use super::model::{
    MAX_RESIDENCY_KEY_VECTOR_CASE_ID_BYTES, MAX_RESIDENCY_KEY_VECTOR_CASES,
    MAX_RESIDENCY_KEY_VECTOR_FIELD_BYTES, MAX_RESIDENCY_KEY_VECTOR_FRAME_BYTES,
    MAX_RESIDENCY_KEY_VECTOR_OUTPUT_BYTES, RESIDENCY_KEY_COLUMNS_HEADER,
    RESIDENCY_KEY_PROTOCOL_HEADER, RESIDENCY_KEY_SCHEMA_GENERATION, ResidencyKeyExpectedError,
    ResidencyKeyExpectedOutcome, ResidencyKeyVector, ResidencyKeyVectorSet,
};

const GENERATION_HEADER: &str = "# schema_generation=1";
const COLUMN_COUNT: usize = 11;

/// Exact reason a residency-key fixture frame was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResidencyKeyParseErrorKind {
    /// Complete frame exceeded its byte ceiling.
    FrameTooLarge {
        /// Observed bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// A required header was absent.
    MissingHeader {
        /// Exact required header.
        expected: &'static str,
    },
    /// A header was unknown or out of order.
    UnexpectedHeader {
        /// Exact required next form.
        expected: &'static str,
    },
    /// An interior blank line appeared.
    UnexpectedBlankLine,
    /// The case count exceeded its ceiling.
    TooManyCases {
        /// Maximum admitted cases.
        max_cases: usize,
    },
    /// A case row had the wrong column count.
    WrongColumnCount {
        /// Observed columns.
        actual: usize,
    },
    /// A case identity exceeded its byte ceiling.
    CaseIdTooLong {
        /// Observed bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// A case identity violated the ASCII grammar.
    InvalidCaseId,
    /// A case identity appeared twice.
    DuplicateCaseId,
    /// A byte field was malformed hexadecimal.
    InvalidHex {
        /// Rejected column.
        field: &'static str,
    },
    /// A decoded byte field exceeded its ceiling.
    FieldTooLarge {
        /// Rejected column.
        field: &'static str,
        /// Observed decoded bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// The expected token was not `ok` or `error`.
    InvalidExpectedOutcome,
    /// Success/error columns contradicted the expected token.
    InconsistentOutcome,
    /// Error code was outside the stable vocabulary.
    UnknownErrorCode,
    /// Success output was not one canonical serialized residency key.
    InvalidOutputShape,
    /// The frame contained no cases.
    NoCases,
}

/// Location-bearing, content-free fixture rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidencyKeyParseError {
    line: usize,
    kind: ResidencyKeyParseErrorKind,
}

impl ResidencyKeyParseError {
    fn new(line: usize, kind: ResidencyKeyParseErrorKind) -> Self {
        Self { line, kind }
    }

    /// Returns the one-based line, or zero for whole-frame rejection.
    #[must_use]
    pub const fn line(&self) -> usize {
        self.line
    }

    /// Returns the exact rejection kind.
    #[must_use]
    pub const fn kind(&self) -> &ResidencyKeyParseErrorKind {
        &self.kind
    }
}

impl fmt::Display for ResidencyKeyParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid residency-key vector frame at line {}: {:?}",
            self.line, self.kind
        )
    }
}

impl std::error::Error for ResidencyKeyParseError {}

/// Parses one strict, versioned residency-key fixture frame.
///
/// # Errors
///
/// Returns the first bounded parse, schema, or expected-output-shape error.
pub fn parse_residency_key_vector_set(
    input: &str,
) -> Result<ResidencyKeyVectorSet, ResidencyKeyParseError> {
    if input.len() > MAX_RESIDENCY_KEY_VECTOR_FRAME_BYTES {
        return Err(ResidencyKeyParseError::new(
            0,
            ResidencyKeyParseErrorKind::FrameTooLarge {
                actual_bytes: input.len(),
                max_bytes: MAX_RESIDENCY_KEY_VECTOR_FRAME_BYTES,
            },
        ));
    }

    let lines: Vec<(usize, &str)> = input
        .lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line))
        .collect();
    require_header(&lines, 0, RESIDENCY_KEY_PROTOCOL_HEADER)?;
    require_header(&lines, 1, GENERATION_HEADER)?;
    require_header(&lines, 2, RESIDENCY_KEY_COLUMNS_HEADER)?;

    let mut case_ids = BTreeSet::new();
    let mut cases = Vec::new();
    for &(line_number, line) in lines.iter().skip(3) {
        if line.is_empty() {
            return Err(ResidencyKeyParseError::new(
                line_number,
                ResidencyKeyParseErrorKind::UnexpectedBlankLine,
            ));
        }
        if line.starts_with('#') {
            return Err(ResidencyKeyParseError::new(
                line_number,
                ResidencyKeyParseErrorKind::UnexpectedHeader {
                    expected: "a case row",
                },
            ));
        }
        if cases.len() == MAX_RESIDENCY_KEY_VECTOR_CASES {
            return Err(ResidencyKeyParseError::new(
                line_number,
                ResidencyKeyParseErrorKind::TooManyCases {
                    max_cases: MAX_RESIDENCY_KEY_VECTOR_CASES,
                },
            ));
        }

        let columns: Vec<&str> = line.split('|').collect();
        if columns.len() != COLUMN_COUNT {
            return Err(ResidencyKeyParseError::new(
                line_number,
                ResidencyKeyParseErrorKind::WrongColumnCount {
                    actual: columns.len(),
                },
            ));
        }

        let case_id = columns[0];
        if case_id.len() > MAX_RESIDENCY_KEY_VECTOR_CASE_ID_BYTES {
            return Err(ResidencyKeyParseError::new(
                line_number,
                ResidencyKeyParseErrorKind::CaseIdTooLong {
                    actual_bytes: case_id.len(),
                    max_bytes: MAX_RESIDENCY_KEY_VECTOR_CASE_ID_BYTES,
                },
            ));
        }
        if !is_canonical_case_id(case_id) {
            return Err(ResidencyKeyParseError::new(
                line_number,
                ResidencyKeyParseErrorKind::InvalidCaseId,
            ));
        }
        if !case_ids.insert(case_id) {
            return Err(ResidencyKeyParseError::new(
                line_number,
                ResidencyKeyParseErrorKind::DuplicateCaseId,
            ));
        }

        let scope = parse_hex(columns[1], "scope_hex", line_number, false)?;
        let access = parse_hex(columns[2], "access_hex", line_number, false)?;
        let confidentiality = parse_hex(columns[3], "confidentiality_hex", line_number, false)?;
        let encryption = parse_hex(columns[4], "encryption_hex", line_number, false)?;
        let retention = parse_hex(columns[5], "retention_hex", line_number, false)?;
        let erasure = parse_hex(columns[6], "erasure_hex", line_number, false)?;
        let digest = parse_hex(columns[7], "digest_hex", line_number, false)?;
        let expected = parse_expected(columns[8], columns[9], columns[10], line_number)?;

        cases.push(ResidencyKeyVector::new(
            case_id.to_owned(),
            scope,
            access,
            confidentiality,
            encryption,
            retention,
            erasure,
            digest,
            expected,
        ));
    }

    if cases.is_empty() {
        return Err(ResidencyKeyParseError::new(
            lines.last().map_or(1, |(line, _)| *line + 1),
            ResidencyKeyParseErrorKind::NoCases,
        ));
    }

    Ok(ResidencyKeyVectorSet::new(
        RESIDENCY_KEY_SCHEMA_GENERATION,
        cases,
    ))
}

fn require_header(
    lines: &[(usize, &str)],
    index: usize,
    expected: &'static str,
) -> Result<(), ResidencyKeyParseError> {
    let Some(&(line_number, actual)) = lines.get(index) else {
        return Err(ResidencyKeyParseError::new(
            index + 1,
            ResidencyKeyParseErrorKind::MissingHeader { expected },
        ));
    };
    if actual != expected {
        return Err(ResidencyKeyParseError::new(
            line_number,
            ResidencyKeyParseErrorKind::UnexpectedHeader { expected },
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

fn parse_expected(
    token: &str,
    output_hex: &str,
    error_code: &str,
    line: usize,
) -> Result<ResidencyKeyExpectedOutcome, ResidencyKeyParseError> {
    match token {
        "ok" => {
            if error_code != "-" {
                return Err(ResidencyKeyParseError::new(
                    line,
                    ResidencyKeyParseErrorKind::InconsistentOutcome,
                ));
            }
            let output = parse_hex(output_hex, "output_hex", line, true)?;
            if !is_canonical_output(&output) {
                return Err(ResidencyKeyParseError::new(
                    line,
                    ResidencyKeyParseErrorKind::InvalidOutputShape,
                ));
            }
            Ok(ResidencyKeyExpectedOutcome::Success { output })
        }
        "error" => {
            if output_hex != "-" {
                return Err(ResidencyKeyParseError::new(
                    line,
                    ResidencyKeyParseErrorKind::InconsistentOutcome,
                ));
            }
            Ok(ResidencyKeyExpectedOutcome::Error(parse_error_code(
                error_code, line,
            )?))
        }
        _ => Err(ResidencyKeyParseError::new(
            line,
            ResidencyKeyParseErrorKind::InvalidExpectedOutcome,
        )),
    }
}

fn parse_error_code(
    code: &str,
    line: usize,
) -> Result<ResidencyKeyExpectedError, ResidencyKeyParseError> {
    let error = match code {
        RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE => {
            ResidencyKeyExpectedError::IdentifierInputTooLarge
        }
        RESIDENCY_KEY_UTF8_CODE => ResidencyKeyExpectedError::InvalidUtf8,
        RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE => ResidencyKeyExpectedError::EmptyIdentifier,
        RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE => ResidencyKeyExpectedError::IdentifierTooLong,
        RESIDENCY_KEY_DIGEST_LENGTH_CODE => ResidencyKeyExpectedError::DigestLength,
        RESIDENCY_KEY_DIGEST_ALPHABET_CODE => ResidencyKeyExpectedError::DigestAlphabet,
        _ => {
            return Err(ResidencyKeyParseError::new(
                line,
                ResidencyKeyParseErrorKind::UnknownErrorCode,
            ));
        }
    };
    Ok(error)
}

fn parse_hex(
    value: &str,
    field: &'static str,
    line: usize,
    output: bool,
) -> Result<Vec<u8>, ResidencyKeyParseError> {
    if value == "-" {
        return Ok(Vec::new());
    }
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err(ResidencyKeyParseError::new(
            line,
            ResidencyKeyParseErrorKind::InvalidHex { field },
        ));
    }

    let decoded_bytes = value.len() / 2;
    let max_bytes = if output {
        MAX_RESIDENCY_KEY_VECTOR_OUTPUT_BYTES
    } else {
        MAX_RESIDENCY_KEY_VECTOR_FIELD_BYTES
    };
    if decoded_bytes > max_bytes {
        return Err(ResidencyKeyParseError::new(
            line,
            ResidencyKeyParseErrorKind::FieldTooLarge {
                field,
                actual_bytes: decoded_bytes,
                max_bytes,
            },
        ));
    }

    let mut bytes = Vec::with_capacity(decoded_bytes);
    for pair in value.as_bytes().as_chunks::<2>().0 {
        let (Some(high), Some(low)) = (hex_nibble(pair[0]), hex_nibble(pair[1])) else {
            return Err(ResidencyKeyParseError::new(
                line,
                ResidencyKeyParseErrorKind::InvalidHex { field },
            ));
        };
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn is_canonical_output(output: &[u8]) -> bool {
    let Ok(text) = core::str::from_utf8(output) else {
        return false;
    };
    let segments: Vec<&str> = text.split('/').collect();
    if segments.len() != 9
        || segments[0] != OBJECT_RESIDENCY_KEY_VERSION
        || segments[7] != OBJECT_RESIDENCY_KEY_DIGEST_ALGORITHM
        || segments[1..7].iter().any(|segment| segment.is_empty())
        || segments[8].len() != 64
        || !segments[8]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return false;
    }
    segments[1..7]
        .iter()
        .all(|segment| is_canonical_component(segment.as_bytes()))
}

fn is_canonical_component(input: &[u8]) -> bool {
    let mut decoded = Vec::with_capacity(input.len());
    let mut offset = 0;
    while offset < input.len() {
        let byte = input[offset];
        if is_component_unescaped(byte) {
            decoded.push(byte);
            offset += 1;
            continue;
        }
        if byte != b'%' || offset + 2 >= input.len() {
            return false;
        }
        let (Some(high), Some(low)) = (
            upper_hex_nibble(input[offset + 1]),
            upper_hex_nibble(input[offset + 2]),
        ) else {
            return false;
        };
        let decoded_byte = (high << 4) | low;
        if is_component_unescaped(decoded_byte) {
            return false;
        }
        decoded.push(decoded_byte);
        offset += 3;
    }
    core::str::from_utf8(&decoded).is_ok()
}

const fn is_component_unescaped(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

const fn upper_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
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
    use super::{ResidencyKeyParseErrorKind, parse_residency_key_vector_set};
    use crate::{RESIDENCY_KEY_COLUMNS_HEADER, RESIDENCY_KEY_PROTOCOL_HEADER};

    const DIGEST_HEX: &str = "30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";
    const OUTPUT_HEX: &str = "6f626a6563742d7265736964656e63792d6b65792e76312f732f612f632f6b2f722f652f7368613235362f30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";

    fn frame(row: &str) -> String {
        format!(
            "{RESIDENCY_KEY_PROTOCOL_HEADER}\n# schema_generation=1\n{RESIDENCY_KEY_COLUMNS_HEADER}\n{row}\n"
        )
    }

    fn success_row() -> String {
        format!("ascii|73|61|63|6b|72|65|{DIGEST_HEX}|ok|{OUTPUT_HEX}|-")
    }

    #[test]
    fn parses_one_canonical_case() {
        let parsed = parse_residency_key_vector_set(&frame(&success_row()));
        assert!(matches!(parsed, Ok(set) if set.cases().len() == 1));
    }

    #[test]
    fn rejects_headers_blanks_shape_identity_and_duplicates() {
        assert!(matches!(
            parse_residency_key_vector_set(""),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::MissingHeader { .. })
        ));
        assert!(matches!(
            parse_residency_key_vector_set(&frame(&format!("\n{}", success_row()))),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::UnexpectedBlankLine)
        ));
        assert!(matches!(
            parse_residency_key_vector_set(&frame("broken|73")),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::WrongColumnCount { .. })
        ));
        assert!(matches!(
            parse_residency_key_vector_set(&frame(&success_row().replacen("ascii", "Bad-Id", 1))),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::InvalidCaseId)
        ));
        let duplicate = format!("{}{}", frame(&success_row()), success_row());
        assert!(matches!(
            parse_residency_key_vector_set(&duplicate),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::DuplicateCaseId)
        ));
    }

    #[test]
    fn rejects_hex_outcome_error_and_output_shape_failures() {
        assert!(matches!(
            parse_residency_key_vector_set(&frame(&success_row().replacen("|73|", "|0A|", 1))),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::InvalidHex { .. })
        ));
        assert!(matches!(
            parse_residency_key_vector_set(&frame(&success_row().replace("|ok|", "|maybe|"))),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::InvalidExpectedOutcome)
        ));
        let unknown = format!("unknown|73|61|63|6b|72|65|{DIGEST_HEX}|error|-|ELIOTR_UNKNOWN");
        assert!(matches!(
            parse_residency_key_vector_set(&frame(&unknown)),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::UnknownErrorCode)
        ));
        let invalid_output = format!("output|73|61|63|6b|72|65|{DIGEST_HEX}|ok|61|-");
        assert!(matches!(
            parse_residency_key_vector_set(&frame(&invalid_output)),
            Err(error) if matches!(error.kind(), ResidencyKeyParseErrorKind::InvalidOutputShape)
        ));
    }
}
