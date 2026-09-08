//! Deterministic `eliotr.source-owner.initial.v1` owner-token shadow primitive.
//!
//! The normative preimage is the exact canonical JSON tuple
//! `["eliotr.source-owner.initial.v1", namespace, "eliotr", incarnation, 1, "ACTIVE"]`
//! encoded as UTF-8. The token is `owner-` followed by the full lowercase SHA-256 digest of
//! those canonical bytes. Admission-policy revision and principal are deliberately not bound:
//! a policy-only change leaves the token stable, while a namespace or incarnation change
//! yields a different token.
//!
//! This module never performs I/O, clock reads, randomness, or environment access. Callers pass
//! explicit bytes and receive a deterministic token or a content-free typed error. The NUL-joined,
//! truncated, and `g1_` stable-ID families are never used here, and no D1/R2/Queue effect occurs.

#![forbid(unsafe_code)]

use core::fmt;

use crate::owner_token_tuple::TupleParser;
use crate::sha256::sha256;

/// Exact schema bound into every initial owner-token preimage.
pub const OWNER_TOKEN_SCHEMA: &str = "eliotr.source-owner.initial.v1";
/// Exact owner system bound into every initial owner-token preimage.
pub const OWNER_TOKEN_OWNER_SYSTEM_ID: &str = "eliotr";
/// Exact ownership-record revision bound into every initial owner-token preimage.
pub const OWNER_TOKEN_REVISION: i64 = 1;
/// Exact owner status bound into every initial owner-token preimage.
pub const OWNER_TOKEN_STATUS: &str = "ACTIVE";
/// Canonical token prefix for the initial owner-token family.
pub const OWNER_TOKEN_PREFIX: &str = "owner-";
/// Number of lowercase hexadecimal digest characters retained in the token.
pub const OWNER_TOKEN_DIGEST_HEX_BYTES: usize = 64;
/// Exact token length in UTF-8/ASCII bytes.
pub const OWNER_TOKEN_BYTES: usize = OWNER_TOKEN_PREFIX.len() + OWNER_TOKEN_DIGEST_HEX_BYTES;
/// Minimum admitted identifier length in bytes (ASCII, so bytes equal characters).
pub const OWNER_TOKEN_ID_MIN_BYTES: usize = 1;
/// Maximum admitted identifier length in bytes (matches the local-namespace ID rule).
pub const OWNER_TOKEN_ID_MAX_BYTES: usize = 256;
/// Maximum admitted preimage length in bytes, checked before parsing or allocation.
/// The largest valid preimage is 572 bytes; this ceiling admits it with headroom while
/// rejecting unbounded input before deeper work.
pub const OWNER_TOKEN_PREIMAGE_MAX_BYTES: usize = 2048;
/// Maximum loop iterations in one tuple-parser pass (S5 bounded-iteration guard).
/// Normal inputs consume at most one iteration per input byte; mutants that remove
/// cursor progress (`+=`→`*=`, `utf8_width`→`Some(0)`) exhaust this budget instead
/// of spinning forever.
pub const OWNER_TOKEN_PARSER_STEPS_MAX: usize = OWNER_TOKEN_PREIMAGE_MAX_BYTES + 1;

