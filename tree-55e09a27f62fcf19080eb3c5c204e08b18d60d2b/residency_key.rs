//! Bounded `object-residency-key.v1` serialization compatible with the TypeScript authority.
//!
//! Each segment is encoded with the exact `encodeURIComponent` unescaped alphabet and joined with `/`.
//! This module is effect-free shadow infrastructure; it does not decide deduplication or residency moves.

#![forbid(unsafe_code)]

use core::fmt;

/// Version prefix emitted by the current TypeScript serializer.
pub const OBJECT_RESIDENCY_KEY_VERSION: &str = "object-residency-key.v1";
/// Fixed content-digest algorithm admitted by the current contract.
pub const OBJECT_RESIDENCY_KEY_DIGEST_ALGORITHM: &str = "sha256";
/// Maximum identifier length under Zod/JavaScript `string.length` semantics.
pub const RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS: usize = 256;
/// Maximum UTF-8 bytes possible for a valid identifier within the UTF-16 ceiling.
pub const RESIDENCY_KEY_IDENTIFIER_MAX_UTF8_BYTES: usize =
    RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS * 3;
/// Exact lowercase hexadecimal digest width.
pub const RESIDENCY_KEY_DIGEST_BYTES: usize = 64;
/// Maximum serialized byte length admitted by the contract bounds.
pub const OBJECT_RESIDENCY_KEY_MAX_OUTPUT_BYTES: usize = 13_925;

/// Stable error code for an identifier that exceeds the pre-decode byte ceiling.
pub const RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE: &str =
    "ELIOTR_RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE";
/// Stable error code for invalid UTF-8.
pub const RESIDENCY_KEY_UTF8_CODE: &str = "ELIOTR_RESIDENCY_KEY_UTF8";
/// Stable error code for an empty identifier.
pub const RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE: &str = "ELIOTR_RESIDENCY_KEY_EMPTY_IDENTIFIER";
/// Stable error code for an identifier above the JavaScript UTF-16-unit limit.
pub const RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE: &str = "ELIOTR_RESIDENCY_KEY_IDENTIFIER_TOO_LONG";
/// Stable error code for a digest with the wrong byte width.
pub const RESIDENCY_KEY_DIGEST_LENGTH_CODE: &str = "ELIOTR_RESIDENCY_KEY_DIGEST_LENGTH";
/// Stable error code for a digest outside lowercase hexadecimal.
pub const RESIDENCY_KEY_DIGEST_ALPHABET_CODE: &str = "ELIOTR_RESIDENCY_KEY_DIGEST_ALPHABET";

/// Stable location vocabulary for content-free failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidencyKeyField {
    /// `scope_domain_id`.
    ScopeDomainId,
    /// `access_domain_id`.
    AccessDomainId,
    /// `confidentiality_domain_id`.
    ConfidentialityDomainId,
    /// `encryption_key_domain_id`.
    EncryptionKeyDomainId,
    /// `retention_domain_id`.
    RetentionDomainId,
    /// `erasure_domain_id`.
    ErasureDomainId,
    /// `content_digest.digest`.
    ContentDigest,
}

impl ResidencyKeyField {
    const fn name(self) -> &'static str {
        match self {
            Self::ScopeDomainId => "scope_domain_id",
            Self::AccessDomainId => "access_domain_id",
            Self::ConfidentialityDomainId => "confidentiality_domain_id",
            Self::EncryptionKeyDomainId => "encryption_key_domain_id",
            Self::RetentionDomainId => "retention_domain_id",
            Self::ErasureDomainId => "erasure_domain_id",
            Self::ContentDigest => "content_digest.digest",
        }
    }
}

/// Borrowed byte-level input for one residency key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectResidencyKeyInput<'a> {
    /// Scope-domain identifier bytes.
    pub scope_domain_id: &'a [u8],
    /// Access-domain identifier bytes.
    pub access_domain_id: &'a [u8],
    /// Confidentiality-domain identifier bytes.
    pub confidentiality_domain_id: &'a [u8],
    /// Encryption-key-domain identifier bytes.
    pub encryption_key_domain_id: &'a [u8],
    /// Retention-domain identifier bytes.
    pub retention_domain_id: &'a [u8],
    /// Erasure-domain identifier bytes.
    pub erasure_domain_id: &'a [u8],
    /// Exact lowercase hexadecimal SHA-256 digest bytes.
    pub content_digest: &'a [u8],
}

