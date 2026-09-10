use eliotr_canonical::{
    OBJECT_RESIDENCY_KEY_MAX_OUTPUT_BYTES, ObjectResidencyKeyInput,
    RESIDENCY_KEY_DIGEST_ALPHABET_CODE, RESIDENCY_KEY_DIGEST_LENGTH_CODE,
    RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE, RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE,
    RESIDENCY_KEY_IDENTIFIER_MAX_UTF8_BYTES, RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS,
    RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE, RESIDENCY_KEY_UTF8_CODE, ResidencyKeyError,
    ResidencyKeyField, serialize_object_residency_key,
};

const DIGEST: &[u8] = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn key<'a>(
    scope: &'a [u8],
    access: &'a [u8],
    confidentiality: &'a [u8],
    encryption: &'a [u8],
    retention: &'a [u8],
    erasure: &'a [u8],
    digest: &'a [u8],
) -> ObjectResidencyKeyInput<'a> {
    ObjectResidencyKeyInput {
        scope_domain_id: scope,
        access_domain_id: access,
        confidentiality_domain_id: confidentiality,
        encryption_key_domain_id: encryption,
        retention_domain_id: retention,
        erasure_domain_id: erasure,
        content_digest: digest,
    }
}

#[test]
fn serializes_ascii_in_exact_field_order() {
    assert_eq!(
        serialize_object_residency_key(key(
            b"scope-1",
            b"access-1",
            b"confidential-1",
            b"key-1",
            b"retention-1",
            b"erasure-1",
            DIGEST,
        )),
        Ok(format!(
            "object-residency-key.v1/scope-1/access-1/confidential-1/key-1/retention-1/erasure-1/sha256/{}",
            core::str::from_utf8(DIGEST).unwrap_or("")
        ))
    );
}

#[test]
fn matches_encode_uri_component_reserved_and_unicode_rules() {
    assert_eq!(
        serialize_object_residency_key(key(
            b"scope/main",
            b"access:private",
            b"confidential %",
            b"key@v1",
            b"retain?7",
            b"erase#now",
            DIGEST,
        )),
        Ok(format!(
            "object-residency-key.v1/scope%2Fmain/access%3Aprivate/confidential%20%25/key%40v1/retain%3F7/erase%23now/sha256/{}",
            core::str::from_utf8(DIGEST).unwrap_or("")
        ))
    );

    assert_eq!(
        serialize_object_residency_key(key(
            "scope-é".as_bytes(),
            "東京".as_bytes(),
            "😀".as_bytes(),
            b"!~*'()",
            b"literal%2F",
            "кириллица".as_bytes(),
            DIGEST,
        )),
        Ok(format!(
            "object-residency-key.v1/scope-%C3%A9/%E6%9D%B1%E4%BA%AC/%F0%9F%98%80/!~*'()/literal%252F/%D0%BA%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0/sha256/{}",
            core::str::from_utf8(DIGEST).unwrap_or("")
        ))
    );
}

#[test]
fn field_positions_are_part_of_the_serialized_identity() {
    let left = serialize_object_residency_key(key(
        b"scope-a",
        b"access-b",
        b"c",
        b"k",
        b"r",
        b"e",
        DIGEST,
    ));
    let right = serialize_object_residency_key(key(
        b"access-b",
        b"scope-a",
        b"c",
        b"k",
        b"r",
        b"e",
        DIGEST,
    ));
    assert!(left.is_ok());
    assert!(right.is_ok());
    assert_ne!(left, right);
}

#[test]
fn accepts_exact_identifier_and_output_ceilings() {
    let ascii = "a".repeat(RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS);
    assert!(
        serialize_object_residency_key(key(
            ascii.as_bytes(),
            ascii.as_bytes(),
            ascii.as_bytes(),
            ascii.as_bytes(),
            ascii.as_bytes(),
            ascii.as_bytes(),
            DIGEST,
        ))
        .is_ok()
    );

    let three_byte = "ࠀ".repeat(RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS);
    let result = serialize_object_residency_key(key(
        three_byte.as_bytes(),
        three_byte.as_bytes(),
        three_byte.as_bytes(),
        three_byte.as_bytes(),
        three_byte.as_bytes(),
        three_byte.as_bytes(),
        DIGEST,
    ));
    assert!(matches!(result, Ok(value) if value.len() == OBJECT_RESIDENCY_KEY_MAX_OUTPUT_BYTES));
}

