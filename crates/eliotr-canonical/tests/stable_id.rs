use eliotr_canonical::{
    STABLE_ID_ALPHABET_CODE, STABLE_ID_INPUT_MAX_BYTES, STABLE_ID_INPUT_TOO_LARGE_CODE,
    STABLE_ID_LENGTH_CODE, STABLE_ID_MAX_PARTS, STABLE_ID_NUL_CODE,
    STABLE_ID_PART_MAX_BYTES, STABLE_ID_PART_TOO_LARGE_CODE, STABLE_ID_PREFIX_CODE,
    STABLE_ID_PREFIX_MAX_BYTES, STABLE_ID_PREFIX_TOO_LARGE_CODE,
    STABLE_ID_TOO_MANY_PARTS_CODE, STABLE_ID_UTF8_CODE, StableIdError,
    derive_stable_id, derive_stable_id_frame, validate_stable_id,
};

#[test]
fn derives_current_typescript_preimage_contract() {
    assert_eq!(
        derive_stable_id(b"source", &[]),
        Ok("source-41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb".to_owned())
    );
    assert_eq!(
        derive_stable_id(b"ingest", &[b"tenant:acme", b"idem-001"]),
        Ok("ingest-69814280d216cf7de14921157c815b4e2ceab2c7f28b42ae".to_owned())
    );
    assert_eq!(
        derive_stable_id_frame(b"receipt-ingest\0operation-001"),
        Ok("receipt-ingest-02f021330b27972ab7085dcbcd00340e701164d23fa4857e".to_owned())
    );
}

#[test]
fn preserves_empty_part_boundaries_and_unicode() {
    let no_parts = derive_stable_id(b"field", &[]);
    let empty_part = derive_stable_id(b"field", &[b""]);
    let split_left = derive_stable_id(b"field", &[b"ab", b"c"]);
    let split_right = derive_stable_id(b"field", &[b"a", b"bc"]);

    assert!(no_parts.is_ok());
    assert!(empty_part.is_ok());
    assert_ne!(no_parts, empty_part);
    assert_ne!(split_left, split_right);
    assert_eq!(
        derive_stable_id(
            "evidence".as_bytes(),
            &["Привет".as_bytes(), "東京".as_bytes()]
        ),
        Ok("evidence-f6db5a50ca75c1102c9ec49ee839f80975663bd8bc3f2783".to_owned())
    );
}

#[test]
fn validates_hyphenated_prefixes_using_the_final_separator() {
    let id = derive_stable_id(b"a-", &[b"x"]);
    assert_eq!(
        id,
        Ok("a--bcf4ca8710298482578c25092acbc9a6b7bc50d98c9a3438".to_owned())
    );
    let Ok(id) = id else {
        return;
    };
    assert_eq!(validate_stable_id(id.as_bytes()), Ok(id.as_str()));
}

#[test]
fn rejects_prefix_part_count_and_part_size_boundaries() {
    let long_prefix = vec![b'a'; STABLE_ID_PREFIX_MAX_BYTES + 1];
    let too_many = vec![b"" as &[u8]; STABLE_ID_MAX_PARTS + 1];
    let long_part = vec![b'x'; STABLE_ID_PART_MAX_BYTES + 1];

    assert_eq!(
        derive_stable_id(&long_prefix, &[]).map_err(StableIdError::code),
        Err(STABLE_ID_PREFIX_TOO_LARGE_CODE)
    );
    assert_eq!(
        derive_stable_id(b"_bad", &[]).map_err(StableIdError::code),
        Err(STABLE_ID_PREFIX_CODE)
    );
    assert_eq!(
        derive_stable_id(b"parts", &too_many).map_err(StableIdError::code),
        Err(STABLE_ID_TOO_MANY_PARTS_CODE)
    );
    assert_eq!(
        derive_stable_id(b"part", &[long_part.as_slice()]).map_err(StableIdError::code),
        Err(STABLE_ID_PART_TOO_LARGE_CODE)
    );
}

#[test]
fn rejects_total_input_nul_and_utf8_ambiguity() {
    let huge = vec![b'x'; STABLE_ID_INPUT_MAX_BYTES - 1];
    assert_eq!(
        derive_stable_id(b"p", &[huge.as_slice()]).map_err(StableIdError::code),
        Err(STABLE_ID_INPUT_TOO_LARGE_CODE)
    );
    assert_eq!(
        derive_stable_id(b"p", &[b"a\0b"]).map_err(StableIdError::code),
        Err(STABLE_ID_NUL_CODE)
    );
    assert_eq!(
        derive_stable_id_frame(&[0xff]).map_err(StableIdError::code),
        Err(STABLE_ID_UTF8_CODE)
    );
    assert_eq!(
        derive_stable_id_frame(&[b'p', 0, 0xff]).map_err(StableIdError::code),
        Err(STABLE_ID_UTF8_CODE)
    );
}

#[test]
fn validates_exact_identifier_shape_and_alphabet() {
    let valid = b"source-41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb";
    assert_eq!(
        validate_stable_id(valid),
        Ok("source-41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb")
    );

    for invalid in [
        b"" as &[u8],
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        b"a-00000000000000000000000000000000000000000000000",
        b"a-0000000000000000000000000000000000000000000000000",
    ] {
        assert_eq!(
            validate_stable_id(invalid).map_err(StableIdError::code),
            Err(STABLE_ID_LENGTH_CODE)
        );
    }
    assert_eq!(
        validate_stable_id(b"_bad-000000000000000000000000000000000000000000000000")
            .map_err(StableIdError::code),
        Err(STABLE_ID_PREFIX_CODE)
    );
    assert_eq!(
        validate_stable_id(b"a-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            .map_err(StableIdError::code),
        Err(STABLE_ID_ALPHABET_CODE)
    );
}

#[test]
fn every_error_code_and_message_is_stable_and_content_free() {
    let errors = [
        StableIdError::InputTooLarge {
            actual_bytes: 2,
            max_bytes: 1,
        },
        StableIdError::PrefixTooLarge {
            actual_bytes: 2,
            max_bytes: 1,
        },
        StableIdError::InvalidPrefix,
        StableIdError::TooManyParts {
            actual_parts: 2,
            max_parts: 1,
        },
        StableIdError::PartTooLarge {
            index: 1,
            actual_bytes: 2,
            max_bytes: 1,
        },
        StableIdError::InteriorNul {
            index: 1,
            offset: 2,
        },
        StableIdError::InvalidUtf8 {
            field: eliotr_canonical::StableIdUtf8Field::Part { index: 1 },
            valid_up_to: 2,
        },
        StableIdError::InvalidLength {
            actual_bytes: 1,
            min_bytes: 50,
            max_bytes: 113,
        },
        StableIdError::InvalidAlphabet { offset: 2 },
    ];

    for error in errors {
        assert!(error.code().starts_with("ELIOTR_STABLE_ID_"));
        let message = error.to_string();
        assert!(message.starts_with("stable"));
        assert!(!message.contains("secret"));
    }
}
