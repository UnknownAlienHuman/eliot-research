//! Typed representation of the `object-residency-key.v1` conformance corpus.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    RESIDENCY_KEY_DIGEST_ALPHABET_CODE, RESIDENCY_KEY_DIGEST_LENGTH_CODE,
    RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE, RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE,
    RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE, RESIDENCY_KEY_UTF8_CODE,
};

/// Exact residency-key vector protocol.
pub const RESIDENCY_KEY_PROTOCOL: &str = "eliotr.test-vectors.residency-key.v1";
/// Exact protocol header.
pub const RESIDENCY_KEY_PROTOCOL_HEADER: &str = "# protocol=eliotr.test-vectors.residency-key.v1";
/// Exact schema generation.
pub const RESIDENCY_KEY_SCHEMA_GENERATION: u32 = 1;
/// Exact columns header.
pub const RESIDENCY_KEY_COLUMNS_HEADER: &str = "# columns=case_id|scope_hex|access_hex|confidentiality_hex|encryption_hex|retention_hex|erasure_hex|digest_hex|expected|output_hex|error_code";

pub(crate) const MAX_RESIDENCY_KEY_VECTOR_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_RESIDENCY_KEY_VECTOR_CASES: usize = 4096;
pub(crate) const MAX_RESIDENCY_KEY_VECTOR_CASE_ID_BYTES: usize = 128;
pub(crate) const MAX_RESIDENCY_KEY_VECTOR_FIELD_BYTES: usize = 1024;
pub(crate) const MAX_RESIDENCY_KEY_VECTOR_OUTPUT_BYTES: usize = 16 * 1024;

/// One parsed residency-key corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidencyKeyVectorSet {
    schema_generation: u32,
    cases: Vec<ResidencyKeyVector>,
}

impl ResidencyKeyVectorSet {
    pub(crate) fn new(schema_generation: u32, cases: Vec<ResidencyKeyVector>) -> Self {
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
    pub fn cases(&self) -> &[ResidencyKeyVector] {
        &self.cases
    }
}

/// One strict residency-key case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidencyKeyVector {
    case_id: String,
    scope_domain_id: Vec<u8>,
    access_domain_id: Vec<u8>,
    confidentiality_domain_id: Vec<u8>,
    encryption_key_domain_id: Vec<u8>,
    retention_domain_id: Vec<u8>,
    erasure_domain_id: Vec<u8>,
    content_digest: Vec<u8>,
    expected: ResidencyKeyExpectedOutcome,
}

impl ResidencyKeyVector {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        case_id: String,
        scope_domain_id: Vec<u8>,
        access_domain_id: Vec<u8>,
        confidentiality_domain_id: Vec<u8>,
        encryption_key_domain_id: Vec<u8>,
        retention_domain_id: Vec<u8>,
        erasure_domain_id: Vec<u8>,
        content_digest: Vec<u8>,
        expected: ResidencyKeyExpectedOutcome,
    ) -> Self {
        Self {
            case_id,
            scope_domain_id,
            access_domain_id,
            confidentiality_domain_id,
            encryption_key_domain_id,
            retention_domain_id,
            erasure_domain_id,
            content_digest,
            expected,
        }
    }

    /// Returns the fixture-local identity.
    #[must_use]
    pub fn case_id(&self) -> &str {
        &self.case_id
    }

    /// Returns exact scope-domain bytes.
    #[must_use]
    pub fn scope_domain_id(&self) -> &[u8] {
        &self.scope_domain_id
    }

    /// Returns exact access-domain bytes.
    #[must_use]
    pub fn access_domain_id(&self) -> &[u8] {
        &self.access_domain_id
    }

    /// Returns exact confidentiality-domain bytes.
    #[must_use]
    pub fn confidentiality_domain_id(&self) -> &[u8] {
        &self.confidentiality_domain_id
    }

    /// Returns exact encryption-key-domain bytes.
    #[must_use]
    pub fn encryption_key_domain_id(&self) -> &[u8] {
        &self.encryption_key_domain_id
    }

    /// Returns exact retention-domain bytes.
    #[must_use]
    pub fn retention_domain_id(&self) -> &[u8] {
        &self.retention_domain_id
    }

    /// Returns exact erasure-domain bytes.
    #[must_use]
    pub fn erasure_domain_id(&self) -> &[u8] {
        &self.erasure_domain_id
    }

    /// Returns exact digest bytes.
    #[must_use]
    pub fn content_digest(&self) -> &[u8] {
        &self.content_digest
    }

    /// Returns the expected result.
    #[must_use]
    pub const fn expected(&self) -> &ResidencyKeyExpectedOutcome {
        &self.expected
    }
}

/// Expected serialization result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResidencyKeyExpectedOutcome {
    /// Serialization succeeds with these exact bytes.
    Success {
        /// Exact output bytes.
        output: Vec<u8>,
    },
    /// Serialization returns this stable typed error.
    Error(ResidencyKeyExpectedError),
}

/// Error vocabulary admitted by the residency-key corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidencyKeyExpectedError {
    /// Identifier bytes exceeded the bounded pre-decode ceiling.
    IdentifierInputTooLarge,
    /// A field was not valid UTF-8.
    InvalidUtf8,
    /// One identifier was empty.
    EmptyIdentifier,
    /// One identifier exceeded 256 JavaScript UTF-16 units.
    IdentifierTooLong,
    /// Digest width was not exactly 64 bytes.
    DigestLength,
    /// Digest was not lowercase hexadecimal.
    DigestAlphabet,
}

impl ResidencyKeyExpectedError {
    /// Returns the exact kernel error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::IdentifierInputTooLarge => RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 => RESIDENCY_KEY_UTF8_CODE,
            Self::EmptyIdentifier => RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE,
            Self::IdentifierTooLong => RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE,
            Self::DigestLength => RESIDENCY_KEY_DIGEST_LENGTH_CODE,
            Self::DigestAlphabet => RESIDENCY_KEY_DIGEST_ALPHABET_CODE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RESIDENCY_KEY_PROTOCOL, RESIDENCY_KEY_PROTOCOL_HEADER, ResidencyKeyExpectedError};

    #[test]
    fn protocol_and_error_codes_are_stable() {
        assert_eq!(
            RESIDENCY_KEY_PROTOCOL_HEADER,
            format!("# protocol={RESIDENCY_KEY_PROTOCOL}")
        );
        let errors = [
            ResidencyKeyExpectedError::IdentifierInputTooLarge,
            ResidencyKeyExpectedError::InvalidUtf8,
            ResidencyKeyExpectedError::EmptyIdentifier,
            ResidencyKeyExpectedError::IdentifierTooLong,
            ResidencyKeyExpectedError::DigestLength,
            ResidencyKeyExpectedError::DigestAlphabet,
        ];
        assert!(
            errors
                .iter()
                .all(|error| error.code().starts_with("ELIOTR_RESIDENCY_KEY_"))
        );
    }
}
