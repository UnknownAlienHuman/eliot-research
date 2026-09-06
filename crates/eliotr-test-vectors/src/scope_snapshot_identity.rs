//! Strict `scope-snapshot-identity.v1` vectors shared by TypeScript, native Rust and Rust/Wasm.
//!
//! The family binds `scopeSnapshotIdentityPayload`, `scopeSnapshotDigestPayload` and
//! `expectedSnapshotIdentity`: canonical identity bytes, SHA-256, `scope-` stable IDs and
//! snapshot digests, with typed content-free errors. No normalization, resolution,
//! persistence, expiry or D1 logic is ported; TypeScript remains the product authority.

#![forbid(unsafe_code)]

use core::fmt;
use std::collections::BTreeSet;

use eliotr_canonical::{
    SNAPSHOT_DEPTH_LIMIT_CODE, SNAPSHOT_DIGEST_CODE, SNAPSHOT_DIGEST_MISMATCH_CODE,
    SNAPSHOT_DUPLICATE_KEY_CODE, SNAPSHOT_EXPRESSION_CODE, SNAPSHOT_ID_MISMATCH_CODE,
    SNAPSHOT_IDENTIFIER_CODE, SNAPSHOT_INPUT_TOO_LARGE_CODE, SNAPSHOT_MEMBER_LIMIT_CODE,
    SNAPSHOT_MISSING_FIELD_CODE, SNAPSHOT_NODE_LIMIT_CODE, SNAPSHOT_NUMBER_CODE,
    SNAPSHOT_OUTPUT_TOO_LARGE_CODE, SNAPSHOT_REVISION_CODE, SNAPSHOT_SHAPE_CODE,
    SNAPSHOT_STRING_TOO_LARGE_CODE, SNAPSHOT_SYNTAX_CODE, SNAPSHOT_TIMESTAMP_CODE,
    SNAPSHOT_UNICODE_CODE, SNAPSHOT_UNKNOWN_FIELD_CODE, SNAPSHOT_UTF8_CODE,
    derive_snapshot_identity, verify_snapshot_identity,
};

/// Exact scope-snapshot-identity vector protocol.
pub const SCOPE_SNAPSHOT_IDENTITY_PROTOCOL: &str = "eliotr.test-vectors.scope-snapshot-identity.v1";
/// Exact protocol header.
pub const SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER: &str =
    "# protocol=eliotr.test-vectors.scope-snapshot-identity.v1";
/// Exact schema generation.
pub const SCOPE_SNAPSHOT_IDENTITY_SCHEMA_GENERATION: u32 = 1;
/// Exact columns header.
pub const SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER: &str =
    "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_CASES: usize = 4096;
pub(crate) const MAX_CASE_ID_BYTES: usize = 128;
pub(crate) const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

/// Exact committed `scope-snapshot-identity.v1` fixture bytes.
pub const EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS: &str =
    include_str!("../fixtures/scope-snapshot-identity.v1.txt");

/// Operation admitted by the fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeSnapshotIdentityOperation {
    DeriveSnapshotIdentity,
    VerifySnapshotIdentity,
}

impl ScopeSnapshotIdentityOperation {
    #[cfg(test)]
    const fn token(self) -> &'static str {
        match self {
            Self::DeriveSnapshotIdentity => "derive_snapshot_identity",
            Self::VerifySnapshotIdentity => "verify_snapshot_identity",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "derive_snapshot_identity" => Some(Self::DeriveSnapshotIdentity),
            "verify_snapshot_identity" => Some(Self::VerifySnapshotIdentity),
            _ => None,
        }
    }
}

/// Expected execution result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeSnapshotIdentityExpectedOutcome {
    Success { output: Vec<u8> },
    Error(ScopeSnapshotIdentityExpectedError),
}