/// Deterministic serialization failure without source content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidencyKeyError {
    /// Identifier bytes exceed the pre-decode maximum.
    IdentifierInputTooLarge {
        /// Rejected field.
        field: ResidencyKeyField,
        /// Observed bytes.
        actual_bytes: usize,
        /// Maximum admitted bytes.
        max_bytes: usize,
    },
    /// A field is not valid UTF-8.
    InvalidUtf8 {
        /// Rejected field.
        field: ResidencyKeyField,
        /// Valid prefix length.
        valid_up_to: usize,
    },
    /// One identifier is empty.
    EmptyIdentifier {
        /// Rejected field.
        field: ResidencyKeyField,
    },
    /// One identifier exceeds the JavaScript UTF-16-unit limit.
    IdentifierTooLong {
        /// Rejected field.
        field: ResidencyKeyField,
        /// Observed UTF-16 units.
        actual_utf16_units: usize,
        /// Maximum admitted UTF-16 units.
        max_utf16_units: usize,
    },
    /// Digest width is not exactly 64 bytes.
    DigestLength {
        /// Observed bytes.
        actual_bytes: usize,
        /// Required bytes.
        expected_bytes: usize,
    },
    /// Digest contains a byte outside lowercase hexadecimal.
    DigestAlphabet {
        /// Offset of the first rejected byte.
        offset: usize,
    },
}

impl ResidencyKeyError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::IdentifierInputTooLarge { .. } => RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 { .. } => RESIDENCY_KEY_UTF8_CODE,
            Self::EmptyIdentifier { .. } => RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE,
            Self::IdentifierTooLong { .. } => RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE,
            Self::DigestLength { .. } => RESIDENCY_KEY_DIGEST_LENGTH_CODE,
            Self::DigestAlphabet { .. } => RESIDENCY_KEY_DIGEST_ALPHABET_CODE,
        }
    }
}

impl fmt::Display for ResidencyKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IdentifierInputTooLarge {
                field,
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "residency-key {} has {actual_bytes} input bytes; maximum is {max_bytes}",
                field.name()
            ),
            Self::InvalidUtf8 { field, valid_up_to } => write!(
                formatter,
                "residency-key {} is invalid UTF-8 after byte offset {valid_up_to}",
                field.name()
            ),
            Self::EmptyIdentifier { field } => {
                write!(formatter, "residency-key {} is empty", field.name())
            }
            Self::IdentifierTooLong {
                field,
                actual_utf16_units,
                max_utf16_units,
            } => write!(
                formatter,
                "residency-key {} has {actual_utf16_units} UTF-16 units; maximum is {max_utf16_units}",
                field.name()
            ),
            Self::DigestLength {
                actual_bytes,
                expected_bytes,
            } => write!(
                formatter,
                "residency-key digest has {actual_bytes} bytes; expected {expected_bytes}"
            ),
            Self::DigestAlphabet { offset } => write!(
                formatter,
                "residency-key digest has a non-lowercase-hex byte at offset {offset}"
            ),
        }
    }
}

impl std::error::Error for ResidencyKeyError {}

