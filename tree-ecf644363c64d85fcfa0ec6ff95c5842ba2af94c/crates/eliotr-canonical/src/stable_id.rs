//! Bounded stable identifiers compatible with the current TypeScript shadow authority.
//!
//! The v1 preimage is the exact UTF-8 byte sequence `prefix [NUL part]*`. The identifier retains the
//! validated prefix and appends the first 192 bits of SHA-256 as 48 lowercase hexadecimal characters.

#![forbid(unsafe_code)]

use core::fmt;

use crate::sha256;

/// Maximum UTF-8 byte length of one stable-ID prefix.
pub const STABLE_ID_PREFIX_MAX_BYTES: usize = 64;
/// Maximum number of parts after the prefix.
pub const STABLE_ID_MAX_PARTS: usize = 32;
/// Maximum UTF-8 byte length of one stable-ID part.
pub const STABLE_ID_PART_MAX_BYTES: usize = 4096;
/// Maximum complete preimage length, including NUL separators.
pub const STABLE_ID_INPUT_MAX_BYTES: usize = 64 * 1024;
/// Number of lowercase hexadecimal digest bytes retained in the identifier text.
pub const STABLE_ID_DIGEST_HEX_BYTES: usize = 48;
/// Minimum complete stable-ID byte length.
pub const STABLE_ID_MIN_BYTES: usize = 1 + 1 + STABLE_ID_DIGEST_HEX_BYTES;
/// Maximum complete stable-ID byte length.
pub const STABLE_ID_MAX_BYTES: usize = STABLE_ID_PREFIX_MAX_BYTES + 1 + STABLE_ID_DIGEST_HEX_BYTES;

/// Stable error codes for `stable-id.v1`.
pub const STABLE_ID_INPUT_TOO_LARGE_CODE: &str = "ELIOTR_STABLE_ID_INPUT_TOO_LARGE";
pub const STABLE_ID_PREFIX_TOO_LARGE_CODE: &str = "ELIOTR_STABLE_ID_PREFIX_TOO_LARGE";
pub const STABLE_ID_PREFIX_CODE: &str = "ELIOTR_STABLE_ID_PREFIX";
pub const STABLE_ID_TOO_MANY_PARTS_CODE: &str = "ELIOTR_STABLE_ID_TOO_MANY_PARTS";
pub const STABLE_ID_PART_TOO_LARGE_CODE: &str = "ELIOTR_STABLE_ID_PART_TOO_LARGE";
pub const STABLE_ID_NUL_CODE: &str = "ELIOTR_STABLE_ID_NUL";
pub const STABLE_ID_UTF8_CODE: &str = "ELIOTR_STABLE_ID_UTF8";
pub const STABLE_ID_LENGTH_CODE: &str = "ELIOTR_STABLE_ID_LENGTH";
pub const STABLE_ID_ALPHABET_CODE: &str = "ELIOTR_STABLE_ID_ALPHABET";

/// Location category for a content-free UTF-8 rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StableIdUtf8Field {
    /// The preimage prefix.
    Prefix,
    /// One zero-based preimage part.
    Part {
        /// Zero-based part index.
        index: usize,
    },
    /// A complete identifier under validation.
    Identifier,
}