/// Stable error code for an oversized preimage.
pub const OWNER_TOKEN_INPUT_TOO_LARGE_CODE: &str = "ELIOTR_OWNER_TOKEN_INPUT_TOO_LARGE";
/// Stable error code for invalid UTF-8.
pub const OWNER_TOKEN_UTF8_CODE: &str = "ELIOTR_OWNER_TOKEN_UTF8";
/// Stable error code for malformed JSON framing.
pub const OWNER_TOKEN_SYNTAX_CODE: &str = "ELIOTR_OWNER_TOKEN_SYNTAX";
/// Stable error code for a malformed Unicode escape.
pub const OWNER_TOKEN_UNICODE_CODE: &str = "ELIOTR_OWNER_TOKEN_UNICODE";
/// Stable error code for a well-formed JSON value with the wrong tuple shape or field types.
pub const OWNER_TOKEN_SHAPE_CODE: &str = "ELIOTR_OWNER_TOKEN_SHAPE";
/// Stable error code for an unexpected schema string.
pub const OWNER_TOKEN_SCHEMA_CODE: &str = "ELIOTR_OWNER_TOKEN_SCHEMA";
/// Stable error code for a rejected namespace identifier.
pub const OWNER_TOKEN_NAMESPACE_CODE: &str = "ELIOTR_OWNER_TOKEN_NAMESPACE";
/// Stable error code for a rejected incarnation identifier.
pub const OWNER_TOKEN_INCARNATION_CODE: &str = "ELIOTR_OWNER_TOKEN_INCARNATION";
/// Stable error code for a non-`eliotr` owner system (external owner).
pub const OWNER_TOKEN_OWNER_CODE: &str = "ELIOTR_OWNER_TOKEN_OWNER";
/// Stable error code for a revision other than 1 (wrong generation / lineage).
pub const OWNER_TOKEN_REVISION_CODE: &str = "ELIOTR_OWNER_TOKEN_REVISION";
/// Stable error code for a status other than `ACTIVE` (fenced / retired).
pub const OWNER_TOKEN_STATE_CODE: &str = "ELIOTR_OWNER_TOKEN_STATE";
/// Stable error code for a token with the wrong byte length.
pub const OWNER_TOKEN_LENGTH_CODE: &str = "ELIOTR_OWNER_TOKEN_LENGTH";
/// Stable error code for a token with the wrong prefix.
pub const OWNER_TOKEN_PREFIX_CODE: &str = "ELIOTR_OWNER_TOKEN_PREFIX";
/// Stable error code for a token digest outside lowercase hexadecimal.
pub const OWNER_TOKEN_ALPHABET_CODE: &str = "ELIOTR_OWNER_TOKEN_ALPHABET";

/// Deterministic, content-free owner-token rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerTokenError {
    /// Complete preimage exceeded its explicit byte budget.
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
    /// JSON framing was malformed or trailing bytes remained.
    Syntax {
        /// Byte offset of the rejection.
        offset: usize,
    },
    /// A Unicode escape was malformed or held an unpaired surrogate.
    Unicode {
        /// Byte offset of the rejected escape.
        offset: usize,
    },
    /// A parsed JSON value had the wrong tuple arity or field types.
    /// A seventh element (for example a smuggled policy revision) is rejected here.
    Shape,
    /// The schema string differed from the initial-owner schema.
    Schema,
    /// The namespace was empty, too long, non-ASCII, or outside the ID grammar.
    Namespace,
    /// The incarnation was empty, too long, non-ASCII, or outside the ID grammar.
    Incarnation,
    /// The owner system differed from `eliotr`.
    Owner,
    /// The revision differed from 1.
    Revision,
    /// The status differed from `ACTIVE`.
    State,
    /// A complete token had the wrong byte length.
    InvalidLength {
        /// Observed bytes.
        actual_bytes: usize,
        /// Minimum admitted bytes.
        min_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// A complete token had the wrong prefix.
    Prefix,
    /// A token digest byte was not lowercase hexadecimal.
    InvalidAlphabet {
        /// Byte offset of the first rejected digest byte.
        offset: usize,
    },
}

impl OwnerTokenError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge { .. } => OWNER_TOKEN_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 { .. } => OWNER_TOKEN_UTF8_CODE,
            Self::Syntax { .. } => OWNER_TOKEN_SYNTAX_CODE,
            Self::Unicode { .. } => OWNER_TOKEN_UNICODE_CODE,
            Self::Shape => OWNER_TOKEN_SHAPE_CODE,
            Self::Schema => OWNER_TOKEN_SCHEMA_CODE,
            Self::Namespace => OWNER_TOKEN_NAMESPACE_CODE,
            Self::Incarnation => OWNER_TOKEN_INCARNATION_CODE,
            Self::Owner => OWNER_TOKEN_OWNER_CODE,
            Self::Revision => OWNER_TOKEN_REVISION_CODE,
            Self::State => OWNER_TOKEN_STATE_CODE,
            Self::InvalidLength { .. } => OWNER_TOKEN_LENGTH_CODE,
            Self::Prefix => OWNER_TOKEN_PREFIX_CODE,
            Self::InvalidAlphabet { .. } => OWNER_TOKEN_ALPHABET_CODE,
        }
    }
}

