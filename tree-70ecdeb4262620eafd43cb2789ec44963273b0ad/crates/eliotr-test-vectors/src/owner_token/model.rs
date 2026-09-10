//! Typed representation of the `owner-token.v1` conformance corpus.
//!
//! The family binds the ER-44 initial owner token: the canonical JSON tuple
//! `["eliotr.source-owner.initial.v1", namespace, "eliotr", incarnation, 1, "ACTIVE"]`,
//! UTF-8 bytes, full lowercase SHA-256, `owner-` prefix. Policy revisions and principals
//! have no position in the preimage, so policy-only changes leave the token stable.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    OWNER_TOKEN_ALPHABET_CODE, OWNER_TOKEN_INCARNATION_CODE, OWNER_TOKEN_INPUT_TOO_LARGE_CODE,
    OWNER_TOKEN_LENGTH_CODE, OWNER_TOKEN_NAMESPACE_CODE, OWNER_TOKEN_OWNER_CODE,
    OWNER_TOKEN_PREFIX_CODE, OWNER_TOKEN_REVISION_CODE, OWNER_TOKEN_SCHEMA_CODE,
    OWNER_TOKEN_SHAPE_CODE, OWNER_TOKEN_STATE_CODE, OWNER_TOKEN_SYNTAX_CODE,
    OWNER_TOKEN_UNICODE_CODE, OWNER_TOKEN_UTF8_CODE,
};

/// Exact owner-token vector protocol.
pub const OWNER_TOKEN_PROTOCOL: &str = "eliotr.test-vectors.owner-token.v1";
/// Exact protocol header.
pub const OWNER_TOKEN_PROTOCOL_HEADER: &str = "# protocol=eliotr.test-vectors.owner-token.v1";
/// Exact schema generation.
pub const OWNER_TOKEN_SCHEMA_GENERATION: u32 = 1;
/// Exact columns header.
pub const OWNER_TOKEN_COLUMNS_HEADER: &str =
    "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

pub(crate) const MAX_OWNER_TOKEN_VECTOR_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_OWNER_TOKEN_VECTOR_CASES: usize = 4096;
pub(crate) const MAX_OWNER_TOKEN_VECTOR_CASE_ID_BYTES: usize = 128;
pub(crate) const MAX_OWNER_TOKEN_VECTOR_PAYLOAD_BYTES: usize = 256 * 1024;

/// One parsed owner-token corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerTokenVectorSet {
    schema_generation: u32,
    cases: Vec<OwnerTokenVector>,
}

impl OwnerTokenVectorSet {
    pub(crate) fn new(schema_generation: u32, cases: Vec<OwnerTokenVector>) -> Self {
        Self {
            schema_generation,
            cases,
        }
    }

    /// Returns the admitted schema generation.
    #[must_use]
    pub const fn schema_generation(&self) -> u32 {
        self.schema_generation
    }

    /// Returns cases in declared order.
    #[must_use]
    pub fn cases(&self) -> &[OwnerTokenVector] {
        &self.cases
    }
}

/// Operation admitted by the owner-token fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerTokenOperation {
    /// Derive `owner-` from candidate tuple bytes.
    DeriveOwnerToken,
    /// Validate a complete `owner-` token.
    ValidateOwnerToken,
}

impl OwnerTokenOperation {
    #[cfg(test)]
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Self::DeriveOwnerToken => "derive_owner_token",
            Self::ValidateOwnerToken => "validate_owner_token",
        }
    }
}

/// One strict owner-token case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerTokenVector {
    case_id: String,
    operation: OwnerTokenOperation,
    input: Vec<u8>,
    expected: OwnerTokenExpectedOutcome,
}

impl OwnerTokenVector {
    pub(crate) fn new(
        case_id: String,
        operation: OwnerTokenOperation,
        input: Vec<u8>,
        expected: OwnerTokenExpectedOutcome,
    ) -> Self {
        Self {
            case_id,
            operation,
            input,
            expected,
        }
    }

    /// Returns the fixture-local identity.
    #[must_use]
    pub fn case_id(&self) -> &str {
        &self.case_id
    }

    /// Returns the operation.
    #[must_use]
    pub const fn operation(&self) -> OwnerTokenOperation {
        self.operation
    }

    /// Returns exact input bytes.
    #[must_use]
    pub fn input(&self) -> &[u8] {
        &self.input
    }