/// Deterministic stable-ID failure without source bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StableIdError {
    /// The complete preimage exceeded its explicit byte budget.
    InputTooLarge {
        /// Observed bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// The prefix exceeded its explicit byte budget.
    PrefixTooLarge {
        /// Observed bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// The prefix was empty or outside the ASCII grammar.
    InvalidPrefix,
    /// The preimage contained too many parts.
    TooManyParts {
        /// Observed parts.
        actual_parts: usize,
        /// Maximum admitted parts.
        max_parts: usize,
    },
    /// One part exceeded its explicit byte budget.
    PartTooLarge {
        /// Zero-based part index.
        index: usize,
        /// Observed bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// A direct part contained the reserved NUL separator.
    InteriorNul {
        /// Zero-based part index.
        index: usize,
        /// Byte offset inside the part.
        offset: usize,
    },
    /// A prefix, part, or complete identifier was not UTF-8.
    InvalidUtf8 {
        /// Rejected field category.
        field: StableIdUtf8Field,
        /// Valid prefix length.
        valid_up_to: usize,
    },
    /// A complete identifier had the wrong bounded or suffix length.
    InvalidLength {
        /// Observed bytes.
        actual_bytes: usize,
        /// Minimum admitted bytes.
        min_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// The 48-byte digest suffix was not lowercase hexadecimal.
    InvalidAlphabet {
        /// Byte offset of the first rejected suffix byte.
        offset: usize,
    },
}

impl StableIdError {
    /// Returns the stable machine-readable code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge { .. } => STABLE_ID_INPUT_TOO_LARGE_CODE,
            Self::PrefixTooLarge { .. } => STABLE_ID_PREFIX_TOO_LARGE_CODE,
            Self::InvalidPrefix => STABLE_ID_PREFIX_CODE,
            Self::TooManyParts { .. } => STABLE_ID_TOO_MANY_PARTS_CODE,
            Self::PartTooLarge { .. } => STABLE_ID_PART_TOO_LARGE_CODE,
            Self::InteriorNul { .. } => STABLE_ID_NUL_CODE,
            Self::InvalidUtf8 { .. } => STABLE_ID_UTF8_CODE,
            Self::InvalidLength { .. } => STABLE_ID_LENGTH_CODE,
            Self::InvalidAlphabet { .. } => STABLE_ID_ALPHABET_CODE,
        }
    }
}

impl fmt::Display for StableIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "stable-ID preimage has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::PrefixTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "stable-ID prefix has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::InvalidPrefix => write!(formatter, "stable-ID prefix is invalid"),
            Self::TooManyParts {
                actual_parts,
                max_parts,
            } => write!(
                formatter,
                "stable-ID preimage has {actual_parts} parts; maximum is {max_parts}"
            ),
            Self::PartTooLarge {
                index,
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "stable-ID part {index} has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::InteriorNul { index, offset } => write!(
                formatter,
                "stable-ID part {index} contains the reserved separator at byte offset {offset}"
            ),
            Self::InvalidUtf8 { field, valid_up_to } => write!(
                formatter,
                "stable-ID {} is invalid after byte offset {valid_up_to}",
                utf8_field_name(*field)
            ),
            Self::InvalidLength {
                actual_bytes,
                min_bytes,
                max_bytes,
            } => write!(
                formatter,
                "stable ID has {actual_bytes} bytes; admitted range is {min_bytes}..={max_bytes}"
            ),
            Self::InvalidAlphabet { offset } => write!(
                formatter,
                "stable-ID digest contains a non-lowercase-hex byte at offset {offset}"
            ),
        }
    }
}

impl std::error::Error for StableIdError {}

/// Derives one `stable-id.v1` identifier from a prefix and explicit UTF-8 parts.
///
/// NUL is reserved as the part separator and is rejected inside direct parts. Empty parts remain
/// significant, so `derive_stable_id(b"p", &[])` differs from
/// `derive_stable_id(b"p", &[b""])`.
///
/// # Errors
///
/// Returns a typed, content-free error for invalid UTF-8, prefix grammar, NUL ambiguity, or any
/// configured resource overflow.
pub fn derive_stable_id(prefix: &[u8], parts: &[&[u8]]) -> Result<String, StableIdError> {
    let input_bytes = preimage_length(prefix, parts)?;
    let prefix_text = validate_prefix(prefix)?;
    validate_parts(parts)?;

    let mut preimage = Vec::with_capacity(input_bytes);
    preimage.extend_from_slice(prefix);
    for part in parts {
        preimage.push(0);
        preimage.extend_from_slice(part);
    }
    Ok(format_stable_id(prefix_text, &preimage))
}

/// Derives one `stable-id.v1` identifier from an exact `prefix [NUL part]*` preimage.
///
/// # Errors
///
/// Returns a typed, content-free error for invalid UTF-8, prefix grammar, or any configured resource
/// overflow.
pub fn derive_stable_id_frame(input: &[u8]) -> Result<String, StableIdError> {
    if input.len() > STABLE_ID_INPUT_MAX_BYTES {
        return Err(StableIdError::InputTooLarge {
            actual_bytes: input.len(),
            max_bytes: STABLE_ID_INPUT_MAX_BYTES,
        });
    }

    let mut segments = input.split(|byte| *byte == 0);
    let Some(prefix) = segments.next() else {
        return Err(StableIdError::InvalidPrefix);
    };
    let prefix_text = validate_prefix(prefix)?;
    for (index, part) in segments.enumerate() {
        if index == STABLE_ID_MAX_PARTS {
            return Err(StableIdError::TooManyParts {
                actual_parts: index + 1,
                max_parts: STABLE_ID_MAX_PARTS,
            });
        }
        validate_part(index, part, false)?;
    }

    Ok(format_stable_id(prefix_text, input))
}

