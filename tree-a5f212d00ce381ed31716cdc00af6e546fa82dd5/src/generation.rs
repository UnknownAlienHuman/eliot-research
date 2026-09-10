//! Fixed-width generation tokens derived from deterministic SHA-256 body bytes.

#![forbid(unsafe_code)]

use core::fmt;

use crate::sha256::sha256;

/// Canonical token prefix for the product-neutral M2 family.
pub const GENERATION_TOKEN_PREFIX: &str = "g1_";
/// Number of lowercase hexadecimal digest characters.
pub const GENERATION_TOKEN_HEX_BYTES: usize = 64;
/// Exact UTF-8/ASCII token length.
pub const GENERATION_TOKEN_BYTES: usize =
    GENERATION_TOKEN_PREFIX.len() + GENERATION_TOKEN_HEX_BYTES;

/// Stable generation-token error codes.
pub const GENERATION_LENGTH_CODE: &str = "ELIOTR_GENERATION_LENGTH";
pub const GENERATION_PREFIX_CODE: &str = "ELIOTR_GENERATION_PREFIX";
pub const GENERATION_ALPHABET_CODE: &str = "ELIOTR_GENERATION_ALPHABET";

/// A deterministic rejection of a fixed-width generation token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationTokenError {
    /// Token length differed from the exact contract.
    Length {
        /// Observed bytes.
        actual_bytes: usize,
        /// Required bytes.
        expected_bytes: usize,
    },
    /// Token prefix differed from `g1_`.
    Prefix,
    /// Digest text was not lowercase hexadecimal.
    Alphabet {
        /// Byte offset of the first rejected character.
        offset: usize,
    },
}

impl GenerationTokenError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Length { .. } => GENERATION_LENGTH_CODE,
            Self::Prefix => GENERATION_PREFIX_CODE,
            Self::Alphabet { .. } => GENERATION_ALPHABET_CODE,
        }
    }
}

impl fmt::Display for GenerationTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length {
                actual_bytes,
                expected_bytes,
            } => write!(
                formatter,
                "generation token has {actual_bytes} bytes; expected {expected_bytes}"
            ),
            Self::Prefix => write!(formatter, "generation token prefix is invalid"),
            Self::Alphabet { offset } => write!(
                formatter,
                "generation token contains a non-lowercase-hex byte at offset {offset}"
            ),
        }
    }
}

impl std::error::Error for GenerationTokenError {}

/// Formats an exact SHA-256 digest as a fixed-width generation token.
#[must_use]
pub fn format_generation_token(digest: &[u8; 32]) -> String {
    let mut token = String::with_capacity(GENERATION_TOKEN_BYTES);
    token.push_str(GENERATION_TOKEN_PREFIX);
    for byte in digest {
        token.push(char::from(lower_hex(byte >> 4)));
        token.push(char::from(lower_hex(byte & 0x0f)));
    }
    token
}

/// Computes a deterministic body digest and formats its generation token.
#[must_use]
pub fn generation_token_for_body(body: &[u8]) -> String {
    format_generation_token(&sha256(body))
}

/// Validates one exact fixed-width token without normalization or allocation.
///
/// # Errors
///
/// Returns a typed error for wrong length, prefix, or alphabet.
pub fn validate_generation_token(input: &[u8]) -> Result<&str, GenerationTokenError> {
    if input.len() != GENERATION_TOKEN_BYTES {
        return Err(GenerationTokenError::Length {
            actual_bytes: input.len(),
            expected_bytes: GENERATION_TOKEN_BYTES,
        });
    }
    if !input.starts_with(GENERATION_TOKEN_PREFIX.as_bytes()) {
        return Err(GenerationTokenError::Prefix);
    }
    for (index, byte) in input[GENERATION_TOKEN_PREFIX.len()..].iter().enumerate() {
        if !matches!(byte, b'0'..=b'9' | b'a'..=b'f') {
            return Err(GenerationTokenError::Alphabet {
                offset: GENERATION_TOKEN_PREFIX.len() + index,
            });
        }
    }
    core::str::from_utf8(input).map_err(|_error| GenerationTokenError::Alphabet {
        offset: GENERATION_TOKEN_PREFIX.len(),
    })
}

const fn lower_hex(nibble: u8) -> u8 {
    match nibble {
        0..=9 => b'0' + nibble,
        _ => b'a' + (nibble - 10),
    }
}
