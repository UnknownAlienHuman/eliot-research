//! Deterministic execution of `object-residency-key.v1` vectors.

#![forbid(unsafe_code)]

use core::fmt;

use eliotr_canonical::{ObjectResidencyKeyInput, serialize_object_residency_key};

use super::EMBEDDED_RESIDENCY_KEY_VECTORS;
use super::model::{ResidencyKeyExpectedOutcome, ResidencyKeyVector, ResidencyKeyVectorSet};
use super::parser::{ResidencyKeyParseError, parse_residency_key_vector_set};

/// Parse or semantic mismatch without source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResidencyKeyVerificationError {
    /// Strict fixture parsing failed.
    Parse(ResidencyKeyParseError),
    /// A success case returned a typed error.
    UnexpectedError {
        /// Stable case identity.
        case_id: String,
        /// Actual stable error code.
        actual_code: &'static str,
    },
    /// An error case unexpectedly succeeded.
    UnexpectedSuccess {
        /// Stable case identity.
        case_id: String,
    },
    /// Successful bytes differed.
    OutputMismatch {
        /// Stable case identity.
        case_id: String,
    },
    /// Typed error code differed.
    ErrorCodeMismatch {
        /// Stable case identity.
        case_id: String,
        /// Expected stable code.
        expected_code: &'static str,
        /// Actual stable code.
        actual_code: &'static str,
    },
}

impl fmt::Display for ResidencyKeyVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => error.fmt(formatter),
            Self::UnexpectedError {
                case_id,
                actual_code,
            } => write!(
                formatter,
                "residency-key vector {case_id} expected success but returned {actual_code}"
            ),
            Self::UnexpectedSuccess { case_id } => write!(
                formatter,
                "residency-key vector {case_id} expected an error but succeeded"
            ),
            Self::OutputMismatch { case_id } => write!(
                formatter,
                "residency-key vector {case_id} returned different output bytes"
            ),
            Self::ErrorCodeMismatch {
                case_id,
                expected_code,
                actual_code,
            } => write!(
                formatter,
                "residency-key vector {case_id} expected {expected_code} but returned {actual_code}"
            ),
        }
    }
}

impl std::error::Error for ResidencyKeyVerificationError {}

impl From<ResidencyKeyParseError> for ResidencyKeyVerificationError {
    fn from(value: ResidencyKeyParseError) -> Self {
        Self::Parse(value)
    }
}

