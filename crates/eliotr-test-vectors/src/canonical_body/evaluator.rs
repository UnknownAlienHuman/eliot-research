//! Deterministic execution of M2 canonical-body vectors.

#![forbid(unsafe_code)]

use core::fmt;

use eliotr_canonical::{canonicalize_json, sha256, validate_generation_token};

use super::EMBEDDED_CANONICAL_BODY_VECTORS;
use super::model::{
    CanonicalBodyExpectedOutcome, CanonicalBodyOperation, CanonicalBodyVector,
    CanonicalBodyVectorSet,
};
use super::parser::{CanonicalBodyParseError, parse_canonical_body_vector_set};

/// Parse or semantic mismatch without source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalBodyVerificationError {
    Parse(CanonicalBodyParseError),
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

impl fmt::Display for CanonicalBodyVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => error.fmt(formatter),
            Self::UnexpectedError {
                case_id,
                actual_code,
            } => write!(
                formatter,
                "canonical-body vector {case_id} expected success but returned {actual_code}"
            ),
            Self::UnexpectedSuccess { case_id } => write!(
                formatter,
                "canonical-body vector {case_id} expected an error but succeeded"
            ),
            Self::OutputMismatch { case_id } => write!(
                formatter,
                "canonical-body vector {case_id} returned different output bytes"
            ),
            Self::ErrorCodeMismatch {
                case_id,
                expected_code,
                actual_code,
            } => write!(
                formatter,
                "canonical-body vector {case_id} expected {expected_code} but returned {actual_code}"
            ),
        }
    }
}

impl std::error::Error for CanonicalBodyVerificationError {}

impl From<CanonicalBodyParseError> for CanonicalBodyVerificationError {
    fn from(value: CanonicalBodyParseError) -> Self {
        Self::Parse(value)
    }
}

enum ActualOutcome {
    Success(Vec<u8>),
    Error(&'static str),
}

/// Executes every declared M2 case in order.
///
/// # Errors
///
/// Returns the first strict mismatch.
pub fn verify_canonical_body_vector_set(
    set: &CanonicalBodyVectorSet,
) -> Result<(), CanonicalBodyVerificationError> {
    for case in set.cases() {
        let actual = execute(case);
        match (case.expected(), actual) {
            (
                CanonicalBodyExpectedOutcome::Success { output },
                ActualOutcome::Success(actual_output),
            ) => {
                if actual_output.as_slice() != output.as_slice() {
                    return Err(CanonicalBodyVerificationError::OutputMismatch {
                        case_id: case.case_id().to_owned(),
                    });
                }
            }
            (CanonicalBodyExpectedOutcome::Success { .. }, ActualOutcome::Error(actual_code)) => {
                return Err(CanonicalBodyVerificationError::UnexpectedError {
                    case_id: case.case_id().to_owned(),
                    actual_code,
                });
            }
            (CanonicalBodyExpectedOutcome::Error(_), ActualOutcome::Success(_)) => {
                return Err(CanonicalBodyVerificationError::UnexpectedSuccess {
                    case_id: case.case_id().to_owned(),
                });
            }
            (CanonicalBodyExpectedOutcome::Error(expected), ActualOutcome::Error(actual_code)) => {
                let expected_code = expected.code();
                if expected_code != actual_code {
                    return Err(CanonicalBodyVerificationError::ErrorCodeMismatch {
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

/// Parses and executes the exact embedded M2 corpus.
///
/// # Errors
///
/// Returns the first parse or semantic mismatch.
pub fn verify_embedded_canonical_body_vectors() -> Result<(), CanonicalBodyVerificationError> {
    let vectors = parse_canonical_body_vector_set(EMBEDDED_CANONICAL_BODY_VECTORS)?;
    verify_canonical_body_vector_set(&vectors)
}

fn execute(case: &CanonicalBodyVector) -> ActualOutcome {
    match case.operation() {
        CanonicalBodyOperation::CanonicalizeJson => match canonicalize_json(case.input()) {
            Ok(output) => ActualOutcome::Success(output),
            Err(error) => ActualOutcome::Error(error.code()),
        },
        CanonicalBodyOperation::Sha256 => ActualOutcome::Success(sha256(case.input()).to_vec()),
        CanonicalBodyOperation::ValidateGeneration => match validate_generation_token(case.input())
        {
            Ok(token) => ActualOutcome::Success(token.as_bytes().to_vec()),
            Err(error) => ActualOutcome::Error(error.code()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{CanonicalBodyVerificationError, verify_canonical_body_vector_set};
    use crate::{
        CANONICAL_BODY_COLUMNS_HEADER, CANONICAL_BODY_PROTOCOL_HEADER,
        parse_canonical_body_vector_set,
    };

    fn verify_row(row: &str) -> Result<(), CanonicalBodyVerificationError> {
        let frame = format!(
            "{CANONICAL_BODY_PROTOCOL_HEADER}\n# schema_generation=1\n{CANONICAL_BODY_COLUMNS_HEADER}\n{row}\n"
        );
        let vectors = parse_canonical_body_vector_set(&frame)?;
        verify_canonical_body_vector_set(&vectors)
    }

    #[test]
    fn detects_every_semantic_mismatch() {
        assert!(matches!(
            verify_row("wrong_output|canonicalize_json|6e756c6c|ok|74727565|-"),
            Err(CanonicalBodyVerificationError::OutputMismatch { case_id })
                if case_id == "wrong_output"
        ));
        assert!(matches!(
            verify_row("unexpected_error|canonicalize_json|7b|ok|7b|-"),
            Err(CanonicalBodyVerificationError::UnexpectedError {
                case_id,
                actual_code: "ELIOTR_JSON_SYNTAX",
            }) if case_id == "unexpected_error"
        ));
        assert!(matches!(
            verify_row("unexpected_success|canonicalize_json|6e756c6c|error|-|ELIOTR_JSON_SYNTAX"),
            Err(CanonicalBodyVerificationError::UnexpectedSuccess { case_id })
                if case_id == "unexpected_success"
        ));
        assert!(matches!(
            verify_row("wrong_code|canonicalize_json|7b2261223a312c2261223a327d|error|-|ELIOTR_JSON_SYNTAX"),
            Err(CanonicalBodyVerificationError::ErrorCodeMismatch {
                case_id,
                expected_code: "ELIOTR_JSON_SYNTAX",
                actual_code: "ELIOTR_JSON_DUPLICATE_KEY",
            }) if case_id == "wrong_code"
        ));
    }

    #[test]
    fn wraps_parse_errors_and_formats_every_variant() {
        let parse_result = parse_canonical_body_vector_set("");
        let Err(parse_error) = parse_result else {
            return;
        };
        let wrapped = CanonicalBodyVerificationError::from(parse_error);
        assert!(wrapped.to_string().starts_with("invalid canonical-body"));

        let messages = [
            CanonicalBodyVerificationError::UnexpectedError {
                case_id: "a".to_owned(),
                actual_code: "E",
            }
            .to_string(),
            CanonicalBodyVerificationError::UnexpectedSuccess {
                case_id: "b".to_owned(),
            }
            .to_string(),
            CanonicalBodyVerificationError::OutputMismatch {
                case_id: "c".to_owned(),
            }
            .to_string(),
            CanonicalBodyVerificationError::ErrorCodeMismatch {
                case_id: "d".to_owned(),
                expected_code: "X",
                actual_code: "Y",
            }
            .to_string(),
        ];
        assert!(
            messages
                .iter()
                .all(|message| message.starts_with("canonical-body vector "))
        );
    }
}
