use eliotr_canonical::{
    CanonicalJsonError, JSON_DEPTH_LIMIT_CODE, JSON_DUPLICATE_KEY_CODE, JSON_INPUT_TOO_LARGE_CODE,
    JSON_INVALID_UTF8_CODE, JSON_ITEM_LIMIT_CODE, JSON_MEMBER_LIMIT_CODE, JSON_NODE_LIMIT_CODE,
    JSON_NUMBER_CODE, JSON_OUTPUT_TOO_LARGE_CODE, JSON_STRING_TOO_LARGE_CODE, JSON_SYNTAX_CODE,
    JSON_UNICODE_CODE, MAX_CANONICAL_JSON_ARRAY_ITEMS, MAX_CANONICAL_JSON_DEPTH,
    MAX_CANONICAL_JSON_INPUT_BYTES, MAX_CANONICAL_JSON_NODES, MAX_CANONICAL_JSON_OBJECT_MEMBERS,
    MAX_CANONICAL_JSON_OUTPUT_BYTES, MAX_CANONICAL_JSON_STRING_BYTES, canonicalize_json,
};

fn assert_error(input: &[u8], expected_code: &str) {
    let result = canonicalize_json(input);
    assert!(matches!(result, Err(error) if error.code() == expected_code));
}

#[test]
fn canonicalizes_primitives_whitespace_and_safe_integers() {
    let cases: &[(&[u8], &[u8])] = &[
        (b" null ", b"null"),
        (b"\ntrue\t", b"true"),
        (b"false", b"false"),
        (b"0", b"0"),
        (b"9007199254740991", b"9007199254740991"),
        (b"-9007199254740991", b"-9007199254740991"),
    ];
    for (input, expected) in cases {
        assert_eq!(canonicalize_json(input), Ok(expected.to_vec()));
    }
}