impl fmt::Display for OwnerTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "owner-token preimage has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::InvalidUtf8 { valid_up_to } => write!(
                formatter,
                "owner-token input is invalid after byte offset {valid_up_to}"
            ),
            Self::Syntax { offset } => write!(
                formatter,
                "owner-token JSON syntax error at byte offset {offset}"
            ),
            Self::Unicode { offset } => write!(
                formatter,
                "owner-token Unicode escape is invalid at byte offset {offset}"
            ),
            Self::Shape => write!(formatter, "owner-token preimage has the wrong tuple shape"),
            Self::Schema => write!(formatter, "owner-token schema is invalid"),
            Self::Namespace => write!(formatter, "owner-token namespace is invalid"),
            Self::Incarnation => write!(formatter, "owner-token incarnation is invalid"),
            Self::Owner => write!(formatter, "owner-token owner system is invalid"),
            Self::Revision => write!(formatter, "owner-token revision is invalid"),
            Self::State => write!(formatter, "owner-token status is invalid"),
            Self::InvalidLength {
                actual_bytes,
                min_bytes,
                max_bytes,
            } => write!(
                formatter,
                "owner token has {actual_bytes} bytes; admitted range is {min_bytes}..={max_bytes}"
            ),
            Self::Prefix => write!(formatter, "owner-token prefix is invalid"),
            Self::InvalidAlphabet { offset } => write!(
                formatter,
                "owner-token digest contains a non-lowercase-hex byte at offset {offset}"
            ),
        }
    }
}

impl std::error::Error for OwnerTokenError {}

/// Derives the initial owner token for an explicit namespace/incarnation pair.
///
/// Identifiers follow the local-namespace ID rule: 1 to 256 ASCII bytes, a leading ASCII
/// alphanumeric, then ASCII alphanumerics or `.`, `_`, `:`, `@`, `/`, `-`. Unicode, empty,
/// over-long, and prototype-shaped (`__proto__`) identifiers are rejected.
///
/// # Errors
///
/// Returns a typed, content-free error for invalid UTF-8 or a rejected identifier.
pub fn derive_owner_token(namespace: &[u8], incarnation: &[u8]) -> Result<String, OwnerTokenError> {
    let namespace_text = validate_id(namespace, true)?;
    let incarnation_text = validate_id(incarnation, false)?;
    Ok(format_owner_token(&canonical_preimage(
        namespace_text,
        incarnation_text,
    )))
}

/// Derives the initial owner token from exact candidate preimage bytes.
///
/// The preimage must be the canonical JSON tuple; surrounding whitespace is tolerated and the
/// digest always binds the re-encoded canonical bytes, so an escaped-but-equal tuple yields the
/// same token. A seventh element, a foreign owner, a non-1 revision, or a non-`ACTIVE` status
/// is rejected; policy revisions and principals have no position in this tuple.
///
/// # Errors
///
/// Returns a typed, content-free error for oversized, non-UTF-8, malformed, or semantically
/// invalid preimages.
pub fn derive_owner_token_from_preimage(preimage: &[u8]) -> Result<String, OwnerTokenError> {
    if preimage.len() > OWNER_TOKEN_PREIMAGE_MAX_BYTES {
        return Err(OwnerTokenError::InputTooLarge {
            actual_bytes: preimage.len(),
            max_bytes: OWNER_TOKEN_PREIMAGE_MAX_BYTES,
        });
    }
    core::str::from_utf8(preimage).map_err(|error| OwnerTokenError::InvalidUtf8 {
        valid_up_to: error.valid_up_to(),
    })?;
    let tuple = TupleParser::new(preimage).parse()?;
    if tuple.schema != OWNER_TOKEN_SCHEMA {
        return Err(OwnerTokenError::Schema);
    }
    if validate_id_bytes(tuple.namespace.as_bytes(), true).is_err() {
        return Err(OwnerTokenError::Namespace);
    }
    if tuple.owner != OWNER_TOKEN_OWNER_SYSTEM_ID {
        return Err(OwnerTokenError::Owner);
    }
    if validate_id_bytes(tuple.incarnation.as_bytes(), false).is_err() {
        return Err(OwnerTokenError::Incarnation);
    }
    if tuple.revision != OWNER_TOKEN_REVISION {
        return Err(OwnerTokenError::Revision);
    }
    if tuple.status != OWNER_TOKEN_STATUS {
        return Err(OwnerTokenError::State);
    }
    Ok(format_owner_token(&canonical_preimage(
        &tuple.namespace,
        &tuple.incarnation,
    )))
}