/// Error vocabulary admitted by the fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeSnapshotIdentityExpectedError {
    InputTooLarge,
    InvalidUtf8,
    Syntax,
    DuplicateKey,
    Unicode,
    Number,
    DepthLimit,
    MemberLimit,
    NodeLimit,
    StringTooLarge,
    OutputTooLarge,
    Shape,
    MissingField,
    UnknownField,
    Identifier,
    Digest,
    Revision,
    Timestamp,
    Expression,
    IdMismatch,
    DigestMismatch,
}

impl ScopeSnapshotIdentityExpectedError {
    /// Returns the exact kernel error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge => SNAPSHOT_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 => SNAPSHOT_UTF8_CODE,
            Self::Syntax => SNAPSHOT_SYNTAX_CODE,
            Self::DuplicateKey => SNAPSHOT_DUPLICATE_KEY_CODE,
            Self::Unicode => SNAPSHOT_UNICODE_CODE,
            Self::Number => SNAPSHOT_NUMBER_CODE,
            Self::DepthLimit => SNAPSHOT_DEPTH_LIMIT_CODE,
            Self::MemberLimit => SNAPSHOT_MEMBER_LIMIT_CODE,
            Self::NodeLimit => SNAPSHOT_NODE_LIMIT_CODE,
            Self::StringTooLarge => SNAPSHOT_STRING_TOO_LARGE_CODE,
            Self::OutputTooLarge => SNAPSHOT_OUTPUT_TOO_LARGE_CODE,
            Self::Shape => SNAPSHOT_SHAPE_CODE,
            Self::MissingField => SNAPSHOT_MISSING_FIELD_CODE,
            Self::UnknownField => SNAPSHOT_UNKNOWN_FIELD_CODE,
            Self::Identifier => SNAPSHOT_IDENTIFIER_CODE,
            Self::Digest => SNAPSHOT_DIGEST_CODE,
            Self::Revision => SNAPSHOT_REVISION_CODE,
            Self::Timestamp => SNAPSHOT_TIMESTAMP_CODE,
            Self::Expression => SNAPSHOT_EXPRESSION_CODE,
            Self::IdMismatch => SNAPSHOT_ID_MISMATCH_CODE,
            Self::DigestMismatch => SNAPSHOT_DIGEST_MISMATCH_CODE,
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "ELIOTR_SNAPSHOT_INPUT_TOO_LARGE" => Some(Self::InputTooLarge),
            "ELIOTR_SNAPSHOT_UTF8" => Some(Self::InvalidUtf8),
            "ELIOTR_SNAPSHOT_SYNTAX" => Some(Self::Syntax),
            "ELIOTR_SNAPSHOT_DUPLICATE_KEY" => Some(Self::DuplicateKey),
            "ELIOTR_SNAPSHOT_UNICODE" => Some(Self::Unicode),
            "ELIOTR_SNAPSHOT_NUMBER" => Some(Self::Number),
            "ELIOTR_SNAPSHOT_DEPTH_LIMIT" => Some(Self::DepthLimit),
            "ELIOTR_SNAPSHOT_MEMBER_LIMIT" => Some(Self::MemberLimit),
            "ELIOTR_SNAPSHOT_NODE_LIMIT" => Some(Self::NodeLimit),
            "ELIOTR_SNAPSHOT_STRING_TOO_LARGE" => Some(Self::StringTooLarge),
            "ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE" => Some(Self::OutputTooLarge),
            "ELIOTR_SNAPSHOT_SHAPE" => Some(Self::Shape),
            "ELIOTR_SNAPSHOT_MISSING_FIELD" => Some(Self::MissingField),
            "ELIOTR_SNAPSHOT_UNKNOWN_FIELD" => Some(Self::UnknownField),
            "ELIOTR_SNAPSHOT_IDENTIFIER" => Some(Self::Identifier),
            "ELIOTR_SNAPSHOT_DIGEST" => Some(Self::Digest),
            "ELIOTR_SNAPSHOT_REVISION" => Some(Self::Revision),
            "ELIOTR_SNAPSHOT_TIMESTAMP" => Some(Self::Timestamp),
            "ELIOTR_SNAPSHOT_EXPRESSION" => Some(Self::Expression),
            "ELIOTR_SNAPSHOT_ID_MISMATCH" => Some(Self::IdMismatch),
            "ELIOTR_SNAPSHOT_DIGEST_MISMATCH" => Some(Self::DigestMismatch),
            _ => None,
        }
    }

    const fn compatible_with(self, operation: ScopeSnapshotIdentityOperation) -> bool {
        match operation {
            ScopeSnapshotIdentityOperation::DeriveSnapshotIdentity => {
                !matches!(self, Self::IdMismatch | Self::DigestMismatch)
            }
            ScopeSnapshotIdentityOperation::VerifySnapshotIdentity => true,
        }
    }
}

