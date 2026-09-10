//! Typed representation of the `scope-snapshot-identity.v1` conformance corpus.
//!
//! The family binds `scopeSnapshotIdentityPayload`, `scopeSnapshotDigestPayload` and
//! `expectedSnapshotIdentity`: canonical identity bytes, SHA-256, `scope-` stable IDs
//! and snapshot digests, with typed content-free errors. No normalization, resolution,
//! persistence, expiry or D1 logic is ported; TypeScript remains the product authority.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    SNAPSHOT_DEPTH_LIMIT_CODE, SNAPSHOT_DIGEST_CODE, SNAPSHOT_DIGEST_MISMATCH_CODE,
    SNAPSHOT_DUPLICATE_KEY_CODE, SNAPSHOT_EXPRESSION_CODE, SNAPSHOT_ID_MISMATCH_CODE,
    SNAPSHOT_IDENTIFIER_CODE, SNAPSHOT_INPUT_TOO_LARGE_CODE, SNAPSHOT_MEMBER_LIMIT_CODE,
    SNAPSHOT_MISSING_FIELD_CODE, SNAPSHOT_NODE_LIMIT_CODE, SNAPSHOT_NUMBER_CODE,
    SNAPSHOT_OUTPUT_TOO_LARGE_CODE, SNAPSHOT_REVISION_CODE, SNAPSHOT_SHAPE_CODE,
    SNAPSHOT_STRING_TOO_LARGE_CODE, SNAPSHOT_SYNTAX_CODE, SNAPSHOT_TIMESTAMP_CODE,
    SNAPSHOT_UNICODE_CODE, SNAPSHOT_UNKNOWN_FIELD_CODE, SNAPSHOT_UTF8_CODE,
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

/// Operation admitted by the fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeSnapshotIdentityOperation {
    DeriveSnapshotIdentity,
    VerifySnapshotIdentity,
}

impl ScopeSnapshotIdentityOperation {
    #[cfg(test)]
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Self::DeriveSnapshotIdentity => "derive_snapshot_identity",
            Self::VerifySnapshotIdentity => "verify_snapshot_identity",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
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

    pub(crate) fn parse(text: &str) -> Option<Self> {
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

    pub(crate) const fn compatible_with(self, operation: ScopeSnapshotIdentityOperation) -> bool {
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

    pub(crate) fn new(
        case_id: String,
        operation: ScopeSnapshotIdentityOperation,
        input: Vec<u8>,
        expected: ScopeSnapshotIdentityExpectedOutcome,
    ) -> Self {
        Self {
            case_id,
            operation,
            input,
            expected,
        }
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

    pub(crate) fn new(cases: Vec<ScopeSnapshotIdentityVector>) -> Self {
        Self { cases }
    }
}
