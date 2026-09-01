//! Typed M2 canonical-body fixture representation.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    GENERATION_ALPHABET_CODE, GENERATION_LENGTH_CODE, GENERATION_PREFIX_CODE,
    JSON_DEPTH_LIMIT_CODE, JSON_DUPLICATE_KEY_CODE, JSON_INPUT_TOO_LARGE_CODE,
    JSON_INVALID_UTF8_CODE, JSON_ITEM_LIMIT_CODE, JSON_MEMBER_LIMIT_CODE, JSON_NODE_LIMIT_CODE,
    JSON_NUMBER_CODE, JSON_OUTPUT_TOO_LARGE_CODE, JSON_STRING_TOO_LARGE_CODE, JSON_SYNTAX_CODE,
    JSON_UNICODE_CODE,
};

/// Exact protocol name for M2 canonical-body vectors.
pub const CANONICAL_BODY_PROTOCOL: &str = "eliotr.test-vectors.canonical-body.v1";
/// Exact protocol header.
pub const CANONICAL_BODY_PROTOCOL_HEADER: &str = "# protocol=eliotr.test-vectors.canonical-body.v1";
/// Exact schema generation.
pub const CANONICAL_BODY_SCHEMA_GENERATION: u32 = 1;
/// Exact columns header.
pub const CANONICAL_BODY_COLUMNS_HEADER: &str =
    "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

pub(crate) const MAX_CANONICAL_BODY_VECTOR_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_CANONICAL_BODY_VECTOR_CASES: usize = 4096;
pub(crate) const MAX_CANONICAL_BODY_VECTOR_CASE_ID_BYTES: usize = 128;
pub(crate) const MAX_CANONICAL_BODY_VECTOR_PAYLOAD_BYTES: usize = 256 * 1024;

/// A parsed M2 vector set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalBodyVectorSet {
    schema_generation: u32,
    cases: Vec<CanonicalBodyVector>,
}

impl CanonicalBodyVectorSet {
    pub(crate) fn new(schema_generation: u32, cases: Vec<CanonicalBodyVector>) -> Self {
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
    pub fn cases(&self) -> &[CanonicalBodyVector] {
        &self.cases
    }
}

/// One product-neutral canonical-body operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalBodyOperation {
    /// Parse and emit canonical JSON bytes.
    CanonicalizeJson,
    /// Compute SHA-256 over exact bytes.
    Sha256,
    /// Validate one fixed-width generation token.
    ValidateGeneration,
}

impl CanonicalBodyOperation {
    #[cfg(test)]
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Self::CanonicalizeJson => "canonicalize_json",
            Self::Sha256 => "sha256",
            Self::ValidateGeneration => "validate_generation",
        }
    }
}

/// One strict M2 conformance case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalBodyVector {
    case_id: String,
    operation: CanonicalBodyOperation,
    input: Vec<u8>,
    expected: CanonicalBodyExpectedOutcome,
}

impl CanonicalBodyVector {
    pub(crate) fn new(
        case_id: String,
        operation: CanonicalBodyOperation,
        input: Vec<u8>,
        expected: CanonicalBodyExpectedOutcome,
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
    pub const fn operation(&self) -> CanonicalBodyOperation {
        self.operation
    }

    /// Returns exact input bytes.
    #[must_use]
    pub fn input(&self) -> &[u8] {
        &self.input
    }

    /// Returns the expected outcome.
    #[must_use]
    pub const fn expected(&self) -> &CanonicalBodyExpectedOutcome {
        &self.expected
    }
}

/// Expected execution result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalBodyExpectedOutcome {
    /// Operation succeeds with these exact bytes.
    Success {
        /// Exact output bytes.
        output: Vec<u8>,
    },
    /// Operation fails with this exact typed error.
    Error(CanonicalBodyExpectedError),
}

/// Error vocabulary admitted by the M2 fixture schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalBodyExpectedError {
    JsonInputTooLarge,
    JsonInvalidUtf8,
    JsonSyntax,
    JsonDuplicateKey,
    JsonDepthLimit,
    JsonMemberLimit,
    JsonItemLimit,
    JsonNodeLimit,
    JsonStringTooLarge,
    JsonNumber,
    JsonUnicode,
    JsonOutputTooLarge,
    GenerationLength,
    GenerationPrefix,
    GenerationAlphabet,
}

