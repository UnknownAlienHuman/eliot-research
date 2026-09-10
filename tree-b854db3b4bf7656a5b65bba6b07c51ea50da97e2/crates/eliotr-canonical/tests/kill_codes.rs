//! ER-40 S6 native kill-matrix: owner-token, stable-ID, generation shapes,
//! exhaustive stable error codes and field-name pins.

use eliotr_canonical::{
    CanonicalJsonError, GENERATION_ALPHABET_CODE, GenerationTokenError, OWNER_TOKEN_ALPHABET_CODE,
    OWNER_TOKEN_INCARNATION_CODE, OWNER_TOKEN_LENGTH_CODE, OWNER_TOKEN_NAMESPACE_CODE,
    OWNER_TOKEN_OWNER_CODE, OWNER_TOKEN_PREFIX_CODE, OWNER_TOKEN_REVISION_CODE,
    OWNER_TOKEN_SCHEMA_CODE, OWNER_TOKEN_SHAPE_CODE, OWNER_TOKEN_STATE_CODE, OwnerTokenError,
    ResidencyKeyError, ResidencyKeyField, SNAPSHOT_DIGEST_MISMATCH_CODE, SNAPSHOT_EXPRESSION_CODE,
    SNAPSHOT_ID_MISMATCH_CODE, SNAPSHOT_TIMESTAMP_CODE, STABLE_ID_ALPHABET_CODE,
    STABLE_ID_LENGTH_CODE, STABLE_ID_PREFIX_CODE, SnapshotIdentityError, StableIdError,
    StableIdUtf8Field, derive_owner_token, derive_owner_token_from_preimage, validate_owner_token,
    validate_stable_id,
};

#[test]
fn owner_token_shape_and_semantics_are_exact() {
    let owner_code =
        |input: &[u8]| derive_owner_token_from_preimage(input).map_err(|error| error.code());
    let preimage = |namespace: &str, owner: &str, revision: &str, status: &str| {
        format!(
            "[\"eliotr.source-owner.initial.v1\",\"{namespace}\",\"{owner}\",\"installation-1\",{revision},\"{status}\"]"
        )
        .into_bytes()
    };
    assert!(owner_code(&preimage("n", "eliotr", "1", "ACTIVE")).is_ok());
    assert_eq!(
        owner_code(&preimage("n", "eliotr", "1", "ACTIVE"))
            .map(|token| token.starts_with("owner-")),
        Ok(true)
    );
    for (input, expected) in [
        (
            preimage("n", "eliotr", "1", "ACTIVE").as_slice().to_vec(),
            "",
        ),
        (b"[]".to_vec(), OWNER_TOKEN_SHAPE_CODE),
        (
            b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",1,\"ACTIVE\",\"x\"]"
                .to_vec(),
            OWNER_TOKEN_SHAPE_CODE,
        ),
        (
            b"[\"eliotr.source-owner.initial.v1\",\"n\",\"external\",\"i\",1,\"ACTIVE\"]".to_vec(),
            OWNER_TOKEN_OWNER_CODE,
        ),
        (
            b"[\"wrong-schema\",\"n\",\"eliotr\",\"i\",1,\"ACTIVE\"]".to_vec(),
            OWNER_TOKEN_SCHEMA_CODE,
        ),
        (
            preimage("n", "eliotr", "2", "ACTIVE"),
            OWNER_TOKEN_REVISION_CODE,
        ),
        (
            preimage("n", "eliotr", "10", "ACTIVE"),
            OWNER_TOKEN_REVISION_CODE,
        ),
        (
            preimage("n", "eliotr", "19", "ACTIVE"),
            OWNER_TOKEN_REVISION_CODE,
        ),
        (
            preimage("n", "eliotr", "0", "ACTIVE"),
            OWNER_TOKEN_REVISION_CODE,
        ),
        (
            preimage("n", "eliotr", "1", "FENCED"),
            OWNER_TOKEN_STATE_CODE,
        ),
        (
            preimage("", "eliotr", "1", "ACTIVE"),
            OWNER_TOKEN_NAMESPACE_CODE,
        ),
        (
            preimage("__proto__", "eliotr", "1", "ACTIVE"),
            OWNER_TOKEN_NAMESPACE_CODE,
        ),
    ] {
        if expected.is_empty() {
            assert!(owner_code(&input).is_ok());
        } else {
            assert_eq!(owner_code(&input), Err(expected));
        }
    }
    assert_eq!(
        owner_code(
            b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"__proto__\",1,\"ACTIVE\"]"
        ),
        Err(OWNER_TOKEN_INCARNATION_CODE)
    );
    assert_eq!(
        owner_code(b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",\"1\",\"ACTIVE\"]"),
        Err(OWNER_TOKEN_SHAPE_CODE)
    );
    assert_eq!(
        derive_owner_token(b"", b"installation-1").map_err(|error| error.code()),
        Err(OWNER_TOKEN_NAMESPACE_CODE)
    );
}

