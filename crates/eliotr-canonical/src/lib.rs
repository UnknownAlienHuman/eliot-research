//! Pure deterministic primitives for bytes crossing the Eliot Research kernel boundary.
//!
//! M1 established bounded UTF-8 transport validation. M2 adds bounded canonical JSON, SHA-256,
//! fixed-width generation tokens, and stable-ID shadow primitives without moving product authority.

#![forbid(unsafe_code)]

mod canonical_json;
mod canonical_json_error;
mod generation;
mod sha256;
mod stable_id;

pub use canonical_json::*;
pub use canonical_json_error::*;
pub use generation::*;
pub use sha256::sha256;
pub use stable_id::*;

use core::fmt;

/// Stable error code returned when input exceeds its explicit byte budget.
pub const UTF8_TOO_LARGE_CODE: &str = "ELIOTR_UTF8_TOO_LARGE";

/// Stable error code returned when input is not valid UTF-8.
pub const UTF8_INVALID_CODE: &str = "ELIOTR_UTF8_INVALID";

/// A deterministic failure produced before bytes enter a promoted kernel operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Utf8TransportError {
    /// The explicit byte budget was exceeded.
    TooLarge {
        /// Observed input length in bytes.
        actual_bytes: usize,
        /// Maximum admitted input length in bytes.
        max_bytes: usize,
    },
    /// The input was not valid UTF-8.
    InvalidUtf8 {
        /// Number of bytes known to be valid before the decoding error.
        valid_up_to: usize,
    },
}

impl Utf8TransportError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TooLarge { .. } => UTF8_TOO_LARGE_CODE,
            Self::InvalidUtf8 { .. } => UTF8_INVALID_CODE,
        }
    }
}

impl fmt::Display for Utf8TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "UTF-8 transport input has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::InvalidUtf8 { valid_up_to } => write!(
                formatter,
                "UTF-8 transport input is invalid after byte offset {valid_up_to}"
            ),
        }
    }
}

impl std::error::Error for Utf8TransportError {}

/// Validates explicit bytes without normalization, allocation, I/O, clock reads, or hidden state.
///
/// The size check intentionally runs before UTF-8 decoding so an oversized malformed body receives the
/// bounded transport error rather than consuming deeper parser work.
///
/// # Errors
///
/// Returns [`Utf8TransportError::TooLarge`] when `input` exceeds `max_bytes`, or
/// [`Utf8TransportError::InvalidUtf8`] when the admitted bytes are not UTF-8.
pub fn validate_canonical_utf8_transport(
    input: &[u8],
    max_bytes: usize,
) -> Result<&str, Utf8TransportError> {
    if input.len() > max_bytes {
        return Err(Utf8TransportError::TooLarge {
            actual_bytes: input.len(),
            max_bytes,
        });
    }

    core::str::from_utf8(input).map_err(|error| Utf8TransportError::InvalidUtf8 {
        valid_up_to: error.valid_up_to(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        UTF8_INVALID_CODE, UTF8_TOO_LARGE_CODE, Utf8TransportError,
        validate_canonical_utf8_transport,
    };

    #[test]
    fn preserves_ascii_bytes() {
        assert_eq!(validate_canonical_utf8_transport(b"hello", 5), Ok("hello"));
    }

    #[test]
    fn preserves_multibyte_utf8() {
        let input = "Привет".as_bytes();
        assert_eq!(
            validate_canonical_utf8_transport(input, input.len()),
            Ok("Привет")
        );
    }

    #[test]
    fn admits_empty_input_when_the_budget_is_zero() {
        assert_eq!(validate_canonical_utf8_transport(b"", 0), Ok(""));
    }

    #[test]
    fn rejects_one_byte_over_the_limit() {
        assert_eq!(
            validate_canonical_utf8_transport(b"abc", 2),
            Err(Utf8TransportError::TooLarge {
                actual_bytes: 3,
                max_bytes: 2,
            })
        );
    }

    #[test]
    fn size_failure_precedes_utf8_failure() {
        let error = validate_canonical_utf8_transport(&[0xff], 0);
        assert_eq!(
            error,
            Err(Utf8TransportError::TooLarge {
                actual_bytes: 1,
                max_bytes: 0,
            })
        );
    }

    #[test]
    fn reports_invalid_utf8_offset() {
        let error = validate_canonical_utf8_transport(&[b'a', 0xff], 2);
        assert_eq!(
            error,
            Err(Utf8TransportError::InvalidUtf8 { valid_up_to: 1 })
        );
    }

    #[test]
    fn exposes_stable_error_codes() {
        assert_eq!(
            Utf8TransportError::TooLarge {
                actual_bytes: 2,
                max_bytes: 1,
            }
            .code(),
            UTF8_TOO_LARGE_CODE
        );
        assert_eq!(
            Utf8TransportError::InvalidUtf8 { valid_up_to: 0 }.code(),
            UTF8_INVALID_CODE
        );
    }

    #[test]
    fn formats_errors_without_source_bytes() {
        assert_eq!(
            Utf8TransportError::TooLarge {
                actual_bytes: 9,
                max_bytes: 8,
            }
            .to_string(),
            "UTF-8 transport input has 9 bytes; maximum is 8"
        );
        assert_eq!(
            Utf8TransportError::InvalidUtf8 { valid_up_to: 4 }.to_string(),
            "UTF-8 transport input is invalid after byte offset 4"
        );
    }
}
