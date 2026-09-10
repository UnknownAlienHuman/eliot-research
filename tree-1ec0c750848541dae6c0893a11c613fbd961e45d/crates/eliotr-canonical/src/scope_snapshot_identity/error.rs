//! Content-free `scope-snapshot-identity.v1` rejection vocabulary.
//!
//! Every failure carries byte offsets, byte budgets or depth ceilings only. Source
//! bytes, identifiers, digests and timestamps never appear in a code or message.

#![forbid(unsafe_code)]

use core::fmt;

pub const SNAPSHOT_INPUT_TOO_LARGE_CODE: &str = "ELIOTR_SNAPSHOT_INPUT_TOO_LARGE";
pub const SNAPSHOT_UTF8_CODE: &str = "ELIOTR_SNAPSHOT_UTF8";
pub const SNAPSHOT_SYNTAX_CODE: &str = "ELIOTR_SNAPSHOT_SYNTAX";
pub const SNAPSHOT_DUPLICATE_KEY_CODE: &str = "ELIOTR_SNAPSHOT_DUPLICATE_KEY";
pub const SNAPSHOT_UNICODE_CODE: &str = "ELIOTR_SNAPSHOT_UNICODE";
pub const SNAPSHOT_NUMBER_CODE: &str = "ELIOTR_SNAPSHOT_NUMBER";
pub const SNAPSHOT_DEPTH_LIMIT_CODE: &str = "ELIOTR_SNAPSHOT_DEPTH_LIMIT";
pub const SNAPSHOT_MEMBER_LIMIT_CODE: &str = "ELIOTR_SNAPSHOT_MEMBER_LIMIT";
pub const SNAPSHOT_NODE_LIMIT_CODE: &str = "ELIOTR_SNAPSHOT_NODE_LIMIT";
pub const SNAPSHOT_STRING_TOO_LARGE_CODE: &str = "ELIOTR_SNAPSHOT_STRING_TOO_LARGE";
pub const SNAPSHOT_OUTPUT_TOO_LARGE_CODE: &str = "ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE";
pub const SNAPSHOT_SHAPE_CODE: &str = "ELIOTR_SNAPSHOT_SHAPE";
pub const SNAPSHOT_MISSING_FIELD_CODE: &str = "ELIOTR_SNAPSHOT_MISSING_FIELD";
pub const SNAPSHOT_UNKNOWN_FIELD_CODE: &str = "ELIOTR_SNAPSHOT_UNKNOWN_FIELD";
pub const SNAPSHOT_IDENTIFIER_CODE: &str = "ELIOTR_SNAPSHOT_IDENTIFIER";
pub const SNAPSHOT_DIGEST_CODE: &str = "ELIOTR_SNAPSHOT_DIGEST";
pub const SNAPSHOT_REVISION_CODE: &str = "ELIOTR_SNAPSHOT_REVISION";
pub const SNAPSHOT_TIMESTAMP_CODE: &str = "ELIOTR_SNAPSHOT_TIMESTAMP";
pub const SNAPSHOT_EXPRESSION_CODE: &str = "ELIOTR_SNAPSHOT_EXPRESSION";
pub const SNAPSHOT_ID_MISMATCH_CODE: &str = "ELIOTR_SNAPSHOT_ID_MISMATCH";
pub const SNAPSHOT_DIGEST_MISMATCH_CODE: &str = "ELIOTR_SNAPSHOT_DIGEST_MISMATCH";

/// Deterministic, content-free snapshot-identity rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotIdentityError {
    InputTooLarge {
        actual_bytes: usize,
        max_bytes: usize,
    },
    InvalidUtf8 {
        valid_up_to: usize,
    },
    Syntax {
        offset: usize,
    },
    DuplicateKey {
        offset: usize,
    },
    Unicode {
        offset: usize,
    },
    Number {
        offset: usize,
    },
    DepthLimit {
        max_depth: usize,
    },
    MemberLimit {
        max_members: usize,
    },
    NodeLimit {
        max_nodes: usize,
    },
    StringTooLarge {
        max_bytes: usize,
    },
    OutputTooLarge {
        max_bytes: usize,
    },
    Shape,
    MissingField,
    UnknownField,
    Identifier,
    Digest,
    Revision,
    Timestamp,
    Expression,
    IdMismatch,
    DigestMismatch,
}