/// Validates one complete `owner-` token without normalization.
///
/// Length is checked before UTF-8 decoding so an oversized malformed token receives the bounded
/// length error rather than consuming deeper work.
///
/// # Errors
///
/// Returns a typed error for wrong length, invalid UTF-8, wrong prefix, or a non-lowercase-hex
/// digest byte.
pub fn validate_owner_token(input: &[u8]) -> Result<&str, OwnerTokenError> {
    if input.len() != OWNER_TOKEN_BYTES {
        return Err(OwnerTokenError::InvalidLength {
            actual_bytes: input.len(),
            min_bytes: OWNER_TOKEN_BYTES,
            max_bytes: OWNER_TOKEN_BYTES,
        });
    }
    let text = core::str::from_utf8(input).map_err(|error| OwnerTokenError::InvalidUtf8 {
        valid_up_to: error.valid_up_to(),
    })?;
    if !input.starts_with(OWNER_TOKEN_PREFIX.as_bytes()) {
        return Err(OwnerTokenError::Prefix);
    }
    for (index, byte) in input[OWNER_TOKEN_PREFIX.len()..].iter().enumerate() {
        if !matches!(byte, b'0'..=b'9' | b'a'..=b'f') {
            return Err(OwnerTokenError::InvalidAlphabet {
                offset: OWNER_TOKEN_PREFIX.len() + index,
            });
        }
    }
    Ok(text)
}

fn validate_id(input: &[u8], is_namespace: bool) -> Result<&str, OwnerTokenError> {
    let text = core::str::from_utf8(input).map_err(|error| OwnerTokenError::InvalidUtf8 {
        valid_up_to: error.valid_up_to(),
    })?;
    validate_id_bytes(input, is_namespace)?;
    Ok(text)
}

fn validate_id_bytes(input: &[u8], is_namespace: bool) -> Result<(), OwnerTokenError> {
    if !(OWNER_TOKEN_ID_MIN_BYTES..=OWNER_TOKEN_ID_MAX_BYTES).contains(&input.len()) {
        return Err(if is_namespace {
            OwnerTokenError::Namespace
        } else {
            OwnerTokenError::Incarnation
        });
    }
    let Some((&first, remaining)) = input.split_first() else {
        return Err(if is_namespace {
            OwnerTokenError::Namespace
        } else {
            OwnerTokenError::Incarnation
        });
    };
    if !first.is_ascii_alphanumeric()
        || !remaining.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        })
    {
        return Err(if is_namespace {
            OwnerTokenError::Namespace
        } else {
            OwnerTokenError::Incarnation
        });
    }
    Ok(())
}

fn canonical_preimage(namespace: &str, incarnation: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + namespace.len() + incarnation.len());
    out.extend_from_slice(b"[\"");
    out.extend_from_slice(OWNER_TOKEN_SCHEMA.as_bytes());
    out.extend_from_slice(b"\",\"");
    out.extend_from_slice(namespace.as_bytes());
    out.extend_from_slice(b"\",\"");
    out.extend_from_slice(OWNER_TOKEN_OWNER_SYSTEM_ID.as_bytes());
    out.extend_from_slice(b"\",\"");
    out.extend_from_slice(incarnation.as_bytes());
    out.extend_from_slice(b"\",1,\"");
    out.extend_from_slice(OWNER_TOKEN_STATUS.as_bytes());
    out.extend_from_slice(b"\"]");
    out
}

fn format_owner_token(canonical_bytes: &[u8]) -> String {
    let digest = sha256(canonical_bytes);
    let mut token = String::with_capacity(OWNER_TOKEN_BYTES);
    token.push_str(OWNER_TOKEN_PREFIX);
    for byte in digest {
        token.push(char::from(lower_hex(byte >> 4)));
        token.push(char::from(lower_hex(byte & 0x0f)));
    }
    token
}