/// One strict scope-snapshot-identity case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeSnapshotIdentityVector {
    case_id: String,
    operation: ScopeSnapshotIdentityOperation,
    input: Vec<u8>,
    expected: ScopeSnapshotIdentityExpectedOutcome,
}

impl ScopeSnapshotIdentityVector {
    /// Returns the fixture-local identity.
    #[must_use]
    pub fn case_id(&self) -> &str {
        &self.case_id
    }

    /// Returns the operation.
    #[must_use]
    pub const fn operation(&self) -> ScopeSnapshotIdentityOperation {
        self.operation
    }

    /// Returns exact input bytes.
    #[must_use]
    pub fn input(&self) -> &[u8] {
        &self.input
    }

    /// Returns the expected result.
    #[must_use]
    pub const fn expected(&self) -> &ScopeSnapshotIdentityExpectedOutcome {
        &self.expected
    }
}

/// One parsed scope-snapshot-identity corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeSnapshotIdentityVectorSet {
    cases: Vec<ScopeSnapshotIdentityVector>,
}

impl ScopeSnapshotIdentityVectorSet {
    /// Returns cases in declared order.
    #[must_use]
    pub fn cases(&self) -> &[ScopeSnapshotIdentityVector] {
        &self.cases
    }
}

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
            cases.push(ScopeSnapshotIdentityVector {
                case_id: case_id.to_owned(),
                operation: op,
                input,
                expected: ScopeSnapshotIdentityExpectedOutcome::Success { output },
            });
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
            cases.push(ScopeSnapshotIdentityVector {
                case_id: case_id.to_owned(),
                operation: op,
                input,
                expected: ScopeSnapshotIdentityExpectedOutcome::Error(code),
            });
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
    Ok(ScopeSnapshotIdentityVectorSet { cases })
}

/// Parse or semantic mismatch without source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeSnapshotIdentityVerificationError {
    Parse(ScopeSnapshotIdentityParseError),
    UnexpectedError {
        case_id: String,
        actual_code: &'static str,
    },
    UnexpectedSuccess {
        case_id: String,
    },
    OutputMismatch {
        case_id: String,
    },
    ErrorCodeMismatch {
        case_id: String,
        expected_code: &'static str,
        actual_code: &'static str,
    },
}

impl fmt::Display for ScopeSnapshotIdentityVerificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(e) => e.fmt(f),
            Self::UnexpectedError {
                case_id,
                actual_code,
            } => write!(
                f,
                "scope-snapshot-identity vector {case_id} expected success but returned {actual_code}"
            ),
            Self::UnexpectedSuccess { case_id } => write!(
                f,
                "scope-snapshot-identity vector {case_id} expected an error but succeeded"
            ),
            Self::OutputMismatch { case_id } => write!(
                f,
                "scope-snapshot-identity vector {case_id} returned different output bytes"
            ),
            Self::ErrorCodeMismatch {
                case_id,
                expected_code,
                actual_code,
            } => write!(
                f,
                "scope-snapshot-identity vector {case_id} expected {expected_code} but returned {actual_code}"
            ),
        }
    }
}

impl std::error::Error for ScopeSnapshotIdentityVerificationError {}