#[test]
fn owner_token_validation_pins_length_prefix_alphabet() {
    let token = derive_owner_token(b"local-imports", b"installation-1");
    assert!(token.is_ok());
    let Ok(token) = token else { return };
    assert_eq!(
        validate_owner_token(token.as_bytes()).map(|value| value.len()),
        Ok(token.len())
    );
    assert_eq!(
        validate_owner_token(b"owner-00").map_err(|error| error.code()),
        Err(OWNER_TOKEN_LENGTH_CODE)
    );
    let mut bad_prefix = token.as_bytes().to_vec();
    bad_prefix[0] = b'x';
    assert_eq!(
        validate_owner_token(&bad_prefix).map_err(|error| error.code()),
        Err(OWNER_TOKEN_PREFIX_CODE)
    );
    let mut upper = token.as_bytes().to_vec();
    upper[6] = b'A';
    assert_eq!(
        validate_owner_token(&upper).map_err(|error| error.code()),
        Err(OWNER_TOKEN_ALPHABET_CODE)
    );
    assert_eq!(
        validate_owner_token(&upper),
        Err(OwnerTokenError::InvalidAlphabet { offset: 6 })
    );
}

#[test]
fn generation_alphabet_offset_is_exact_at_digest_start() {
    let bad_first = format!("g1_X{}", "0".repeat(63));
    assert_eq!(
        eliotr_canonical::validate_generation_token(bad_first.as_bytes()),
        Err(eliotr_canonical::GenerationTokenError::Alphabet { offset: 3 })
    );
    let bad_mid = format!("g1_{}Z{}", "0".repeat(10), "0".repeat(53));
    assert_eq!(
        eliotr_canonical::validate_generation_token(bad_mid.as_bytes()),
        Err(eliotr_canonical::GenerationTokenError::Alphabet { offset: 13 })
    );
    assert_eq!(
        eliotr_canonical::validate_generation_token(bad_mid.as_bytes())
            .map_err(|error| error.code()),
        Err(GENERATION_ALPHABET_CODE)
    );
}