impl SnapshotIdentityError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge { .. } => SNAPSHOT_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 { .. } => SNAPSHOT_UTF8_CODE,
            Self::Syntax { .. } => SNAPSHOT_SYNTAX_CODE,
            Self::DuplicateKey { .. } => SNAPSHOT_DUPLICATE_KEY_CODE,
            Self::Unicode { .. } => SNAPSHOT_UNICODE_CODE,
            Self::Number { .. } => SNAPSHOT_NUMBER_CODE,
            Self::DepthLimit { .. } => SNAPSHOT_DEPTH_LIMIT_CODE,
            Self::MemberLimit { .. } => SNAPSHOT_MEMBER_LIMIT_CODE,
            Self::NodeLimit { .. } => SNAPSHOT_NODE_LIMIT_CODE,
            Self::StringTooLarge { .. } => SNAPSHOT_STRING_TOO_LARGE_CODE,
            Self::OutputTooLarge { .. } => SNAPSHOT_OUTPUT_TOO_LARGE_CODE,
            Self::Shape => SNAPSHOT_SHAPE_CODE,
            Self::MissingField => SNAPSHOT_MISSING_FIELD_CODE,
            Self::UnknownField => SNAPSHOT_UNKNOWN_FIELD_CODE,
            Self::Identifier => SNAPSHOT_IDENTIFIER_CODE,
            Self::Digest => SNAPSHOT_DIGEST_CODE,
            Self::Revision => SNAPSHOT_REVISION_CODE,
            Self::Timestamp => SNAPSHOT_TIMESTAMP_CODE,
            Self::Expression => SNAPSHOT_EXPRESSION_CODE,
            Self::IdMismatch => SNAPSHOT_ID_MISMATCH_CODE,
            Self::DigestMismatch => SNAPSHOT_DIGEST_MISMATCH_CODE,
        }
    }
}

impl fmt::Display for SnapshotIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                f,
                "snapshot input has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::InvalidUtf8 { valid_up_to } => write!(
                f,
                "snapshot input is invalid after byte offset {valid_up_to}"
            ),
            Self::Syntax { offset } => {
                write!(f, "snapshot JSON syntax error at byte offset {offset}")
            }
            Self::DuplicateKey { offset } => write!(
                f,
                "snapshot JSON duplicate object key at byte offset {offset}"
            ),
            Self::Unicode { offset } => write!(
                f,
                "snapshot JSON Unicode escape is invalid at byte offset {offset}"
            ),
            Self::Number { offset } => write!(
                f,
                "snapshot JSON number is unsupported at byte offset {offset}"
            ),
            Self::DepthLimit { max_depth } => {
                write!(f, "snapshot JSON nesting exceeds maximum depth {max_depth}")
            }
            Self::MemberLimit { max_members } => {
                write!(f, "snapshot member count exceeds maximum {max_members}")
            }
            Self::NodeLimit { max_nodes } => {
                write!(
                    f,
                    "snapshot JSON value exceeds maximum node count {max_nodes}"
                )
            }
            Self::StringTooLarge { max_bytes } => write!(
                f,
                "snapshot JSON string exceeds maximum decoded size {max_bytes}"
            ),
            Self::OutputTooLarge { max_bytes } => write!(
                f,
                "snapshot canonical output exceeds maximum size {max_bytes}"
            ),
            Self::Shape => write!(f, "snapshot value has the wrong shape"),
            Self::MissingField => write!(f, "snapshot object is missing a field"),
            Self::UnknownField => write!(f, "snapshot object contains an unknown field"),
            Self::Identifier => write!(f, "snapshot identifier is invalid"),
            Self::Digest => write!(f, "snapshot digest is invalid"),
            Self::Revision => write!(f, "snapshot revision is invalid"),
            Self::Timestamp => write!(f, "snapshot timestamp is invalid"),
            Self::Expression => write!(f, "snapshot scope expression is invalid"),
            Self::IdMismatch => write!(f, "snapshot identifier does not match its payload"),
            Self::DigestMismatch => write!(f, "snapshot digest does not match its payload"),
        }
    }
}

impl std::error::Error for SnapshotIdentityError {}
