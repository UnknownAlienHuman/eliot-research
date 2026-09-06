//! Deterministic execution of `owner-token.v1` vectors.

#![forbid(unsafe_code)]

use core::fmt;

use eliotr_canonical::{derive_owner_token_from_preimage, validate_owner_token};

use super::EMBEDDED_OWNER_TOKEN_VECTORS;
use super::model::{
    OwnerTokenExpectedOutcome, OwnerTokenOperation, OwnerTokenVector, OwnerTokenVectorSet,
};
use super::parser::{OwnerTokenParseError, parse_owner_token_vector_set};

/// Parse or semantic mismatch without source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerTokenVerificationError {
    Parse(OwnerTokenParseError),
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

impl fmt::Display for OwnerTokenVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => error.fmt(formatter),
            Self::UnexpectedError {
                case_id,
                actual_code,
            } => write!(
                formatter,
                "owner-token vector {case_id} expected success but returned {actual_code}"
            ),
            Self::UnexpectedSuccess { case_id } => write!(
                formatter,
                "owner-token vector {case_id} expected an error but succeeded"
            ),
            Self::OutputMismatch { case_id } => write!(
                formatter,
                "owner-token vector {case_id} returned different output bytes"
            ),
            Self::ErrorCodeMismatch {
                case_id,
                expected_code,
                actual_code,
            } => write!(
                formatter,
                "owner-token vector {case_id} expected {expected_code} but returned {actual_code}"
            ),
        }
    }
}

impl std::error::Error for OwnerTokenVerificationError {}

impl From<OwnerTokenParseError> for OwnerTokenVerificationError {
    fn from(value: OwnerTokenParseError) -> Self {
        Self::Parse(value)
    }
}