#[test]
fn sorts_decoded_keys_and_preserves_array_order() {
    assert_eq!(
        canonicalize_json(br#" { "z" : [3,2,1], "a" : {"b":2,"a":1} } "#),
        Ok(br#"{"a":{"a":1,"b":2},"z":[3,2,1]}"#.to_vec())
    );
    assert_eq!(
        canonicalize_json(r#"{"é":1,"z":2,"a":3}"#.as_bytes()),
        Ok(r#"{"a":3,"z":2,"é":1}"#.as_bytes().to_vec())
    );
}

#[test]
fn matches_ecmascript_utf16_order_for_astral_keys() {
    assert_eq!(
        canonicalize_json(r#"{"\ue000":2,"😀":1}"#.as_bytes()),
        Ok("{\"😀\":1,\"\u{e000}\":2}".as_bytes().to_vec())
    );
}

#[test]
fn normalizes_string_escapes_without_unicode_normalization() {
    assert_eq!(
        canonicalize_json(br#"{"emoji":"\ud83d\ude00","text":"\u0041\/\n\t","nul":"\u0000"}"#),
        Ok(
            "{\"emoji\":\"😀\",\"nul\":\"\\u0000\",\"text\":\"A/\\n\\t\"}"
                .as_bytes()
                .to_vec()
        )
    );
    assert_eq!(
        canonicalize_json("\"é\"".as_bytes()),
        Ok("\"é\"".as_bytes().to_vec())
    );
}

#[test]
fn rejects_input_utf8_syntax_duplicate_number_and_unicode_failures() {
    assert_error(
        &vec![b' '; MAX_CANONICAL_JSON_INPUT_BYTES + 1],
        JSON_INPUT_TOO_LARGE_CODE,
    );
    assert_error(&[0xff], JSON_INVALID_UTF8_CODE);
    for input in [
        b"".as_slice(),
        b"tru".as_slice(),
        b"[1,]".as_slice(),
        b"{\"a\":1".as_slice(),
        b"{a:1}".as_slice(),
        b"\"unterminated".as_slice(),
        b"\"bad\\x\"".as_slice(),
        b"null true".as_slice(),
    ] {
        assert_error(input, JSON_SYNTAX_CODE);
    }
    assert_error(br#"{"a":1,"\u0061":2}"#, JSON_DUPLICATE_KEY_CODE);
    for input in [
        b"-0".as_slice(),
        b"01".as_slice(),
        b"1.0".as_slice(),
        b"1e3".as_slice(),
        b"9007199254740992".as_slice(),
        b"-9007199254740992".as_slice(),
    ] {
        assert_error(input, JSON_NUMBER_CODE);
    }
    for input in [
        br#""\ud800""#.as_slice(),
        br#""\udc00""#.as_slice(),
        br#""\ud800\u0041""#.as_slice(),
        br#""\u00xz""#.as_slice(),
    ] {
        assert_error(input, JSON_UNICODE_CODE);
    }
}

#[test]
fn rejects_every_explicit_structure_limit() {
    let depth = format!(
        "{}0{}",
        "[".repeat(MAX_CANONICAL_JSON_DEPTH + 1),
        "]".repeat(MAX_CANONICAL_JSON_DEPTH + 1)
    );
    assert_error(depth.as_bytes(), JSON_DEPTH_LIMIT_CODE);

    let members = (0..=MAX_CANONICAL_JSON_OBJECT_MEMBERS)
        .map(|index| format!("\"k{index}\":0"))
        .collect::<Vec<_>>()
        .join(",");
    assert_error(format!("{{{members}}}").as_bytes(), JSON_MEMBER_LIMIT_CODE);

    let items = vec!["0"; MAX_CANONICAL_JSON_ARRAY_ITEMS + 1].join(",");
    assert_error(format!("[{items}]").as_bytes(), JSON_ITEM_LIMIT_CODE);

    let node_members = (0..MAX_CANONICAL_JSON_OBJECT_MEMBERS)
        .map(|index| format!("\"k{index}\":[0,0,0,0,0,0,0]"))
        .collect::<Vec<_>>()
        .join(",");
    assert_eq!(
        1 + MAX_CANONICAL_JSON_OBJECT_MEMBERS * 8,
        MAX_CANONICAL_JSON_NODES + 1
    );
    assert_error(
        format!("{{{node_members}}}").as_bytes(),
        JSON_NODE_LIMIT_CODE,
    );
}

#[test]
fn rejects_decoded_string_and_canonical_output_limits() {
    let long_string = format!("\"{}\"", "a".repeat(MAX_CANONICAL_JSON_STRING_BYTES + 1));
    assert_error(long_string.as_bytes(), JSON_STRING_TOO_LARGE_CODE);

    let item = format!("\"{}\"", "a".repeat(25 * 1024));
    let output_heavy = format!("[{item},{item},{item},{item}]");
    assert!(output_heavy.len() < MAX_CANONICAL_JSON_INPUT_BYTES);
    assert!(output_heavy.len() > MAX_CANONICAL_JSON_OUTPUT_BYTES);
    assert_error(output_heavy.as_bytes(), JSON_OUTPUT_TOO_LARGE_CODE);
}

#[test]
fn error_codes_and_messages_are_stable_and_content_free() {
    let errors = [
        CanonicalJsonError::InputTooLarge {
            actual_bytes: 2,
            max_bytes: 1,
        },
        CanonicalJsonError::InvalidUtf8 { valid_up_to: 1 },
        CanonicalJsonError::Syntax { offset: 2 },
        CanonicalJsonError::DuplicateKey { offset: 3 },
        CanonicalJsonError::DepthLimit { max_depth: 4 },
        CanonicalJsonError::MemberLimit { max_members: 5 },
        CanonicalJsonError::ItemLimit { max_items: 6 },
        CanonicalJsonError::NodeLimit { max_nodes: 7 },
        CanonicalJsonError::StringTooLarge { max_bytes: 8 },
        CanonicalJsonError::Number { offset: 9 },
        CanonicalJsonError::Unicode { offset: 10 },
        CanonicalJsonError::OutputTooLarge { max_bytes: 11 },
    ];
    for error in errors {
        assert!(error.code().starts_with("ELIOTR_JSON_"));
        let message = error.to_string();
        assert!(message.starts_with("canonical JSON"));
        assert!(!message.contains("secret"));
    }
}