#[test]
fn rejects_identifier_size_utf16_empty_and_utf8_boundaries() {
    let over_bytes = vec![b'x'; RESIDENCY_KEY_IDENTIFIER_MAX_UTF8_BYTES + 1];
    assert_eq!(
        serialize_object_residency_key(key(&over_bytes, b"a", b"c", b"k", b"r", b"e", DIGEST,))
            .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE_CODE)
    );

    let over_units = "a".repeat(RESIDENCY_KEY_IDENTIFIER_MAX_UTF16_UNITS + 1);
    assert_eq!(
        serialize_object_residency_key(key(
            b"s",
            over_units.as_bytes(),
            b"c",
            b"k",
            b"r",
            b"e",
            DIGEST,
        ))
        .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE)
    );

    let astral = "😀".repeat(129);
    assert_eq!(
        serialize_object_residency_key(key(
            b"s",
            b"a",
            astral.as_bytes(),
            b"k",
            b"r",
            b"e",
            DIGEST,
        ))
        .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_IDENTIFIER_TOO_LONG_CODE)
    );

    assert_eq!(
        serialize_object_residency_key(key(b"s", b"a", b"c", b"", b"r", b"e", DIGEST,))
            .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_EMPTY_IDENTIFIER_CODE)
    );
    assert_eq!(
        serialize_object_residency_key(key(b"s", b"a", b"c", b"k", &[0xff], b"e", DIGEST,))
            .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_UTF8_CODE)
    );
}

#[test]
fn rejects_digest_width_utf8_and_alphabet() {
    assert_eq!(
        serialize_object_residency_key(key(b"s", b"a", b"c", b"k", b"r", b"e", b"short",))
            .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_DIGEST_LENGTH_CODE)
    );
    assert_eq!(
        serialize_object_residency_key(key(
            b"s",
            b"a",
            b"c",
            b"k",
            b"r",
            b"e",
            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ))
        .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_DIGEST_ALPHABET_CODE)
    );
    let mut invalid_utf8 = [b'0'; 64];
    invalid_utf8[63] = 0xff;
    assert_eq!(
        serialize_object_residency_key(key(b"s", b"a", b"c", b"k", b"r", b"e", &invalid_utf8,))
            .map_err(ResidencyKeyError::code),
        Err(RESIDENCY_KEY_UTF8_CODE)
    );
}

#[test]
fn error_codes_and_messages_are_stable_and_content_free() {
    let errors = [
        ResidencyKeyError::IdentifierInputTooLarge {
            field: ResidencyKeyField::ScopeDomainId,
            actual_bytes: 2,
            max_bytes: 1,
        },
        ResidencyKeyError::InvalidUtf8 {
            field: ResidencyKeyField::AccessDomainId,
            valid_up_to: 1,
        },
        ResidencyKeyError::EmptyIdentifier {
            field: ResidencyKeyField::ConfidentialityDomainId,
        },
        ResidencyKeyError::IdentifierTooLong {
            field: ResidencyKeyField::EncryptionKeyDomainId,
            actual_utf16_units: 257,
            max_utf16_units: 256,
        },
        ResidencyKeyError::DigestLength {
            actual_bytes: 63,
            expected_bytes: 64,
        },
        ResidencyKeyError::DigestAlphabet { offset: 4 },
    ];

    for error in errors {
        assert!(error.code().starts_with("ELIOTR_RESIDENCY_KEY_"));
        let message = error.to_string();
        assert!(message.starts_with("residency-key "));
        assert!(!message.contains("secret"));
    }
}