impl From<ScopeSnapshotIdentityParseError> for ScopeSnapshotIdentityVerificationError {
    fn from(value: ScopeSnapshotIdentityParseError) -> Self {
        Self::Parse(value)
    }
}

enum ActualOutcome {
    Success(Vec<u8>),
    Error(&'static str),
}

fn execute(case: &ScopeSnapshotIdentityVector) -> ActualOutcome {
    match case.operation() {
        ScopeSnapshotIdentityOperation::DeriveSnapshotIdentity => {
            match derive_snapshot_identity(case.input()) {
                Ok(output) => ActualOutcome::Success(output),
                Err(error) => ActualOutcome::Error(error.code()),
            }
        }
        ScopeSnapshotIdentityOperation::VerifySnapshotIdentity => {
            match verify_snapshot_identity(case.input()) {
                Ok(output) => ActualOutcome::Success(output),
                Err(error) => ActualOutcome::Error(error.code()),
            }
        }
    }
}

/// Executes every declared scope-snapshot-identity vector in order.
///
/// # Errors
///
/// Returns the first deterministic semantic mismatch.
pub fn verify_scope_snapshot_identity_vector_set(
    set: &ScopeSnapshotIdentityVectorSet,
) -> Result<(), ScopeSnapshotIdentityVerificationError> {
    for case in set.cases() {
        let actual = execute(case);
        match (case.expected(), actual) {
            (
                ScopeSnapshotIdentityExpectedOutcome::Success { output },
                ActualOutcome::Success(actual_output),
            ) => {
                if actual_output.as_slice() != output.as_slice() {
                    return Err(ScopeSnapshotIdentityVerificationError::OutputMismatch {
                        case_id: case.case_id().to_owned(),
                    });
                }
            }
            (
                ScopeSnapshotIdentityExpectedOutcome::Success { .. },
                ActualOutcome::Error(actual_code),
            ) => {
                return Err(ScopeSnapshotIdentityVerificationError::UnexpectedError {
                    case_id: case.case_id().to_owned(),
                    actual_code,
                });
            }
            (ScopeSnapshotIdentityExpectedOutcome::Error(_), ActualOutcome::Success(_)) => {
                return Err(ScopeSnapshotIdentityVerificationError::UnexpectedSuccess {
                    case_id: case.case_id().to_owned(),
                });
            }
            (
                ScopeSnapshotIdentityExpectedOutcome::Error(expected),
                ActualOutcome::Error(actual_code),
            ) => {
                if expected.code() != actual_code {
                    return Err(ScopeSnapshotIdentityVerificationError::ErrorCodeMismatch {
                        case_id: case.case_id().to_owned(),
                        expected_code: expected.code(),
                        actual_code,
                    });
                }
            }
        }
    }
    Ok(())
}

/// Parses and executes the exact embedded scope-snapshot-identity corpus.
///
/// # Errors
///
/// Returns the first strict parse or semantic mismatch.
pub fn verify_embedded_scope_snapshot_identity_vectors()
-> Result<(), ScopeSnapshotIdentityVerificationError> {
    let vectors =
        parse_scope_snapshot_identity_vector_set(EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS)?;
    verify_scope_snapshot_identity_vector_set(&vectors)
}

#[cfg(test)]
mod tests {
    use super::ScopeSnapshotIdentityOperation;
    use super::verify_embedded_scope_snapshot_identity_vectors;

    #[test]
    fn scope_snapshot_identity_vectors_pass_natively() {
        assert_eq!(verify_embedded_scope_snapshot_identity_vectors(), Ok(()));
    }

    #[test]
    fn operation_tokens_are_stable() {
        assert_eq!(
            ScopeSnapshotIdentityOperation::DeriveSnapshotIdentity.token(),
            "derive_snapshot_identity"
        );
        assert_eq!(
            ScopeSnapshotIdentityOperation::VerifySnapshotIdentity.token(),
            "verify_snapshot_identity"
        );
    }
}
