//! Deterministic execution of the `scope-snapshot-identity.v1` conformance corpus.
//!
//! Every declared case runs through the native kernel in order. The same committed
//! bytes execute through the independent TypeScript reference and the compiled
//! Rust/Wasm verifier; this module reports the first mismatch without source bytes.

#![forbid(unsafe_code)]

use core::fmt;

use eliotr_canonical::{derive_snapshot_identity, verify_snapshot_identity};

use super::EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS;
use super::model::{
    ScopeSnapshotIdentityExpectedOutcome, ScopeSnapshotIdentityOperation,
    ScopeSnapshotIdentityVector, ScopeSnapshotIdentityVectorSet,
};
use super::parser::ScopeSnapshotIdentityParseError;
use super::parser::parse_scope_snapshot_identity_vector_set;

/// Parse or semantic mismatch without source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeSnapshotIdentityVerificationError {
    Parse(ScopeSnapshotIdentityParseError),
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

impl fmt::Display for ScopeSnapshotIdentityVerificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(e) => e.fmt(f),
            Self::UnexpectedError {
                case_id,
                actual_code,
            } => write!(
                f,
                "scope-snapshot-identity vector {case_id} expected success but returned {actual_code}"
            ),
            Self::UnexpectedSuccess { case_id } => write!(
                f,
                "scope-snapshot-identity vector {case_id} expected an error but succeeded"
            ),
            Self::OutputMismatch { case_id } => write!(
                f,
                "scope-snapshot-identity vector {case_id} returned different output bytes"
            ),
            Self::ErrorCodeMismatch {
                case_id,
                expected_code,
                actual_code,
            } => write!(
                f,
                "scope-snapshot-identity vector {case_id} expected {expected_code} but returned {actual_code}"
            ),
        }
    }
}

impl std::error::Error for ScopeSnapshotIdentityVerificationError {}

impl From<ScopeSnapshotIdentityParseError> for ScopeSnapshotIdentityVerificationError {
    fn from(value: ScopeSnapshotIdentityParseError) -> Self {
        Self::Parse(value)
    }
}

enum ActualOutcome {
    Success(Vec<u8>),
    Error(&'static str),
}

fn execute(case: &ScopeSnapshotIdentityVector) -> ActualOutcome {
    match case.operation() {
        ScopeSnapshotIdentityOperation::DeriveSnapshotIdentity => {
            match derive_snapshot_identity(case.input()) {
                Ok(output) => ActualOutcome::Success(output),
                Err(error) => ActualOutcome::Error(error.code()),
            }
        }
        super::model::ScopeSnapshotIdentityOperation::VerifySnapshotIdentity => {
            match verify_snapshot_identity(case.input()) {
                Ok(output) => ActualOutcome::Success(output),
                Err(error) => ActualOutcome::Error(error.code()),
            }
        }
    }
}

/// Executes every declared scope-snapshot-identity vector in order.
///
/// # Errors
///
/// Returns the first deterministic semantic mismatch.
pub fn verify_scope_snapshot_identity_vector_set(
    set: &ScopeSnapshotIdentityVectorSet,
) -> Result<(), ScopeSnapshotIdentityVerificationError> {
    for case in set.cases() {
        let actual = execute(case);
        match (case.expected(), actual) {
            (
                ScopeSnapshotIdentityExpectedOutcome::Success { output },
                ActualOutcome::Success(actual_output),
            ) => {
                if actual_output.as_slice() != output.as_slice() {
                    return Err(ScopeSnapshotIdentityVerificationError::OutputMismatch {
                        case_id: case.case_id().to_owned(),
                    });
                }
            }
            (
                ScopeSnapshotIdentityExpectedOutcome::Success { .. },
                ActualOutcome::Error(actual_code),
            ) => {
                return Err(ScopeSnapshotIdentityVerificationError::UnexpectedError {
                    case_id: case.case_id().to_owned(),
                    actual_code,
                });
            }
            (ScopeSnapshotIdentityExpectedOutcome::Error(_), ActualOutcome::Success(_)) => {
                return Err(ScopeSnapshotIdentityVerificationError::UnexpectedSuccess {
                    case_id: case.case_id().to_owned(),
                });
            }
            (
                ScopeSnapshotIdentityExpectedOutcome::Error(expected),
                ActualOutcome::Error(actual_code),
            ) => {
                if expected.code() != actual_code {
                    return Err(ScopeSnapshotIdentityVerificationError::ErrorCodeMismatch {
                        case_id: case.case_id().to_owned(),
                        expected_code: expected.code(),
                        actual_code,
                    });
                }
            }
        }
    }
    Ok(())
}

/// Parses and executes the exact embedded scope-snapshot-identity corpus.
///
/// # Errors
///
/// Returns the first strict parse or semantic mismatch.
pub fn verify_embedded_scope_snapshot_identity_vectors()
-> Result<(), ScopeSnapshotIdentityVerificationError> {
    let vectors =
        parse_scope_snapshot_identity_vector_set(EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS)?;
    verify_scope_snapshot_identity_vector_set(&vectors)
}
