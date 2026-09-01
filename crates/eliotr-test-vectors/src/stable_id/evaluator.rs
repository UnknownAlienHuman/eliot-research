//! Deterministic execution of `stable-id.v1` vectors.

#![forbid(unsafe_code)]

use core::fmt;

use eliotr_canonical::{derive_stable_id_frame, validate_stable_id};

use super::EMBEDDED_STABLE_ID_VECTORS;
use super::model::{
    StableIdExpectedOutcome, StableIdOperation, StableIdVector, StableIdVectorSet,
};
use super::parser::{StableIdParseError, parse_stable_id_vector_set};

/// Parse or semantic mismatch without source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StableIdVerificationError {
    Parse(StableIdParseError),
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

impl fmt::Display for StableIdVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => error.fmt(formatter),
            Self::UnexpectedError {
                case_id,
                actual_code,
            } => write!(
                formatter,
                "stable-ID vector {case_id} expected success but returned {actual_code}"
            ),
            Self::UnexpectedSuccess { case_id } => write!(
                formatter,
                "stable-ID vector {case_id} expected an error but succeeded"
            ),
            Self::OutputMismatch { case_id } => write!(
                formatter,
                "stable-ID vector {case_id} returned different output bytes"
            ),
            Self::ErrorCodeMismatch {
                case_id,
                expected_code,
                actual_code,
            } => write!(
                formatter,
                "stable-ID vector {case_id} expected {expected_code} but returned {actual_code}"
            ),
        }
    }
}

impl std::error::Error for StableIdVerificationError {}

impl From<StableIdParseError> for StableIdVerificationError {
    fn from(value: StableIdParseError) -> Self {
        Self::Parse(value)
    }
}

enum ActualOutcome {
    Success(Vec<u8>),
    Error(&'static str),
}

/// Executes every declared stable-ID vector in order.
///
/// # Errors
///
/// Returns the first deterministic semantic mismatch.
pub fn verify_stable_id_vector_set(
    set: &StableIdVectorSet,
) -> Result<(), StableIdVerificationError> {
    for case in set.cases() {
        let actual = execute(case);
        match (case.expected(), actual) {
            (
                StableIdExpectedOutcome::Success { output },
                ActualOutcome::Success(actual_output),
            ) => {
                if actual_output.as_slice() != output.as_slice() {
                    return Err(StableIdVerificationError::OutputMismatch {
                        case_id: case.case_id().to_owned(),
                    });
                }
            }
            (StableIdExpectedOutcome::Success { .. }, ActualOutcome::Error(actual_code)) => {
                return Err(StableIdVerificationError::UnexpectedError {
                    case_id: case.case_id().to_owned(),
                    actual_code,
                });
            }
            (StableIdExpectedOutcome::Error(_), ActualOutcome::Success(_)) => {
                return Err(StableIdVerificationError::UnexpectedSuccess {
                    case_id: case.case_id().to_owned(),
                });
            }
            (
                StableIdExpectedOutcome::Error(expected),
                ActualOutcome::Error(actual_code),
            ) => {
                let expected_code = expected.code();
                if expected_code != actual_code {
                    return Err(StableIdVerificationError::ErrorCodeMismatch {
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

/// Parses and executes the exact embedded stable-ID corpus.
///
/// # Errors
///
/// Returns the first strict parse or semantic mismatch.
pub fn verify_embedded_stable_id_vectors() -> Result<(), StableIdVerificationError> {
    let vectors = parse_stable_id_vector_set(EMBEDDED_STABLE_ID_VECTORS)?;
    verify_stable_id_vector_set(&vectors)
}

fn execute(case: &StableIdVector) -> ActualOutcome {
    match case.operation() {
        StableIdOperation::DeriveStableId => match derive_stable_id_frame(case.input()) {
            Ok(output) => ActualOutcome::Success(output.into_bytes()),
            Err(error) => ActualOutcome::Error(error.code()),
        },
        StableIdOperation::ValidateStableId => match validate_stable_id(case.input()) {
            Ok(output) => ActualOutcome::Success(output.as_bytes().to_vec()),
            Err(error) => ActualOutcome::Error(error.code()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        StableIdVerificationError, verify_embedded_stable_id_vectors,
        verify_stable_id_vector_set,
    };
    use crate::{STABLE_ID_COLUMNS_HEADER, STABLE_ID_PROTOCOL_HEADER, parse_stable_id_vector_set};

    fn verify_row(row: &str) -> Result<(), StableIdVerificationError> {
        let frame = format!(
            "{STABLE_ID_PROTOCOL_HEADER}\n# schema_generation=1\n{STABLE_ID_COLUMNS_HEADER}\n{row}\n"
        );
        let vectors = parse_stable_id_vector_set(&frame)?;
        verify_stable_id_vector_set(&vectors)
    }

    #[test]
    fn embedded_vectors_pass() {
        assert_eq!(verify_embedded_stable_id_vectors(), Ok(()));
    }

    #[test]
    fn detects_every_semantic_mismatch() {
        assert!(matches!(
            verify_row("wrong_output|derive_stable_id|736f75726365|ok|736f757263652d303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030|-"),
            Err(StableIdVerificationError::OutputMismatch { case_id })
                if case_id == "wrong_output"
        ));
        assert!(matches!(
            verify_row("unexpected_error|derive_stable_id|5f626164|ok|612d303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030|-"),
            Err(StableIdVerificationError::UnexpectedError {
                case_id,
                actual_code: "ELIOTR_STABLE_ID_PREFIX",
            }) if case_id == "unexpected_error"
        ));
        assert!(matches!(
            verify_row("unexpected_success|derive_stable_id|736f75726365|error|-|ELIOTR_STABLE_ID_PREFIX"),
            Err(StableIdVerificationError::UnexpectedSuccess { case_id })
                if case_id == "unexpected_success"
        ));
        assert!(matches!(
            verify_row("wrong_code|derive_stable_id|5f626164|error|-|ELIOTR_STABLE_ID_UTF8"),
            Err(StableIdVerificationError::ErrorCodeMismatch {
                case_id,
                expected_code: "ELIOTR_STABLE_ID_UTF8",
                actual_code: "ELIOTR_STABLE_ID_PREFIX",
            }) if case_id == "wrong_code"
        ));
    }

    #[test]
    fn wraps_parse_errors_and_formats_every_variant() {
        let parse_result = parse_stable_id_vector_set("");
        let Err(parse_error) = parse_result else {
            return;
        };
        let wrapped = StableIdVerificationError::from(parse_error);
        assert!(wrapped.to_string().starts_with("invalid stable-ID"));

        let messages = [
            StableIdVerificationError::UnexpectedError {
                case_id: "a".to_owned(),
                actual_code: "E",
            }
            .to_string(),
            StableIdVerificationError::UnexpectedSuccess {
                case_id: "b".to_owned(),
            }
            .to_string(),
            StableIdVerificationError::OutputMismatch {
                case_id: "c".to_owned(),
            }
            .to_string(),
            StableIdVerificationError::ErrorCodeMismatch {
                case_id: "d".to_owned(),
                expected_code: "X",
                actual_code: "Y",
            }
            .to_string(),
        ];
        assert!(
            messages
                .iter()
                .all(|message| message.starts_with("stable-ID vector "))
        );
    }
}