/// Serializes one bounded residency key exactly like the current TypeScript implementation.
///
/// The six identifiers follow `IdentifierSchema`: non-empty and at most 256 JavaScript UTF-16 code
/// units. The digest is exactly 64 lowercase hexadecimal bytes. Valid Unicode scalar values are encoded
/// using the `encodeURIComponent` UTF-8 byte algorithm; unpaired JavaScript surrogates are outside the
/// admitted cross-runtime input model because they are not valid UTF-8.
///
/// # Errors
///
/// Returns a typed, content-free error for byte-budget, UTF-8, identifier, or digest violations.
pub fn serialize_object_residency_key(
    input: ObjectResidencyKeyInput<'_>,
) -> Result<String, ResidencyKeyError> {
    let scope = validate_identifier(ResidencyKeyField::ScopeDomainId, input.scope_domain_id)?;
    let access = validate_identifier(ResidencyKeyField::AccessDomainId, input.access_domain_id)?;
    let confidentiality = validate_identifier(
        ResidencyKeyField::ConfidentialityDomainId,
        input.confidentiality_domain_id,
    )?;
    let encryption = validate_identifier(
        ResidencyKeyField::EncryptionKeyDomainId,
        input.encryption_key_domain_id,
    )?;
    let retention = validate_identifier(
        ResidencyKeyField::RetentionDomainId,
        input.retention_domain_id,
    )?;
    let erasure = validate_identifier(ResidencyKeyField::ErasureDomainId, input.erasure_domain_id)?;
    let digest = validate_digest(input.content_digest)?;

    let encoded_lengths = [
        scope,
        access,
        confidentiality,
        encryption,
        retention,
        erasure,
    ]
    .map(|value| encoded_component_length(value.as_bytes()));
    let capacity = OBJECT_RESIDENCY_KEY_VERSION.len()
        + 8
        + OBJECT_RESIDENCY_KEY_DIGEST_ALGORITHM.len()
        + RESIDENCY_KEY_DIGEST_BYTES
        + encoded_lengths.into_iter().sum::<usize>();
    debug_assert!(capacity <= OBJECT_RESIDENCY_KEY_MAX_OUTPUT_BYTES);

    let mut output = String::with_capacity(capacity);
    output.push_str(OBJECT_RESIDENCY_KEY_VERSION);
    for value in [
        scope,
        access,
        confidentiality,
        encryption,
        retention,
        erasure,
    ] {
        output.push('/');
        push_encoded_component(&mut output, value.as_bytes());
    }
    output.push('/');
    output.push_str(OBJECT_RESIDENCY_KEY_DIGEST_ALGORITHM);
    output.push('/');
    output.push_str(digest);
    debug_assert_eq!(output.len(), capacity);
    Ok(output)
}

fn validate_identifier(field: ResidencyKeyField, input: &[u8]) -> Result<&str, ResidencyKeyError> {
    if input.len() > RESIDENCY_KEY_IDENTIFIER_MAX_UTF8_BYTES {
        return Err(ResidencyKeyError::IdentifierInputTooLarge {
            field,
            actual_bytes: input.len(),
            max_bytes: RESIDENCY_KEY_IDENTIFIER_MAX_UTF8_BYTES,
        });
    }
    let text = core::str::from_utf8(input).map_err(|error| ResidencyKeyError::InvalidUtf8 {
        field,
        valid_up_to: error.valid_up_to(),
    })?;
    if text.is_empty() {
        return Err(ResidencyKeyError::EmptyIdentifier { field });
    }
    let utf16_units = text.encode_utf16().count();
    if utf16_units > RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS {
        return Err(ResidencyKeyError::IdentifierTooLong {
            field,
            actual_utf16_units: utf16_units,
            max_utf16_units: RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS,
        });
    }
    Ok(text)
}

fn validate_digest(input: &[u8]) -> Result<&str, ResidencyKeyError> {
    if input.len() != RESIDENCY_KEY_DIGEST_BYTES {
        return Err(ResidencyKeyError::DigestLength {
            actual_bytes: input.len(),
            expected_bytes: RESIDENCY_KEY_DIGEST_BYTES,
        });
    }
    let text = core::str::from_utf8(input).map_err(|error| ResidencyKeyError::InvalidUtf8 {
        field: ResidencyKeyField::ContentDigest,
        valid_up_to: error.valid_up_to(),
    })?;
    if let Some(offset) = input
        .iter()
        .position(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(ResidencyKeyError::DigestAlphabet { offset });
    }
    Ok(text)
}

fn encoded_component_length(input: &[u8]) -> usize {
    input
        .iter()
        .map(|byte| if is_component_unescaped(*byte) { 1 } else { 3 })
        .sum()
}

fn push_encoded_component(output: &mut String, input: &[u8]) {
    for byte in input {
        if is_component_unescaped(*byte) {
            output.push(char::from(*byte));
        } else {
            output.push('%');
            output.push(char::from(upper_hex(byte >> 4)));
            output.push(char::from(upper_hex(byte & 0x0f)));
        }
    }
}

const fn is_component_unescaped(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

const fn upper_hex(nibble: u8) -> u8 {
    match nibble {
        0..=9 => b'0' + nibble,
        _ => b'A' + (nibble - 10),
    }
}
