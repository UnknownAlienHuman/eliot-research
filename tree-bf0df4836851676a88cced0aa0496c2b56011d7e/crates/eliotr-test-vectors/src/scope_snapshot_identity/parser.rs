//! Strict frame parser for the `scope-snapshot-identity.v1` conformance corpus.
//!
//! The transport is line-oriented with three exact headers followed by one row per
//! case. Rejections are location-bearing and content-free: line numbers, budgets
//! and column counts only.

#![forbid(unsafe_code)]

use core::fmt;
use std::collections::BTreeSet;

use eliotr_canonical::verify_snapshot_identity;

use super::model::{
    MAX_CASE_ID_BYTES, MAX_CASES, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES,
    SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER, SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER,
    ScopeSnapshotIdentityExpectedError, ScopeSnapshotIdentityExpectedOutcome,
    ScopeSnapshotIdentityOperation, ScopeSnapshotIdentityVector, ScopeSnapshotIdentityVectorSet,
};

/// Location-bearing, content-free fixture rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeSnapshotIdentityParseError {
    line: usize,
    kind: ScopeSnapshotIdentityParseErrorKind,
}

/// Exact reason a scope-snapshot-identity frame was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeSnapshotIdentityParseErrorKind {
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

impl fmt::Display for ScopeSnapshotIdentityParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid scope-snapshot-identity vector frame at line {}: {:?}",
            self.line, self.kind
        )
    }
}

impl std::error::Error for ScopeSnapshotIdentityParseError {}

fn parse_error(
    line: usize,
    kind: ScopeSnapshotIdentityParseErrorKind,
) -> ScopeSnapshotIdentityParseError {
    ScopeSnapshotIdentityParseError { line, kind }
}

fn is_valid_case_id(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let mut chars = text.chars();
    if chars.next().is_none_or(|c| !c.is_ascii_lowercase()) {
        return false;
    }
    text.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn decode_hex(
    text: &str,
    field: &'static str,
    line: usize,
) -> Result<Vec<u8>, ScopeSnapshotIdentityParseError> {
    if text == "-" {
        return Ok(Vec::new());
    }
    if text.is_empty()
        || !text.len().is_multiple_of(2)
        || !text
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && (b.is_ascii_digit() || b.is_ascii_lowercase()))
    {
        return Err(parse_error(
            line,
            ScopeSnapshotIdentityParseErrorKind::InvalidHex { field },
        ));
    }
    if text.bytes().any(|b| matches!(b, b'A'..=b'F')) {
        return Err(parse_error(
            line,
            ScopeSnapshotIdentityParseErrorKind::InvalidHex { field },
        ));
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_val(bytes[i]);
        let lo = hex_val(bytes[i + 1]);
        out.push(hi * 16 + lo);
        i += 2;
    }
    if out.len() > MAX_PAYLOAD_BYTES {
        return Err(parse_error(
            line,
            ScopeSnapshotIdentityParseErrorKind::PayloadTooLarge {
                field,
                actual_bytes: out.len(),
                max_bytes: MAX_PAYLOAD_BYTES,
            },
        ));
    }
    Ok(out)
}

fn hex_val(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        _ => 0,
    }
}

fn check_output_shape(output: &[u8], line: usize) -> Result<(), ScopeSnapshotIdentityParseError> {
    let invalid = || {
        parse_error(
            line,
            ScopeSnapshotIdentityParseErrorKind::InvalidOutputShape,
        )
    };
    // The output must be the canonical full snapshot: a JSON object carrying a well-formed
    // `scope-` identifier and a lowercase digest, and it must verify idempotently.
    let text = core::str::from_utf8(output).map_err(|_| invalid())?;
    if !text.starts_with('{') || !text.ends_with('}') {
        return Err(invalid());
    }
    let id_key = "\"snapshot_id\":\"";
    let digest_key = "\"digest\":\"";
    let id_start = text.find(id_key).ok_or_else(invalid)? + id_key.len();
    let id_end = text
        .get(id_start..)
        .and_then(|r| r.find('"'))
        .map(|o| id_start + o)
        .ok_or_else(invalid)?;
    let digest_start = text.find(digest_key).ok_or_else(invalid)? + digest_key.len();
    let digest_end = text
        .get(digest_start..)
        .and_then(|r| r.find('"'))
        .map(|o| digest_start + o)
        .ok_or_else(invalid)?;
    let id = text.get(id_start..id_end).ok_or_else(invalid)?;
    let digest = text.get(digest_start..digest_end).ok_or_else(invalid)?;
    if id.len() != 54
        || !id.starts_with("scope-")
        || !id.as_bytes()[6..]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(invalid());
    }
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(invalid());
    }
    if verify_snapshot_identity(output).is_err() {
        return Err(invalid());
    }
    Ok(())
}