#[test]
fn stable_id_alphabet_length_and_prefix_shapes_are_exact() {
    assert_eq!(
        validate_stable_id(b"a-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            .map_err(StableIdError::code),
        Err(STABLE_ID_ALPHABET_CODE)
    );
    assert_eq!(
        validate_stable_id(b"a-00000000000000000000000000000000000000000000000")
            .map_err(StableIdError::code),
        Err(STABLE_ID_LENGTH_CODE)
    );
    assert_eq!(
        validate_stable_id(b"_bad-000000000000000000000000000000000000000000000000")
            .map_err(StableIdError::code),
        Err(STABLE_ID_PREFIX_CODE)
    );
    assert_eq!(
        validate_stable_id(b"b-0000000000000000000000000000000000000000000000000")
            .map_err(StableIdError::code),
        Err(STABLE_ID_LENGTH_CODE)
    );
}

#[test]
fn every_snapshot_error_code_is_pinned() {
    let cases: &[(SnapshotIdentityError, &str)] = &[
        (
            SnapshotIdentityError::InputTooLarge {
                actual_bytes: 2,
                max_bytes: 1,
            },
            eliotr_canonical::SNAPSHOT_INPUT_TOO_LARGE_CODE,
        ),
        (
            SnapshotIdentityError::InvalidUtf8 { valid_up_to: 1 },
            eliotr_canonical::SNAPSHOT_UTF8_CODE,
        ),
        (
            SnapshotIdentityError::Syntax { offset: 1 },
            eliotr_canonical::SNAPSHOT_SYNTAX_CODE,
        ),
        (
            SnapshotIdentityError::DuplicateKey { offset: 1 },
            eliotr_canonical::SNAPSHOT_DUPLICATE_KEY_CODE,
        ),
        (
            SnapshotIdentityError::Unicode { offset: 1 },
            eliotr_canonical::SNAPSHOT_UNICODE_CODE,
        ),
        (
            SnapshotIdentityError::Number { offset: 1 },
            eliotr_canonical::SNAPSHOT_NUMBER_CODE,
        ),
        (
            SnapshotIdentityError::DepthLimit { max_depth: 1 },
            eliotr_canonical::SNAPSHOT_DEPTH_LIMIT_CODE,
        ),
        (
            SnapshotIdentityError::MemberLimit { max_members: 1 },
            eliotr_canonical::SNAPSHOT_MEMBER_LIMIT_CODE,
        ),
        (
            SnapshotIdentityError::NodeLimit { max_nodes: 1 },
            eliotr_canonical::SNAPSHOT_NODE_LIMIT_CODE,
        ),
        (
            SnapshotIdentityError::StringTooLarge { max_bytes: 1 },
            eliotr_canonical::SNAPSHOT_STRING_TOO_LARGE_CODE,
        ),
        (
            SnapshotIdentityError::OutputTooLarge { max_bytes: 1 },
            eliotr_canonical::SNAPSHOT_OUTPUT_TOO_LARGE_CODE,
        ),
        (
            SnapshotIdentityError::Shape,
            eliotr_canonical::SNAPSHOT_SHAPE_CODE,
        ),
        (
            SnapshotIdentityError::MissingField,
            eliotr_canonical::SNAPSHOT_MISSING_FIELD_CODE,
        ),
        (
            SnapshotIdentityError::UnknownField,
            eliotr_canonical::SNAPSHOT_UNKNOWN_FIELD_CODE,
        ),
        (
            SnapshotIdentityError::Identifier,
            eliotr_canonical::SNAPSHOT_IDENTIFIER_CODE,
        ),
        (
            SnapshotIdentityError::Digest,
            eliotr_canonical::SNAPSHOT_DIGEST_CODE,
        ),
        (
            SnapshotIdentityError::Revision,
            eliotr_canonical::SNAPSHOT_REVISION_CODE,
        ),
        (
            SnapshotIdentityError::Timestamp,
            eliotr_canonical::SNAPSHOT_TIMESTAMP_CODE,
        ),
        (
            SnapshotIdentityError::Expression,
            eliotr_canonical::SNAPSHOT_EXPRESSION_CODE,
        ),
        (
            SnapshotIdentityError::IdMismatch,
            eliotr_canonical::SNAPSHOT_ID_MISMATCH_CODE,
        ),
        (
            SnapshotIdentityError::DigestMismatch,
            eliotr_canonical::SNAPSHOT_DIGEST_MISMATCH_CODE,
        ),
    ];
    for (error, expected) in cases {
        assert_eq!(error.code(), *expected);
        assert!(!error.to_string().is_empty());
    }
    assert_eq!(
        SnapshotIdentityError::Timestamp.code(),
        SNAPSHOT_TIMESTAMP_CODE
    );
    assert_eq!(
        SnapshotIdentityError::Expression.code(),
        SNAPSHOT_EXPRESSION_CODE
    );
    assert_eq!(
        SnapshotIdentityError::IdMismatch.code(),
        SNAPSHOT_ID_MISMATCH_CODE
    );
    assert_eq!(
        SnapshotIdentityError::DigestMismatch.code(),
        SNAPSHOT_DIGEST_MISMATCH_CODE
    );
}

#[test]
fn every_json_owner_and_stable_error_code_is_pinned() {
    let json: &[(CanonicalJsonError, &str)] = &[
        (
            CanonicalJsonError::InputTooLarge {
                actual_bytes: 1,
                max_bytes: 0,
            },
            eliotr_canonical::JSON_INPUT_TOO_LARGE_CODE,
        ),
        (
            CanonicalJsonError::InvalidUtf8 { valid_up_to: 0 },
            eliotr_canonical::JSON_INVALID_UTF8_CODE,
        ),
        (
            CanonicalJsonError::Syntax { offset: 0 },
            eliotr_canonical::JSON_SYNTAX_CODE,
        ),
        (
            CanonicalJsonError::DuplicateKey { offset: 0 },
            eliotr_canonical::JSON_DUPLICATE_KEY_CODE,
        ),
        (
            CanonicalJsonError::DepthLimit { max_depth: 0 },
            eliotr_canonical::JSON_DEPTH_LIMIT_CODE,
        ),
        (
            CanonicalJsonError::MemberLimit { max_members: 0 },
            eliotr_canonical::JSON_MEMBER_LIMIT_CODE,
        ),
        (
            CanonicalJsonError::ItemLimit { max_items: 0 },
            eliotr_canonical::JSON_ITEM_LIMIT_CODE,
        ),
        (
            CanonicalJsonError::NodeLimit { max_nodes: 0 },
            eliotr_canonical::JSON_NODE_LIMIT_CODE,
        ),
        (
            CanonicalJsonError::StringTooLarge { max_bytes: 0 },
            eliotr_canonical::JSON_STRING_TOO_LARGE_CODE,
        ),
        (
            CanonicalJsonError::Number { offset: 0 },
            eliotr_canonical::JSON_NUMBER_CODE,
        ),
        (
            CanonicalJsonError::Unicode { offset: 0 },
            eliotr_canonical::JSON_UNICODE_CODE,
        ),
        (
            CanonicalJsonError::OutputTooLarge { max_bytes: 0 },
            eliotr_canonical::JSON_OUTPUT_TOO_LARGE_CODE,
        ),
    ];
    for (error, expected) in json {
        assert_eq!(error.code(), *expected);
    }
    let owner: &[(OwnerTokenError, &str)] = &[
        (
            OwnerTokenError::InputTooLarge {
                actual_bytes: 1,
                max_bytes: 0,
            },
            eliotr_canonical::OWNER_TOKEN_INPUT_TOO_LARGE_CODE,
        ),
        (
            OwnerTokenError::InvalidUtf8 { valid_up_to: 0 },
            eliotr_canonical::OWNER_TOKEN_UTF8_CODE,
        ),
        (
            OwnerTokenError::Syntax { offset: 0 },
            eliotr_canonical::OWNER_TOKEN_SYNTAX_CODE,
        ),
        (
            OwnerTokenError::Unicode { offset: 0 },
            eliotr_canonical::OWNER_TOKEN_UNICODE_CODE,
        ),
        (OwnerTokenError::Shape, OWNER_TOKEN_SHAPE_CODE),
        (OwnerTokenError::Schema, OWNER_TOKEN_SCHEMA_CODE),
        (OwnerTokenError::Namespace, OWNER_TOKEN_NAMESPACE_CODE),
        (OwnerTokenError::Incarnation, OWNER_TOKEN_INCARNATION_CODE),
        (OwnerTokenError::Owner, OWNER_TOKEN_OWNER_CODE),
        (OwnerTokenError::Revision, OWNER_TOKEN_REVISION_CODE),
        (OwnerTokenError::State, OWNER_TOKEN_STATE_CODE),
        (
            OwnerTokenError::InvalidLength {
                actual_bytes: 0,
                min_bytes: 1,
                max_bytes: 2,
            },
            OWNER_TOKEN_LENGTH_CODE,
        ),
        (OwnerTokenError::Prefix, OWNER_TOKEN_PREFIX_CODE),
        (
            OwnerTokenError::InvalidAlphabet { offset: 0 },
            OWNER_TOKEN_ALPHABET_CODE,
        ),
    ];
    for (error, expected) in owner {
        assert_eq!(error.code(), *expected);
    }
    let stable: &[(StableIdError, &str)] = &[
        (
            StableIdError::InputTooLarge {
                actual_bytes: 1,
                max_bytes: 0,
            },
            eliotr_canonical::STABLE_ID_INPUT_TOO_LARGE_CODE,
        ),
        (
            StableIdError::PrefixTooLarge {
                actual_bytes: 1,
                max_bytes: 0,
            },
            eliotr_canonical::STABLE_ID_PREFIX_TOO_LARGE_CODE,
        ),
        (StableIdError::InvalidPrefix, STABLE_ID_PREFIX_CODE),
        (
            StableIdError::TooManyParts {
                actual_parts: 1,
                max_parts: 0,
            },
            eliotr_canonical::STABLE_ID_TOO_MANY_PARTS_CODE,
        ),
        (
            StableIdError::PartTooLarge {
                index: 0,
                actual_bytes: 1,
                max_bytes: 0,
            },
            eliotr_canonical::STABLE_ID_PART_TOO_LARGE_CODE,
        ),
        (
            StableIdError::InteriorNul {
                index: 0,
                offset: 0,
            },
            eliotr_canonical::STABLE_ID_NUL_CODE,
        ),
        (
            StableIdError::InvalidUtf8 {
                field: StableIdUtf8Field::Prefix,
                valid_up_to: 0,
            },
            eliotr_canonical::STABLE_ID_UTF8_CODE,
        ),
        (
            StableIdError::InvalidLength {
                actual_bytes: 0,
                min_bytes: 1,
                max_bytes: 2,
            },
            STABLE_ID_LENGTH_CODE,
        ),
        (
            StableIdError::InvalidAlphabet { offset: 0 },
            STABLE_ID_ALPHABET_CODE,
        ),
    ];
    for (error, expected) in stable {
        assert_eq!(error.code(), *expected);
    }
    assert_eq!(
        GenerationTokenError::Alphabet { offset: 0 }.code(),
        GENERATION_ALPHABET_CODE
    );
}

#[test]
fn error_display_pins_field_names_and_codes() {
    for (field, name) in [
        (ResidencyKeyField::ScopeDomainId, "scope_domain_id"),
        (ResidencyKeyField::AccessDomainId, "access_domain_id"),
        (
            ResidencyKeyField::ConfidentialityDomainId,
            "confidentiality_domain_id",
        ),
        (
            ResidencyKeyField::EncryptionKeyDomainId,
            "encryption_key_domain_id",
        ),
        (ResidencyKeyField::RetentionDomainId, "retention_domain_id"),
        (ResidencyKeyField::ErasureDomainId, "erasure_domain_id"),
        (ResidencyKeyField::ContentDigest, "content_digest"),
    ] {
        let message = ResidencyKeyError::EmptyIdentifier { field }.to_string();
        assert!(message.contains(name), "field {name}");
        let too_long = ResidencyKeyError::IdentifierTooLong {
            field,
            actual_utf16_units: 2,
            max_utf16_units: 1,
        }
        .to_string();
        assert!(too_long.contains(name), "field {name}");
    }
    for (error, name) in [
        (
            StableIdError::InvalidUtf8 {
                field: StableIdUtf8Field::Prefix,
                valid_up_to: 0,
            },
            "prefix",
        ),
        (
            StableIdError::InvalidUtf8 {
                field: StableIdUtf8Field::Part { index: 0 },
                valid_up_to: 0,
            },
            "part",
        ),
        (
            StableIdError::InvalidUtf8 {
                field: StableIdUtf8Field::Identifier,
                valid_up_to: 0,
            },
            "identifier",
        ),
    ] {
        assert!(error.to_string().contains(name), "field {name}");
    }
}
