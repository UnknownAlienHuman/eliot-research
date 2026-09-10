use eliotr_canonical::{
    GENERATION_ALPHABET_CODE, GENERATION_LENGTH_CODE, GENERATION_PREFIX_CODE,
    GENERATION_TOKEN_BYTES, GenerationTokenError, format_generation_token,
    generation_token_for_body, sha256, validate_generation_token,
};

fn lower_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(hex_nibble(byte >> 4)));
        output.push(char::from(hex_nibble(byte & 0x0f)));
    }
    output
}

const fn hex_nibble(nibble: u8) -> u8 {
    match nibble {
        0..=9 => b'0' + nibble,
        _ => b'a' + (nibble - 10),
    }
}

#[test]
fn sha256_matches_fips_and_nist_vectors() {
    let vectors = [
        (
            b"".as_slice(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            b"abc".as_slice(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
        (
            b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".as_slice(),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ),
    ];
    for (input, expected) in vectors {
        assert_eq!(lower_hex(&sha256(input)), expected);
    }

    let million_a = vec![b'a'; 1_000_000];
    assert_eq!(
        lower_hex(&sha256(&million_a)),
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
}

#[test]
fn fixed_width_generation_tokens_bind_exact_body_bytes() {
    let empty_digest = sha256(b"");
    let token = format_generation_token(&empty_digest);
    assert_eq!(
        token,
        "g1_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(token.len(), GENERATION_TOKEN_BYTES);
    assert_eq!(
        validate_generation_token(token.as_bytes()),
        Ok(token.as_str())
    );
    assert_eq!(generation_token_for_body(b""), token);
    assert_ne!(
        generation_token_for_body(b"a"),
        generation_token_for_body(b"b")
    );
}

#[test]
fn generation_validation_rejects_length_prefix_and_alphabet() {
    let short = validate_generation_token(b"g1_deadbeef");
    assert!(matches!(short, Err(error) if error.code() == GENERATION_LENGTH_CODE));

    let wrong_prefix = format!("x1_{}", "0".repeat(64));
    let prefix = validate_generation_token(wrong_prefix.as_bytes());
    assert!(matches!(prefix, Err(error) if error.code() == GENERATION_PREFIX_CODE));

    let uppercase = format!("g1_{}A", "0".repeat(63));
    let alphabet = validate_generation_token(uppercase.as_bytes());
    assert!(matches!(alphabet, Err(error) if error.code() == GENERATION_ALPHABET_CODE));
}

#[test]
fn generation_errors_are_stable_and_content_free() {
    let errors = [
        GenerationTokenError::Length {
            actual_bytes: 1,
            expected_bytes: GENERATION_TOKEN_BYTES,
        },
        GenerationTokenError::Prefix,
        GenerationTokenError::Alphabet { offset: 3 },
    ];
    for error in errors {
        assert!(error.code().starts_with("ELIOTR_GENERATION_"));
        assert!(error.to_string().starts_with("generation token"));
    }
}