/// Parses a strict scope-snapshot-identity frame.
///
/// # Errors
///
/// Returns a location-bearing, content-free error for malformed frames.
pub fn parse_scope_snapshot_identity_vector_set(
    source: &str,
) -> Result<ScopeSnapshotIdentityVectorSet, ScopeSnapshotIdentityParseError> {
    let normalized = source.replace("\r\n", "\n");
    if normalized.len() > MAX_FRAME_BYTES {
        return Err(parse_error(
            0,
            ScopeSnapshotIdentityParseErrorKind::FrameTooLarge {
                actual_bytes: normalized.len(),
                max_bytes: MAX_FRAME_BYTES,
            },
        ));
    }
    let mut lines: Vec<&str> = normalized.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let headers = [
        SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER,
        "# schema_generation=1",
        SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER,
    ];
    for (index, expected) in headers.iter().enumerate() {
        let Some(actual) = lines.get(index) else {
            return Err(parse_error(
                index + 1,
                ScopeSnapshotIdentityParseErrorKind::MissingHeader { expected },
            ));
        };
        if actual != expected {
            return Err(parse_error(
                index + 1,
                ScopeSnapshotIdentityParseErrorKind::UnexpectedHeader { expected },
            ));
        }
    }
    let mut cases = Vec::new();
    let mut case_ids = BTreeSet::new();
    for (offset, line) in lines.iter().skip(3).enumerate() {
        let line_number = offset + 4;
        if line.is_empty() {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::UnexpectedBlankLine,
            ));
        }
        if line.starts_with('#') {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::UnexpectedHeader {
                    expected: SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER,
                },
            ));
        }
        if cases.len() >= MAX_CASES {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::TooManyCases {
                    max_cases: MAX_CASES,
                },
            ));
        }
        let columns: Vec<&str> = line.split('|').collect();
        if columns.len() != 6 {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::WrongColumnCount {
                    actual: columns.len(),
                },
            ));
        }
        let (case_id, operation, input_hex, expected, output_hex, error_code) = (
            columns[0], columns[1], columns[2], columns[3], columns[4], columns[5],
        );
        if case_id.len() > MAX_CASE_ID_BYTES {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::CaseIdTooLong {
                    actual_bytes: case_id.len(),
                    max_bytes: MAX_CASE_ID_BYTES,
                },
            ));
        }
        if !is_valid_case_id(case_id) {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::InvalidCaseId,
            ));
        }
        if !case_ids.insert(case_id.to_owned()) {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::DuplicateCaseId,
            ));
        }
        let Some(op) = ScopeSnapshotIdentityOperation::parse(operation) else {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::InvalidOperation,
            ));
        };
        let input = decode_hex(input_hex, "input_hex", line_number)?;
        if expected == "ok" {
            if error_code != "-" {
                return Err(parse_error(
                    line_number,
                    ScopeSnapshotIdentityParseErrorKind::InconsistentOutcome,
                ));
            }
            let output = decode_hex(output_hex, "output_hex", line_number)?;
            check_output_shape(&output, line_number)?;
            cases.push(ScopeSnapshotIdentityVector::new(
                case_id.to_owned(),
                op,
                input,
                ScopeSnapshotIdentityExpectedOutcome::Success { output },
            ));
        } else if expected == "error" {
            if output_hex != "-" {
                return Err(parse_error(
                    line_number,
                    ScopeSnapshotIdentityParseErrorKind::InconsistentOutcome,
                ));
            }
            let Some(code) = ScopeSnapshotIdentityExpectedError::parse(error_code) else {
                return Err(parse_error(
                    line_number,
                    ScopeSnapshotIdentityParseErrorKind::UnknownErrorCode,
                ));
            };
            if !code.compatible_with(op) {
                return Err(parse_error(
                    line_number,
                    ScopeSnapshotIdentityParseErrorKind::IncompatibleError,
                ));
            }
            cases.push(ScopeSnapshotIdentityVector::new(
                case_id.to_owned(),
                op,
                input,
                ScopeSnapshotIdentityExpectedOutcome::Error(code),
            ));
        } else {
            return Err(parse_error(
                line_number,
                ScopeSnapshotIdentityParseErrorKind::InvalidExpectedOutcome,
            ));
        }
    }
    if cases.is_empty() {
        return Err(parse_error(4, ScopeSnapshotIdentityParseErrorKind::NoCases));
    }
    Ok(ScopeSnapshotIdentityVectorSet::new(cases))
}
