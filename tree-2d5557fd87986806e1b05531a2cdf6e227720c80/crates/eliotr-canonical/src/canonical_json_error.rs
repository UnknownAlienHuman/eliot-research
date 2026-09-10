//! Stable limits and content-free errors for canonical-body JSON.

#![forbid(unsafe_code)]

use core::fmt;

/// Maximum admitted input size for one canonical body.
pub const MAX_CANONICAL_JSON_INPUT_BYTES: usize = 128 * 1024;
/// Maximum emitted canonical body size.
pub const MAX_CANONICAL_JSON_OUTPUT_BYTES: usize = 96 * 1024;
/// Maximum decoded UTF-8 bytes in one JSON string.
pub const MAX_CANONICAL_JSON_STRING_BYTES: usize = 32 * 1024;
/// Maximum nested array/object depth.
pub const MAX_CANONICAL_JSON_DEPTH: usize = 64;
/// Maximum members in one object.
pub const MAX_CANONICAL_JSON_OBJECT_MEMBERS: usize = 128;
/// Maximum items in one array.
pub const MAX_CANONICAL_JSON_ARRAY_ITEMS: usize = 256;
/// Maximum total JSON values in one body.
pub const MAX_CANONICAL_JSON_NODES: usize = 1024;
/// Largest integer represented identically by the TypeScript reference and Rust/Wasm.
pub const MAX_CANONICAL_JSON_INTEGER: i64 = 9_007_199_254_740_991;

/// Stable canonical-body error codes.
pub const JSON_INPUT_TOO_LARGE_CODE: &str = "ELIOTR_JSON_INPUT_TOO_LARGE";
pub const JSON_INVALID_UTF8_CODE: &str = "ELIOTR_JSON_INVALID_UTF8";
pub const JSON_SYNTAX_CODE: &str = "ELIOTR_JSON_SYNTAX";
pub const JSON_DUPLICATE_KEY_CODE: &str = "ELIOTR_JSON_DUPLICATE_KEY";
pub const JSON_DEPTH_LIMIT_CODE: &str = "ELIOTR_JSON_DEPTH_LIMIT";
pub const JSON_MEMBER_LIMIT_CODE: &str = "ELIOTR_JSON_MEMBER_LIMIT";
pub const JSON_ITEM_LIMIT_CODE: &str = "ELIOTR_JSON_ITEM_LIMIT";
pub const JSON_NODE_LIMIT_CODE: &str = "ELIOTR_JSON_NODE_LIMIT";
pub const JSON_STRING_TOO_LARGE_CODE: &str = "ELIOTR_JSON_STRING_TOO_LARGE";
pub const JSON_NUMBER_CODE: &str = "ELIOTR_JSON_NUMBER";
pub const JSON_UNICODE_CODE: &str = "ELIOTR_JSON_UNICODE";
pub const JSON_OUTPUT_TOO_LARGE_CODE: &str = "ELIOTR_JSON_OUTPUT_TOO_LARGE";

/// A deterministic, content-free canonical JSON rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalJsonError {
    /// Complete input exceeded the explicit byte budget.
    InputTooLarge {
        /// Observed bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// Input was not valid UTF-8.
    InvalidUtf8 {
        /// Valid prefix length.
        valid_up_to: usize,
    },
    /// JSON grammar was invalid or trailing bytes remained.
    Syntax {
        /// Byte offset of the rejection.
        offset: usize,
    },
    /// Two decoded object keys were equal.
    DuplicateKey {
        /// Byte offset at which the duplicate key began.
        offset: usize,
    },
    /// Nested containers exceeded the explicit depth budget.
    DepthLimit {
        /// Maximum admitted depth.
        max_depth: usize,
    },
    /// One object exceeded its member budget.
    MemberLimit {
        /// Maximum admitted members.
        max_members: usize,
    },
    /// One array exceeded its item budget.
    ItemLimit {
        /// Maximum admitted items.
        max_items: usize,
    },
    /// The complete value exceeded its node budget.
    NodeLimit {
        /// Maximum admitted nodes.
        max_nodes: usize,
    },
    /// One decoded string exceeded its UTF-8 byte budget.
    StringTooLarge {
        /// Maximum admitted decoded bytes.
        max_bytes: usize,
    },
    /// A numeric token was non-canonical or outside the safe integer range.
    Number {
        /// Byte offset at which the number began.
        offset: usize,
    },
    /// A Unicode escape was malformed or contained an unpaired surrogate.
    Unicode {
        /// Byte offset of the rejected escape.
        offset: usize,
    },
    /// Canonical output exceeded its explicit byte budget.
    OutputTooLarge {
        /// Maximum emitted bytes.
        max_bytes: usize,
    },
}

impl CanonicalJsonError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge { .. } => JSON_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 { .. } => JSON_INVALID_UTF8_CODE,
            Self::Syntax { .. } => JSON_SYNTAX_CODE,
            Self::DuplicateKey { .. } => JSON_DUPLICATE_KEY_CODE,
            Self::DepthLimit { .. } => JSON_DEPTH_LIMIT_CODE,
            Self::MemberLimit { .. } => JSON_MEMBER_LIMIT_CODE,
            Self::ItemLimit { .. } => JSON_ITEM_LIMIT_CODE,
            Self::NodeLimit { .. } => JSON_NODE_LIMIT_CODE,
            Self::StringTooLarge { .. } => JSON_STRING_TOO_LARGE_CODE,
            Self::Number { .. } => JSON_NUMBER_CODE,
            Self::Unicode { .. } => JSON_UNICODE_CODE,
            Self::OutputTooLarge { .. } => JSON_OUTPUT_TOO_LARGE_CODE,
        }
    }
}

impl fmt::Display for CanonicalJsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "canonical JSON input has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::InvalidUtf8 { valid_up_to } => write!(
                formatter,
                "canonical JSON input is invalid after byte offset {valid_up_to}"
            ),
            Self::Syntax { offset } => {
                write!(
                    formatter,
                    "canonical JSON syntax error at byte offset {offset}"
                )
            }
            Self::DuplicateKey { offset } => write!(
                formatter,
                "canonical JSON duplicate object key at byte offset {offset}"
            ),
            Self::DepthLimit { max_depth } => write!(
                formatter,
                "canonical JSON nesting exceeds maximum depth {max_depth}"
            ),
            Self::MemberLimit { max_members } => write!(
                formatter,
                "canonical JSON object exceeds maximum member count {max_members}"
            ),
            Self::ItemLimit { max_items } => write!(
                formatter,
                "canonical JSON array exceeds maximum item count {max_items}"
            ),
            Self::NodeLimit { max_nodes } => write!(
                formatter,
                "canonical JSON value exceeds maximum node count {max_nodes}"
            ),
            Self::StringTooLarge { max_bytes } => write!(
                formatter,
                "canonical JSON string exceeds maximum decoded size {max_bytes}"
            ),
            Self::Number { offset } => write!(
                formatter,
                "canonical JSON number is unsupported at byte offset {offset}"
            ),
            Self::Unicode { offset } => write!(
                formatter,
                "canonical JSON Unicode escape is invalid at byte offset {offset}"
            ),
            Self::OutputTooLarge { max_bytes } => write!(
                formatter,
                "canonical JSON output exceeds maximum size {max_bytes}"
            ),
        }
    }
}

impl std::error::Error for CanonicalJsonError {}
