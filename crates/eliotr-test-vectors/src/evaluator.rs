//! Deterministic execution of shared fixture cases.

#![forbid(unsafe_code)]

use std::fmt;

use eliotr_canonical::validate_canonical_utf8_transport;

use crate::model::{ExpectedOutcome, VectorSet};
use crate::parser::{VectorParseError, parse_vector_set};

/// Fixture parse or semantic mismatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VectorVerificationError {
    /// The strict frame could not be parsed.
    Parse(VectorParseError),
    /// A case expected success but received a typed error.
    UnexpectedError {
        /// Stable case identity.
        case_id: String,
        /// Actual stable error code.
        actual_code: &'static str,
    },
    /// A case expected an error but validation succeeded.
    UnexpectedSuccess {
        /// Stable case identity.
        case_id: String,
    },
    /// Successful output bytes differed from the exact fixture bytes.
    OutputMismatch {
        /// Stable case identity.
        case_id: String,
    },
    /// The typed error code differed from the exact fixture code.
    ErrorCodeMismatch {
        /// Stable case identity.
        case_id: String,
        /// Expected stable error code.
        expected_code: &'static str,
        /// Actual stable error code.
        actual_code: &'static str,
    },
}

impl fmt::Display for VectorVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => error.fmt(formatter),
            Self::UnexpectedError {
                case_id,
                actual_code,
            } => write!(
                formatter,
                "vector {case_id} expected success but returned {actual_code}"
            ),
            Self::UnexpectedSuccess { case_id } => {
                write!(
                    formatter,
                    "vector {case_id} expected an error but succeeded"
                )
            }
            Self::OutputMismatch { case_id } => {
                write!(
                    formatter,
                    "vector {case_id} returned different output bytes"
                )
            }
            Self::ErrorCodeMismatch {
                case_id,
                expected_code,
                actual_code,
            } => write!(
                formatter,
                "vector {case_id} expected {expected_code} but returned {actual_code}"
            ),
        }
    }
}

impl std::error::Error for VectorVerificationError {}

impl From<VectorParseError> for VectorVerificationError {
    fn from(value: VectorParseError) -> Self {
        Self::Parse(value)
    }
}

/// Executes every vector in declared order.
///
/// # Errors
///
/// Returns the first deterministic mismatch without including source bytes.
pub fn verify_vector_set(set: &VectorSet) -> Result<(), VectorVerificationError> {
    for case in set.cases() {
        let actual = validate_canonical_utf8_transport(case.input(), case.max_bytes());
        match (case.expected(), actual) {
            (ExpectedOutcome::Success { output }, Ok(value)) => {
                if value.as_bytes() != output {
                    return Err(VectorVerificationError::OutputMismatch {
                        case_id: case.case_id().to_owned(),
                    });
                }
            }
            (ExpectedOutcome::Success { .. }, Err(error)) => {
                return Err(VectorVerificationError::UnexpectedError {
                    case_id: case.case_id().to_owned(),
                    actual_code: error.code(),
                });
            }
            (ExpectedOutcome::Error(_expected), Ok(_value)) => {
                return Err(VectorVerificationError::UnexpectedSuccess {
                    case_id: case.case_id().to_owned(),
                });
            }
            (ExpectedOutcome::Error(expected), Err(actual_error)) => {
                let expected_code = expected.code();
                let actual_code = actual_error.code();
                if actual_code != expected_code {
                    return Err(VectorVerificationError::ErrorCodeMismatch {
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

/// Parses and executes the embedded M1 corpus.
///
/// # Errors
///
/// Returns a strict parse error or the first deterministic mismatch.
pub fn verify_embedded_vectors() -> Result<(), VectorVerificationError> {
    let set = parse_vector_set(crate::EMBEDDED_CANONICAL_UTF8_VECTORS)?;
    verify_vector_set(&set)
}

#[cfg(test)]
mod tests {
    use super::{VectorVerificationError, verify_embedded_vectors, verify_vector_set};
    use crate::parse_vector_set;

    #[test]
    fn embedded_vectors_pass() {
        assert_eq!(verify_embedded_vectors(), Ok(()));
    }

    #[test]
    fn detects_success_output_mismatch() {
        let input = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
wrong_output|1|61|ok|62|-
";
        let parsed = parse_vector_set(input);
        assert!(parsed.is_ok());
        let Ok(set) = parsed else {
            return;
        };

        assert!(matches!(
            verify_vector_set(&set),
            Err(VectorVerificationError::OutputMismatch { case_id })
                if case_id == "wrong_output"
        ));
    }

    #[test]
    fn detects_unexpected_success() {
        let input = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
wrong_error|1|61|error|-|ELIOTR_UTF8_INVALID
";
        let parsed = parse_vector_set(input);
        assert!(parsed.is_ok());
        let Ok(set) = parsed else {
            return;
        };

        assert!(matches!(
            verify_vector_set(&set),
            Err(VectorVerificationError::UnexpectedSuccess { case_id })
                if case_id == "wrong_error"
        ));
    }

    #[test]
    fn detects_error_code_mismatch() {
        let input = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
wrong_code|0|ff|error|-|ELIOTR_UTF8_INVALID
";
        let parsed = parse_vector_set(input);
        assert!(parsed.is_ok());
        let Ok(set) = parsed else {
            return;
        };

        assert!(matches!(
            verify_vector_set(&set),
            Err(VectorVerificationError::ErrorCodeMismatch {
                case_id,
                expected_code: "ELIOTR_UTF8_INVALID",
                actual_code: "ELIOTR_UTF8_TOO_LARGE",
            }) if case_id == "wrong_code"
        ));
    }

    #[test]
    fn detects_unexpected_error() {
        let input = "\
# protocol=eliotr.test-vectors.canonical-utf8.v1
# schema_generation=1
# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code
wrong_success|0|61|ok|61|-
";
        let parsed = parse_vector_set(input);
        assert!(parsed.is_ok());
        let Ok(set) = parsed else {
            return;
        };

        assert!(matches!(
            verify_vector_set(&set),
            Err(VectorVerificationError::UnexpectedError {
                case_id,
                actual_code: "ELIOTR_UTF8_TOO_LARGE",
            }) if case_id == "wrong_success"
        ));
    }
}