enum ActualOutcome {
    Success(Vec<u8>),
    Error(&'static str),
}

/// Executes every declared residency-key vector in order.
///
/// # Errors
///
/// Returns the first deterministic semantic mismatch.
pub fn verify_residency_key_vector_set(
    set: &ResidencyKeyVectorSet,
) -> Result<(), ResidencyKeyVerificationError> {
    for case in set.cases() {
        let actual = execute(case);
        match (case.expected(), actual) {
            (
                ResidencyKeyExpectedOutcome::Success { output },
                ActualOutcome::Success(actual_output),
            ) => {
                if actual_output.as_slice() != output.as_slice() {
                    return Err(ResidencyKeyVerificationError::OutputMismatch {
                        case_id: case.case_id().to_owned(),
                    });
                }
            }
            (ResidencyKeyExpectedOutcome::Success { .. }, ActualOutcome::Error(actual_code)) => {
                return Err(ResidencyKeyVerificationError::UnexpectedError {
                    case_id: case.case_id().to_owned(),
                    actual_code,
                });
            }
            (ResidencyKeyExpectedOutcome::Error(_), ActualOutcome::Success(_)) => {
                return Err(ResidencyKeyVerificationError::UnexpectedSuccess {
                    case_id: case.case_id().to_owned(),
                });
            }
            (ResidencyKeyExpectedOutcome::Error(expected), ActualOutcome::Error(actual_code)) => {
                let expected_code = expected.code();
                if expected_code != actual_code {
                    return Err(ResidencyKeyVerificationError::ErrorCodeMismatch {
                        case_id: case.case_id().to_owned(),
                        expected_code,
                        actual_code,
                    });
                }
            }
        }
    }
    Ok(())
}

/// Parses and executes the exact embedded residency-key corpus.
///
/// # Errors
///
/// Returns the first strict parse or semantic mismatch.
pub fn verify_embedded_residency_key_vectors() -> Result<(), ResidencyKeyVerificationError> {
    let vectors = parse_residency_key_vector_set(EMBEDDED_RESIDENCY_KEY_VECTORS)?;
    verify_residency_key_vector_set(&vectors)
}

fn execute(case: &ResidencyKeyVector) -> ActualOutcome {
    let input = ObjectResidencyKeyInput {
        scope_domain_id: case.scope_domain_id(),
        access_domain_id: case.access_domain_id(),
        confidentiality_domain_id: case.confidentiality_domain_id(),
        encryption_key_domain_id: case.encryption_key_domain_id(),
        retention_domain_id: case.retention_domain_id(),
        erasure_domain_id: case.erasure_domain_id(),
        content_digest: case.content_digest(),
    };
    match serialize_object_residency_key(input) {
        Ok(output) => ActualOutcome::Success(output.into_bytes()),
        Err(error) => ActualOutcome::Error(error.code()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ResidencyKeyVerificationError, verify_embedded_residency_key_vectors,
        verify_residency_key_vector_set,
    };
    use crate::{
        RESIDENCY_KEY_COLUMNS_HEADER, RESIDENCY_KEY_PROTOCOL_HEADER, parse_residency_key_vector_set,
    };

    const DIGEST_HEX: &str = "30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";
    const OUTPUT_HEX: &str = "6f626a6563742d7265736964656e63792d6b65792e76312f732f612f632f6b2f722f652f7368613235362f30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";
    const WRONG_OUTPUT_HEX: &str = "6f626a6563742d7265736964656e63792d6b65792e76312f782f612f632f6b2f722f652f7368613235362f30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566";

    fn verify_row(row: &str) -> Result<(), ResidencyKeyVerificationError> {
        let frame = format!(
            "{RESIDENCY_KEY_PROTOCOL_HEADER}\n# schema_generation=1\n{RESIDENCY_KEY_COLUMNS_HEADER}\n{row}\n"
        );
        let vectors = parse_residency_key_vector_set(&frame)?;
        verify_residency_key_vector_set(&vectors)
    }

    #[test]
    fn embedded_vectors_pass() {
        assert_eq!(verify_embedded_residency_key_vectors(), Ok(()));
    }

    #[test]
    fn detects_every_semantic_mismatch() {
        assert!(matches!(
            verify_row(&format!(
                "wrong_output|73|61|63|6b|72|65|{DIGEST_HEX}|ok|{WRONG_OUTPUT_HEX}|-"
            )),
            Err(ResidencyKeyVerificationError::OutputMismatch { case_id })
                if case_id == "wrong_output"
        ));
        assert!(matches!(
            verify_row(&format!(
                "unexpected_error|-|61|63|6b|72|65|{DIGEST_HEX}|ok|{OUTPUT_HEX}|-"
            )),
            Err(ResidencyKeyVerificationError::UnexpectedError {
                case_id,
                actual_code: "ELIOTR_RESIDENCY_KEY_EMPTY_IDENTIFIER",
            }) if case_id == "unexpected_error"
        ));
        assert!(matches!(
            verify_row(&format!(
                "unexpected_success|73|61|63|6b|72|65|{DIGEST_HEX}|error|-|ELIOTR_RESIDENCY_KEY_EMPTY_IDENTIFIER"
            )),
            Err(ResidencyKeyVerificationError::UnexpectedSuccess { case_id })
                if case_id == "unexpected_success"
        ));
        assert!(matches!(
            verify_row(&format!(
                "wrong_code|-|61|63|6b|72|65|{DIGEST_HEX}|error|-|ELIOTR_RESIDENCY_KEY_IDENTIFIER_TOO_LONG"
            )),
            Err(ResidencyKeyVerificationError::ErrorCodeMismatch {
                case_id,
                expected_code: "ELIOTR_RESIDENCY_KEY_IDENTIFIER_TOO_LONG",
                actual_code: "ELIOTR_RESIDENCY_KEY_EMPTY_IDENTIFIER",
            }) if case_id == "wrong_code"
        ));
    }

    #[test]
    fn wraps_parse_errors_and_formats_variants() {
        let parse_result = parse_residency_key_vector_set("");
        let Err(parse_error) = parse_result else {
            return;
        };
        let wrapped = ResidencyKeyVerificationError::from(parse_error);
        assert!(wrapped.to_string().starts_with("invalid residency-key"));

        let messages = [
            ResidencyKeyVerificationError::UnexpectedError {
                case_id: "a".to_owned(),
                actual_code: "E",
            }
            .to_string(),
            ResidencyKeyVerificationError::UnexpectedSuccess {
                case_id: "b".to_owned(),
            }
            .to_string(),
            ResidencyKeyVerificationError::OutputMismatch {
                case_id: "c".to_owned(),
            }
            .to_string(),
            ResidencyKeyVerificationError::ErrorCodeMismatch {
                case_id: "d".to_owned(),
                expected_code: "X",
                actual_code: "Y",
            }
            .to_string(),
        ];
        assert!(
            messages
                .iter()
                .all(|message| message.starts_with("residency-key vector "))
        );
    }
}