impl CanonicalBodyExpectedError {
    /// Returns the stable kernel error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::JsonInputTooLarge => JSON_INPUT_TOO_LARGE_CODE,
            Self::JsonInvalidUtf8 => JSON_INVALID_UTF8_CODE,
            Self::JsonSyntax => JSON_SYNTAX_CODE,
            Self::JsonDuplicateKey => JSON_DUPLICATE_KEY_CODE,
            Self::JsonDepthLimit => JSON_DEPTH_LIMIT_CODE,
            Self::JsonMemberLimit => JSON_MEMBER_LIMIT_CODE,
            Self::JsonItemLimit => JSON_ITEM_LIMIT_CODE,
            Self::JsonNodeLimit => JSON_NODE_LIMIT_CODE,
            Self::JsonStringTooLarge => JSON_STRING_TOO_LARGE_CODE,
            Self::JsonNumber => JSON_NUMBER_CODE,
            Self::JsonUnicode => JSON_UNICODE_CODE,
            Self::JsonOutputTooLarge => JSON_OUTPUT_TOO_LARGE_CODE,
            Self::GenerationLength => GENERATION_LENGTH_CODE,
            Self::GenerationPrefix => GENERATION_PREFIX_CODE,
            Self::GenerationAlphabet => GENERATION_ALPHABET_CODE,
        }
    }

    pub(crate) const fn compatible_with(self, operation: CanonicalBodyOperation) -> bool {
        match self {
            Self::JsonInputTooLarge
            | Self::JsonInvalidUtf8
            | Self::JsonSyntax
            | Self::JsonDuplicateKey
            | Self::JsonDepthLimit
            | Self::JsonMemberLimit
            | Self::JsonItemLimit
            | Self::JsonNodeLimit
            | Self::JsonStringTooLarge
            | Self::JsonNumber
            | Self::JsonUnicode
            | Self::JsonOutputTooLarge => {
                matches!(operation, CanonicalBodyOperation::CanonicalizeJson)
            }
            Self::GenerationLength | Self::GenerationPrefix | Self::GenerationAlphabet => {
                matches!(operation, CanonicalBodyOperation::ValidateGeneration)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CANONICAL_BODY_PROTOCOL, CANONICAL_BODY_PROTOCOL_HEADER, CanonicalBodyExpectedError,
        CanonicalBodyOperation,
    };

    #[test]
    fn protocol_and_operation_tokens_are_stable() {
        assert_eq!(
            CANONICAL_BODY_PROTOCOL_HEADER,
            format!("# protocol={CANONICAL_BODY_PROTOCOL}")
        );
        assert_eq!(
            CanonicalBodyOperation::CanonicalizeJson.token(),
            "canonicalize_json"
        );
        assert_eq!(CanonicalBodyOperation::Sha256.token(), "sha256");
        assert_eq!(
            CanonicalBodyOperation::ValidateGeneration.token(),
            "validate_generation"
        );
    }

    #[test]
    fn every_expected_error_has_a_stable_code_and_compatibility() {
        let json_errors = [
            CanonicalBodyExpectedError::JsonInputTooLarge,
            CanonicalBodyExpectedError::JsonInvalidUtf8,
            CanonicalBodyExpectedError::JsonSyntax,
            CanonicalBodyExpectedError::JsonDuplicateKey,
            CanonicalBodyExpectedError::JsonDepthLimit,
            CanonicalBodyExpectedError::JsonMemberLimit,
            CanonicalBodyExpectedError::JsonItemLimit,
            CanonicalBodyExpectedError::JsonNodeLimit,
            CanonicalBodyExpectedError::JsonStringTooLarge,
            CanonicalBodyExpectedError::JsonNumber,
            CanonicalBodyExpectedError::JsonUnicode,
            CanonicalBodyExpectedError::JsonOutputTooLarge,
        ];
        for error in json_errors {
            assert!(error.code().starts_with("ELIOTR_JSON_"));
            assert!(error.compatible_with(CanonicalBodyOperation::CanonicalizeJson));
            assert!(!error.compatible_with(CanonicalBodyOperation::Sha256));
        }

        let generation_errors = [
            CanonicalBodyExpectedError::GenerationLength,
            CanonicalBodyExpectedError::GenerationPrefix,
            CanonicalBodyExpectedError::GenerationAlphabet,
        ];
        for error in generation_errors {
            assert!(error.code().starts_with("ELIOTR_GENERATION_"));
            assert!(error.compatible_with(CanonicalBodyOperation::ValidateGeneration));
            assert!(!error.compatible_with(CanonicalBodyOperation::CanonicalizeJson));
        }
    }
}