    /// Returns the expected result.
    #[must_use]
    pub const fn expected(&self) -> &OwnerTokenExpectedOutcome {
        &self.expected
    }
}

/// Expected execution result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerTokenExpectedOutcome {
    /// Operation succeeds with these exact bytes.
    Success {
        /// Exact output bytes.
        output: Vec<u8>,
    },
    /// Operation returns this stable typed error.
    Error(OwnerTokenExpectedError),
}

/// Owner-token error vocabulary admitted by the fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerTokenExpectedError {
    InputTooLarge,
    InvalidUtf8,
    Syntax,
    Unicode,
    Shape,
    Schema,
    Namespace,
    Incarnation,
    Owner,
    Revision,
    State,
    InvalidLength,
    Prefix,
    InvalidAlphabet,
}

impl OwnerTokenExpectedError {
    /// Returns the exact kernel error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge => OWNER_TOKEN_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 => OWNER_TOKEN_UTF8_CODE,
            Self::Syntax => OWNER_TOKEN_SYNTAX_CODE,
            Self::Unicode => OWNER_TOKEN_UNICODE_CODE,
            Self::Shape => OWNER_TOKEN_SHAPE_CODE,
            Self::Schema => OWNER_TOKEN_SCHEMA_CODE,
            Self::Namespace => OWNER_TOKEN_NAMESPACE_CODE,
            Self::Incarnation => OWNER_TOKEN_INCARNATION_CODE,
            Self::Owner => OWNER_TOKEN_OWNER_CODE,
            Self::Revision => OWNER_TOKEN_REVISION_CODE,
            Self::State => OWNER_TOKEN_STATE_CODE,
            Self::InvalidLength => OWNER_TOKEN_LENGTH_CODE,
            Self::Prefix => OWNER_TOKEN_PREFIX_CODE,
            Self::InvalidAlphabet => OWNER_TOKEN_ALPHABET_CODE,
        }
    }

    pub(crate) const fn compatible_with(self, operation: OwnerTokenOperation) -> bool {
        match operation {
            OwnerTokenOperation::DeriveOwnerToken => matches!(
                self,
                Self::InputTooLarge
                    | Self::InvalidUtf8
                    | Self::Syntax
                    | Self::Unicode
                    | Self::Shape
                    | Self::Schema
                    | Self::Namespace
                    | Self::Incarnation
                    | Self::Owner
                    | Self::Revision
                    | Self::State
            ),
            OwnerTokenOperation::ValidateOwnerToken => matches!(
                self,
                Self::InvalidUtf8 | Self::InvalidLength | Self::Prefix | Self::InvalidAlphabet
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{OWNER_TOKEN_PROTOCOL, OWNER_TOKEN_PROTOCOL_HEADER, OwnerTokenExpectedError};

    use super::OwnerTokenOperation;

    #[test]
    fn protocol_operations_and_codes_are_stable() {
        assert_eq!(
            OWNER_TOKEN_PROTOCOL_HEADER,
            format!("# protocol={OWNER_TOKEN_PROTOCOL}")
        );
        assert_eq!(
            OwnerTokenOperation::DeriveOwnerToken.token(),
            "derive_owner_token"
        );
        assert_eq!(
            OwnerTokenOperation::ValidateOwnerToken.token(),
            "validate_owner_token"
        );

        let derive_errors = [
            OwnerTokenExpectedError::InputTooLarge,
            OwnerTokenExpectedError::InvalidUtf8,
            OwnerTokenExpectedError::Syntax,
            OwnerTokenExpectedError::Unicode,
            OwnerTokenExpectedError::Shape,
            OwnerTokenExpectedError::Schema,
            OwnerTokenExpectedError::Namespace,
            OwnerTokenExpectedError::Incarnation,
            OwnerTokenExpectedError::Owner,
            OwnerTokenExpectedError::Revision,
            OwnerTokenExpectedError::State,
        ];
        for error in derive_errors {
            assert!(error.code().starts_with("ELIOTR_OWNER_TOKEN_"));
            assert!(error.compatible_with(OwnerTokenOperation::DeriveOwnerToken));
        }

        let validate_errors = [
            OwnerTokenExpectedError::InvalidUtf8,
            OwnerTokenExpectedError::InvalidLength,
            OwnerTokenExpectedError::Prefix,
            OwnerTokenExpectedError::InvalidAlphabet,
        ];
        for error in validate_errors {
            assert!(error.compatible_with(OwnerTokenOperation::ValidateOwnerToken));
        }
    }
}
