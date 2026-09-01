//! Typed representation of the `stable-id.v1` conformance corpus.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    STABLE_ID_ALPHABET_CODE, STABLE_ID_INPUT_TOO_LARGE_CODE, STABLE_ID_LENGTH_CODE,
    STABLE_ID_NUL_CODE, STABLE_ID_PART_TOO_LARGE_CODE, STABLE_ID_PREFIX_CODE,
    STABLE_ID_PREFIX_TOO_LARGE_CODE, STABLE_ID_TOO_MANY_PARTS_CODE, STABLE_ID_UTF8_CODE,
};

/// Exact stable-ID vector protocol.
pub const STABLE_ID_PROTOCOL: &str = "eliotr.test-vectors.stable-id.v1";
/// Exact protocol header.
pub const STABLE_ID_PROTOCOL_HEADER: &str = "# protocol=eliotr.test-vectors.stable-id.v1";
/// Exact schema generation.
pub const STABLE_ID_SCHEMA_GENERATION: u32 = 1;
/// Exact columns header.
pub const STABLE_ID_COLUMNS_HEADER: &str =
    "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

pub(crate) const MAX_STABLE_ID_VECTOR_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_STABLE_ID_VECTOR_CASES: usize = 4096;
pub(crate) const MAX_STABLE_ID_VECTOR_CASE_ID_BYTES: usize = 128;
pub(crate) const MAX_STABLE_ID_VECTOR_PAYLOAD_BYTES: usize = 256 * 1024;

/// One parsed stable-ID corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StableIdVectorSet {
    schema_generation: u32,
    cases: Vec<StableIdVector>,
}

impl StableIdVectorSet {
    pub(crate) fn new(schema_generation: u32, cases: Vec<StableIdVector>) -> Self {
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
    pub fn cases(&self) -> &[StableIdVector] {
        &self.cases
    }
}

/// Operation admitted by the stable-ID fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StableIdOperation {
    /// Derive from exact `prefix [NUL part]*` bytes.
    DeriveStableId,
    /// Validate complete stable-ID text.
    ValidateStableId,
}

impl StableIdOperation {
    #[cfg(test)]
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Self::DeriveStableId => "derive_stable_id",
            Self::ValidateStableId => "validate_stable_id",
        }
    }
}

/// One strict stable-ID case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StableIdVector {
    case_id: String,
    operation: StableIdOperation,
    input: Vec<u8>,
    expected: StableIdExpectedOutcome,
}

impl StableIdVector {
    pub(crate) fn new(
        case_id: String,
        operation: StableIdOperation,
        input: Vec<u8>,
        expected: StableIdExpectedOutcome,
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
    pub const fn operation(&self) -> StableIdOperation {
        self.operation
    }

    /// Returns exact input bytes.
    #[must_use]
    pub fn input(&self) -> &[u8] {
        &self.input
    }

    /// Returns the expected result.
    #[must_use]
    pub const fn expected(&self) -> &StableIdExpectedOutcome {
        &self.expected
    }
}

/// Expected execution result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StableIdExpectedOutcome {
    /// Operation succeeds with these exact bytes.
    Success {
        /// Exact output bytes.
        output: Vec<u8>,
    },
    /// Operation returns this stable typed error.
    Error(StableIdExpectedError),
}

/// Stable-ID error vocabulary admitted by the fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StableIdExpectedError {
    InputTooLarge,
    PrefixTooLarge,
    InvalidPrefix,
    TooManyParts,
    PartTooLarge,
    InteriorNul,
    InvalidUtf8,
    InvalidLength,
    InvalidAlphabet,
}

impl StableIdExpectedError {
    /// Returns the exact kernel error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge => STABLE_ID_INPUT_TOO_LARGE_CODE,
            Self::PrefixTooLarge => STABLE_ID_PREFIX_TOO_LARGE_CODE,
            Self::InvalidPrefix => STABLE_ID_PREFIX_CODE,
            Self::TooManyParts => STABLE_ID_TOO_MANY_PARTS_CODE,
            Self::PartTooLarge => STABLE_ID_PART_TOO_LARGE_CODE,
            Self::InteriorNul => STABLE_ID_NUL_CODE,
            Self::InvalidUtf8 => STABLE_ID_UTF8_CODE,
            Self::InvalidLength => STABLE_ID_LENGTH_CODE,
            Self::InvalidAlphabet => STABLE_ID_ALPHABET_CODE,
        }
    }

    pub(crate) const fn compatible_with(self, operation: StableIdOperation) -> bool {
        match operation {
            StableIdOperation::DeriveStableId => matches!(
                self,
                Self::InputTooLarge
                    | Self::PrefixTooLarge
                    | Self::InvalidPrefix
                    | Self::TooManyParts
                    | Self::PartTooLarge
                    | Self::InteriorNul
                    | Self::InvalidUtf8
            ),
            StableIdOperation::ValidateStableId => matches!(
                self,
                Self::InvalidPrefix | Self::InvalidUtf8 | Self::InvalidLength | Self::InvalidAlphabet
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        STABLE_ID_PROTOCOL, STABLE_ID_PROTOCOL_HEADER, StableIdExpectedError, StableIdOperation,
    };

    #[test]
    fn protocol_operations_and_codes_are_stable() {
        assert_eq!(
            STABLE_ID_PROTOCOL_HEADER,
            format!("# protocol={STABLE_ID_PROTOCOL}")
        );
        assert_eq!(
            StableIdOperation::DeriveStableId.token(),
            "derive_stable_id"
        );
        assert_eq!(
            StableIdOperation::ValidateStableId.token(),
            "validate_stable_id"
        );

        let derive_errors = [
            StableIdExpectedError::InputTooLarge,
            StableIdExpectedError::PrefixTooLarge,
            StableIdExpectedError::InvalidPrefix,
            StableIdExpectedError::TooManyParts,
            StableIdExpectedError::PartTooLarge,
            StableIdExpectedError::InteriorNul,
            StableIdExpectedError::InvalidUtf8,
        ];
        for error in derive_errors {
            assert!(error.code().starts_with("ELIOTR_STABLE_ID_"));
            assert!(error.compatible_with(StableIdOperation::DeriveStableId));
        }

        let validate_errors = [
            StableIdExpectedError::InvalidPrefix,
            StableIdExpectedError::InvalidUtf8,
            StableIdExpectedError::InvalidLength,
            StableIdExpectedError::InvalidAlphabet,
        ];
        for error in validate_errors {
            assert!(error.compatible_with(StableIdOperation::ValidateStableId));
        }
    }
}