/// Validates one complete `prefix-<48 lowercase hex>` identifier without normalization.
///
/// The separator is the final `-`, allowing validated prefixes such as `receipt-ingest` and `a-`.
///
/// # Errors
///
/// Returns a typed, content-free error for invalid UTF-8, length, prefix grammar, or digest alphabet.
pub fn validate_stable_id(input: &[u8]) -> Result<&str, StableIdError> {
    if !(STABLE_ID_MIN_BYTES..=STABLE_ID_MAX_BYTES).contains(&input.len()) {
        return Err(length_error(input.len()));
    }
    let text = core::str::from_utf8(input).map_err(|error| StableIdError::InvalidUtf8 {
        field: StableIdUtf8Field::Identifier,
        valid_up_to: error.valid_up_to(),
    })?;
    let Some(separator) = input.iter().rposition(|byte| *byte == b'-') else {
        return Err(length_error(input.len()));
    };
    let prefix = &input[..separator];
    let digest = &input[separator + 1..];
    if digest.len() != STABLE_ID_DIGEST_HEX_BYTES {
        return Err(length_error(input.len()));
    }
    validate_prefix(prefix)?;
    if let Some(offset) = digest
        .iter()
        .position(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(StableIdError::InvalidAlphabet {
            offset: separator + 1 + offset,
        });
    }
    Ok(text)
}

fn preimage_length(prefix: &[u8], parts: &[&[u8]]) -> Result<usize, StableIdError> {
    if parts.len() > STABLE_ID_MAX_PARTS {
        return Err(StableIdError::TooManyParts {
            actual_parts: parts.len(),
            max_parts: STABLE_ID_MAX_PARTS,
        });
    }
    let mut total = prefix.len();
    for part in parts {
        let Some(next) = total
            .checked_add(1)
            .and_then(|value| value.checked_add(part.len()))
        else {
            return Err(StableIdError::InputTooLarge {
                actual_bytes: usize::MAX,
                max_bytes: STABLE_ID_INPUT_MAX_BYTES,
            });
        };
        total = next;
    }
    if total > STABLE_ID_INPUT_MAX_BYTES {
        return Err(StableIdError::InputTooLarge {
            actual_bytes: total,
            max_bytes: STABLE_ID_INPUT_MAX_BYTES,
        });
    }
    Ok(total)
}

fn validate_prefix(prefix: &[u8]) -> Result<&str, StableIdError> {
    if prefix.len() > STABLE_ID_PREFIX_MAX_BYTES {
        return Err(StableIdError::PrefixTooLarge {
            actual_bytes: prefix.len(),
            max_bytes: STABLE_ID_PREFIX_MAX_BYTES,
        });
    }
    let text = core::str::from_utf8(prefix).map_err(|error| StableIdError::InvalidUtf8 {
        field: StableIdUtf8Field::Prefix,
        valid_up_to: error.valid_up_to(),
    })?;
    let Some((&first, remaining)) = prefix.split_first() else {
        return Err(StableIdError::InvalidPrefix);
    };
    if !first.is_ascii_alphanumeric()
        || !remaining.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        })
    {
        return Err(StableIdError::InvalidPrefix);
    }
    Ok(text)
}

fn validate_parts(parts: &[&[u8]]) -> Result<(), StableIdError> {
    for (index, part) in parts.iter().enumerate() {
        validate_part(index, part, true)?;
    }
    Ok(())
}

fn validate_part(index: usize, part: &[u8], reject_nul: bool) -> Result<(), StableIdError> {
    if part.len() > STABLE_ID_PART_MAX_BYTES {
        return Err(StableIdError::PartTooLarge {
            index,
            actual_bytes: part.len(),
            max_bytes: STABLE_ID_PART_MAX_BYTES,
        });
    }
    if reject_nul && let Some(offset) = part.iter().position(|byte| *byte == 0) {
        return Err(StableIdError::InteriorNul { index, offset });
    }
    core::str::from_utf8(part).map_err(|error| StableIdError::InvalidUtf8 {
        field: StableIdUtf8Field::Part { index },
        valid_up_to: error.valid_up_to(),
    })?;
    Ok(())
}

fn format_stable_id(prefix: &str, preimage: &[u8]) -> String {
    let digest = sha256(preimage);
    let mut output = String::with_capacity(prefix.len() + 1 + STABLE_ID_DIGEST_HEX_BYTES);
    output.push_str(prefix);
    output.push('-');
    for byte in digest.iter().take(STABLE_ID_DIGEST_HEX_BYTES / 2) {
        output.push(char::from(lower_hex(byte >> 4)));
        output.push(char::from(lower_hex(byte & 0x0f)));
    }
    output
}

const fn length_error(actual_bytes: usize) -> StableIdError {
    StableIdError::InvalidLength {
        actual_bytes,
        min_bytes: STABLE_ID_MIN_BYTES,
        max_bytes: STABLE_ID_MAX_BYTES,
    }
}

const fn lower_hex(nibble: u8) -> u8 {
    match nibble {
        0..=9 => b'0' + nibble,
        _ => b'a' + (nibble - 10),
    }
}

const fn utf8_field_name(field: StableIdUtf8Field) -> &'static str {
    match field {
        StableIdUtf8Field::Prefix => "prefix",
        StableIdUtf8Field::Part { .. } => "part",
        StableIdUtf8Field::Identifier => "identifier",
    }
}