const fn lower_hex(nibble: u8) -> u8 {
    match nibble {
        0..=9 => b'0' + nibble,
        _ => b'a' + (nibble - 10),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        OWNER_TOKEN_BYTES, OWNER_TOKEN_PREFIX_CODE, OWNER_TOKEN_UTF8_CODE, OwnerTokenError,
        derive_owner_token, derive_owner_token_from_preimage, validate_owner_token,
    };

    #[test]
    fn derives_the_operational_initial_token() {
        let token = derive_owner_token(b"local-imports", b"installation-1");
        assert!(token.is_ok());
        if let Ok(value) = token {
            assert!(value.starts_with("owner-"));
            assert_eq!(value.len(), OWNER_TOKEN_BYTES);
            assert_eq!(validate_owner_token(value.as_bytes()), Ok(value.as_str()));
        }
    }

    #[test]
    fn changed_identity_changes_the_token() {
        let first = derive_owner_token(b"local-imports", b"installation-1");
        let second = derive_owner_token(b"local-imports", b"installation-2");
        assert!(first.is_ok() && second.is_ok());
        if let (Ok(first), Ok(second)) = (first, second) {
            assert_ne!(first, second);
        }
    }

    #[test]
    fn escaped_preimage_binds_identical_canonical_bytes() {
        let canonical = derive_owner_token_from_preimage(
            b"[\"eliotr.source-owner.initial.v1\",\"local-imports\",\"eliotr\",\"installation-1\",1,\"ACTIVE\"]",
        );
        let escaped = derive_owner_token_from_preimage(
            b"[ \"eliotr.source-owner.initial.v1\" , \"local-imports\" , \"eliotr\" , \"installation-\\u0031\" , 1 , \"ACTIVE\" ]",
        );
        assert!(canonical.is_ok());
        assert_eq!(canonical, escaped);
    }

    #[test]
    fn rejects_every_family_error() {
        assert!(matches!(
            derive_owner_token(b"", b"installation-1"),
            Err(OwnerTokenError::Namespace)
        ));
        assert!(matches!(
            derive_owner_token(b"local-imports", b"__proto__"),
            Err(OwnerTokenError::Incarnation)
        ));
        assert_eq!(
            derive_owner_token(&[0xff], b"installation-1"),
            Err(OwnerTokenError::InvalidUtf8 { valid_up_to: 0 })
        );
        assert_eq!(
            OwnerTokenError::InvalidUtf8 { valid_up_to: 0 }.code(),
            OWNER_TOKEN_UTF8_CODE
        );
        assert!(matches!(
            derive_owner_token_from_preimage(b"{}"),
            Err(OwnerTokenError::Syntax { .. })
        ));
        assert!(matches!(
            derive_owner_token_from_preimage(b"[]"),
            Err(OwnerTokenError::Shape)
        ));
        assert!(matches!(
            derive_owner_token_from_preimage(
                b"[\"eliotr.source-owner.initial.v1\",\"n\",\"external\",\"i\",1,\"ACTIVE\"]"
            ),
            Err(OwnerTokenError::Owner)
        ));
        assert!(matches!(
            derive_owner_token_from_preimage(
                b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",2,\"ACTIVE\"]"
            ),
            Err(OwnerTokenError::Revision)
        ));
        assert!(matches!(
            derive_owner_token_from_preimage(
                b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",1,\"FENCED\"]"
            ),
            Err(OwnerTokenError::State)
        ));
        assert!(matches!(
            validate_owner_token(b"owner-00"),
            Err(OwnerTokenError::InvalidLength { .. })
        ));
        assert_eq!(
            validate_owner_token(
                b"g1_0000000000000000000000000000000000000000000000000000000000000000000"
            ),
            Err(OwnerTokenError::Prefix)
        );
        assert_eq!(OwnerTokenError::Prefix.code(), OWNER_TOKEN_PREFIX_CODE);
    }

    #[test]
    fn formats_errors_without_source_bytes() {
        let message = OwnerTokenError::Namespace.to_string();
        assert!(message.contains("namespace"));
        assert!(!message.contains("__proto__"));
    }
}