enum ActualOutcome {
    Success(Vec<u8>),
    Error(&'static str),
}

/// Executes every declared owner-token vector in order.
///
/// # Errors
///
/// Returns the first deterministic semantic mismatch.
pub fn verify_owner_token_vector_set(
    set: &OwnerTokenVectorSet,
) -> Result<(), OwnerTokenVerificationError> {
    for case in set.cases() {
        let actual = execute(case);
        match (case.expected(), actual) {
            (
                OwnerTokenExpectedOutcome::Success { output },
                ActualOutcome::Success(actual_output),
            ) => {
                if actual_output.as_slice() != output.as_slice() {
                    return Err(OwnerTokenVerificationError::OutputMismatch {
                        case_id: case.case_id().to_owned(),
                    });
                }
            }
            (OwnerTokenExpectedOutcome::Success { .. }, ActualOutcome::Error(actual_code)) => {
                return Err(OwnerTokenVerificationError::UnexpectedError {
                    case_id: case.case_id().to_owned(),
                    actual_code,
                });
            }
            (OwnerTokenExpectedOutcome::Error(_), ActualOutcome::Success(_)) => {
                return Err(OwnerTokenVerificationError::UnexpectedSuccess {
                    case_id: case.case_id().to_owned(),
                });
            }
            (OwnerTokenExpectedOutcome::Error(expected), ActualOutcome::Error(actual_code)) => {
                let expected_code = expected.code();
                if expected_code != actual_code {
                    return Err(OwnerTokenVerificationError::ErrorCodeMismatch {
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

/// Parses and executes the exact embedded owner-token corpus.
///
/// # Errors
///
/// Returns the first strict parse or semantic mismatch.
pub fn verify_embedded_owner_token_vectors() -> Result<(), OwnerTokenVerificationError> {
    let vectors = parse_owner_token_vector_set(EMBEDDED_OWNER_TOKEN_VECTORS)?;
    verify_owner_token_vector_set(&vectors)
}

fn execute(case: &OwnerTokenVector) -> ActualOutcome {
    match case.operation() {
        OwnerTokenOperation::DeriveOwnerToken => {
            match derive_owner_token_from_preimage(case.input()) {
                Ok(output) => ActualOutcome::Success(output.into_bytes()),
                Err(error) => ActualOutcome::Error(error.code()),
            }
        }
        OwnerTokenOperation::ValidateOwnerToken => match validate_owner_token(case.input()) {
            Ok(output) => ActualOutcome::Success(output.as_bytes().to_vec()),
            Err(error) => ActualOutcome::Error(error.code()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        OwnerTokenVerificationError, verify_embedded_owner_token_vectors,
        verify_owner_token_vector_set,
    };
    use crate::{
        OWNER_TOKEN_COLUMNS_HEADER, OWNER_TOKEN_PROTOCOL_HEADER, parse_owner_token_vector_set,
    };

    fn verify_row(row: &str) -> Result<(), OwnerTokenVerificationError> {
        let frame = format!(
            "{OWNER_TOKEN_PROTOCOL_HEADER}\n# schema_generation=1\n{OWNER_TOKEN_COLUMNS_HEADER}\n{row}\n"
        );
        let vectors = parse_owner_token_vector_set(&frame)?;
        verify_owner_token_vector_set(&vectors)
    }

    #[test]
    fn embedded_vectors_pass() {
        assert_eq!(verify_embedded_owner_token_vectors(), Ok(()));
    }

    #[test]
    fn detects_every_semantic_mismatch() {
        // A valid preimage paired with a different well-formed token proves OutputMismatch.
        assert!(matches!(
            verify_row("wrong_output|derive_owner_token|5b22656c696f74722e736f757263652d6f776e65722e696e697469616c2e7631222c2261222c22656c696f7472222c2262222c312c22414354495645225d|ok|6f776e65722d30303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030|-"),
            Err(OwnerTokenVerificationError::OutputMismatch { case_id })
                if case_id == "wrong_output"
        ));
        // `[]` always derives SHAPE, so pairing it with success proves UnexpectedError.
        assert!(matches!(
            verify_row("unexpected_error|derive_owner_token|5b5d|ok|6f776e65722d30303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030|-"),
            Err(OwnerTokenVerificationError::UnexpectedError {
                case_id,
                actual_code: "ELIOTR_OWNER_TOKEN_SHAPE",
            }) if case_id == "unexpected_error"
        ));
        // A valid preimage paired with an error expectation proves UnexpectedSuccess.
        assert!(matches!(
            verify_row("unexpected_success|derive_owner_token|5b22656c696f74722e736f757263652d6f776e65722e696e697469616c2e7631222c2261222c22656c696f7472222c2262222c312c22414354495645225d|error|-|ELIOTR_OWNER_TOKEN_SHAPE"),
            Err(OwnerTokenVerificationError::UnexpectedSuccess { case_id })
                if case_id == "unexpected_success"
        ));
        // A valid preimage paired with the wrong error code proves ErrorCodeMismatch.
        assert!(matches!(
            verify_row("wrong_code|derive_owner_token|5b5d|error|-|ELIOTR_OWNER_TOKEN_UTF8"),
            Err(OwnerTokenVerificationError::ErrorCodeMismatch {
                case_id,
                expected_code: "ELIOTR_OWNER_TOKEN_UTF8",
                actual_code: "ELIOTR_OWNER_TOKEN_SHAPE",
            }) if case_id == "wrong_code"
        ));
    }

    #[test]
    fn wraps_parse_errors_and_formats_every_variant() {
        let parse_result = parse_owner_token_vector_set("");
        let Err(parse_error) = parse_result else {
            return;
        };
        let wrapped = OwnerTokenVerificationError::from(parse_error);
        assert!(wrapped.to_string().starts_with("invalid owner-token"));

        let messages = [
            OwnerTokenVerificationError::UnexpectedError {
                case_id: "a".to_owned(),
                actual_code: "E",
            }
            .to_string(),
            OwnerTokenVerificationError::UnexpectedSuccess {
                case_id: "b".to_owned(),
            }
            .to_string(),
            OwnerTokenVerificationError::OutputMismatch {
                case_id: "c".to_owned(),
            }
            .to_string(),
            OwnerTokenVerificationError::ErrorCodeMismatch {
                case_id: "d".to_owned(),
                expected_code: "X",
                actual_code: "Y",
            }
            .to_string(),
        ];
        assert!(
            messages
                .iter()
                .all(|message| message.starts_with("owner-token vector "))
        );
    }
}
