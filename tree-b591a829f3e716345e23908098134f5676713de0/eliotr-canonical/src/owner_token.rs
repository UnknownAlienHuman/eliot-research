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

struct ParsedTuple {
    schema: String,
    namespace: String,
    owner: String,
    incarnation: String,
    revision: i64,
    status: String,
}

struct TupleParser<'a> {
    input: &'a [u8],
    cursor: usize,
}

impl<'a> TupleParser<'a> {
    const fn new(input: &'a [u8]) -> Self {
        Self { input, cursor: 0 }
    }

    fn parse(mut self) -> Result<ParsedTuple, OwnerTokenError> {
        self.skip_whitespace();
        if !self.consume_if(b'[') {
            return Err(self.syntax());
        }
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            return Err(OwnerTokenError::Shape);
        }
        let schema = self.parse_string()?;
        self.skip_whitespace();
        self.consume_comma_or_end()?;
        self.skip_whitespace();
        let namespace = self.parse_string_or_shape()?;
        self.skip_whitespace();
        self.consume_comma_or_end()?;
        self.skip_whitespace();
        let owner = self.parse_string_or_shape()?;
        self.skip_whitespace();
        self.consume_comma_or_end()?;
        self.skip_whitespace();
        let incarnation = self.parse_string_or_shape()?;
        self.skip_whitespace();
        self.consume_comma_or_end()?;
        self.skip_whitespace();
        let revision = self.parse_revision()?;
        self.skip_whitespace();
        self.consume_comma_or_end()?;
        self.skip_whitespace();
        let status = self.parse_string_or_shape()?;
        self.skip_whitespace();
        if self.consume_if(b',') {
            return Err(OwnerTokenError::Shape);
        }
        if !self.consume_if(b']') {
            return Err(self.syntax());
        }
        self.skip_whitespace();
        if self.cursor != self.input.len() {
            return Err(self.syntax());
        }
        Ok(ParsedTuple {
            schema,
            namespace,
            owner,
            incarnation,
            revision,
            status,
        })
    }

    fn parse_string_or_shape(&mut self) -> Result<String, OwnerTokenError> {
        if self.peek() != Some(b'"') {
            return Err(OwnerTokenError::Shape);
        }
        self.parse_string()
    }

    fn parse_revision(&mut self) -> Result<i64, OwnerTokenError> {
        let start = self.cursor;
        match self.peek() {
            Some(b'-' | b'0'..=b'9') => {}
            _ => return Err(OwnerTokenError::Shape),
        }
        let negative = self.consume_if(b'-');
        let digits_start = self.cursor;
        match self.peek() {
            Some(b'0') => {
                self.cursor += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(self.syntax_at(start));
                }
            }
            Some(b'1'..=b'9') => {
                self.cursor += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.cursor += 1;
                }
            }
            _ => return Err(self.syntax_at(start)),
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(self.syntax_at(start));
        }
        let mut magnitude = 0_i64;
        for byte in &self.input[digits_start..self.cursor] {
            let digit = i64::from(*byte - b'0');
            if magnitude > (i64::MAX - digit) / 10 {
                return Err(self.syntax_at(start));
            }
            magnitude = magnitude * 10 + digit;
        }
        if negative && magnitude == 0 {
            return Err(self.syntax_at(start));
        }
        Ok(if negative { -magnitude } else { magnitude })
    }

    fn parse_string(&mut self) -> Result<String, OwnerTokenError> {
        let start = self.cursor;
        if !self.consume_if(b'"') {
            return Err(self.syntax_at(start));
        }
        let mut output = Vec::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err(self.syntax_at(start));
            };
            match byte {
                b'"' => {
                    self.cursor += 1;
                    return String::from_utf8(output)
                        .map_err(|_error| OwnerTokenError::Unicode { offset: start });
                }
                b'\\' => {
                    self.cursor += 1;
                    self.parse_escape(&mut output, start)?;
                }
                0x00..=0x1f => return Err(self.syntax_at(start)),
                0x20..=0x7f => {
                    self.cursor += 1;
                    output.push(byte);
                }
                _ => {
                    let Some(width) = utf8_width(byte) else {
                        return Err(OwnerTokenError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    let end = self.cursor.saturating_add(width);
                    let Some(bytes) = self.input.get(self.cursor..end) else {
                        return Err(OwnerTokenError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    if !is_valid_continuation(bytes) {
                        return Err(OwnerTokenError::Unicode {
                            offset: self.cursor,
                        });
                    }
                    output.extend_from_slice(bytes);
                    self.cursor = end;
                }
            }
        }
    }

    fn parse_escape(&mut self, output: &mut Vec<u8>, start: usize) -> Result<(), OwnerTokenError> {
        let offset = self.cursor.saturating_sub(1);
        let Some(escape) = self.peek() else {
            return Err(self.syntax_at(start));
        };
        self.cursor += 1;
        match escape {
            b'"' => output.push(b'"'),
            b'\\' => output.push(b'\\'),
            b'/' => output.push(b'/'),
            b'b' => output.push(0x08),
            b'f' => output.push(0x0c),
            b'n' => output.push(b'\n'),
            b'r' => output.push(b'\r'),
            b't' => output.push(b'\t'),
            b'u' => self.parse_unicode_escape(output, offset)?,
            _ => return Err(self.syntax_at(start)),
        }
        Ok(())
    }

    fn parse_unicode_escape(
        &mut self,
        output: &mut Vec<u8>,
        offset: usize,
    ) -> Result<(), OwnerTokenError> {
        let first = self.parse_hex_quad(offset)?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.input.get(self.cursor..self.cursor.saturating_add(2)) != Some(b"\\u") {
                return Err(OwnerTokenError::Unicode { offset });
            }
            self.cursor += 2;
            let second = self.parse_hex_quad(offset)?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(OwnerTokenError::Unicode { offset });
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err(OwnerTokenError::Unicode { offset });
        } else {
            u32::from(first)
        };
        let Some(character) = char::from_u32(scalar) else {
            return Err(OwnerTokenError::Unicode { offset });
        };
        let mut encoded = [0_u8; 4];
        output.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
        Ok(())
    }

    fn parse_hex_quad(&mut self, offset: usize) -> Result<u16, OwnerTokenError> {
        let end = self.cursor.saturating_add(4);
        let Some(bytes) = self.input.get(self.cursor..end) else {
            return Err(OwnerTokenError::Unicode { offset });
        };
        let mut value = 0_u16;
        for byte in bytes {
            let Some(nibble) = hex_nibble(*byte) else {
                return Err(OwnerTokenError::Unicode { offset });
            };
            value = (value << 4) | u16::from(nibble);
        }
        self.cursor = end;
        Ok(value)
    }

    fn consume_comma_or_end(&mut self) -> Result<(), OwnerTokenError> {
        if self.consume_if(b',') {
            Ok(())
        } else if self.peek() == Some(b']') {
            Err(OwnerTokenError::Shape)
        } else {
            Err(self.syntax())
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.cursor += 1;
        }
    }

    fn consume_if(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.cursor).copied()
    }

    fn syntax(&self) -> OwnerTokenError {
        OwnerTokenError::Syntax {
            offset: self.cursor,
        }
    }

    fn syntax_at(&self, offset: usize) -> OwnerTokenError {
        OwnerTokenError::Syntax { offset }
    }
}

const fn utf8_width(byte: u8) -> Option<usize> {
    match byte {
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

fn is_valid_continuation(bytes: &[u8]) -> bool {
    core::str::from_utf8(bytes).is_ok()
}

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
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
