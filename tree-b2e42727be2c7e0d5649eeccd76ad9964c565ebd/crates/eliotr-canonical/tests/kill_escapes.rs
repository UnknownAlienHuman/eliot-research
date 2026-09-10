//! ER-40 S6 native kill-matrix: JSON string escape arms (S1 vectors ported).
//!
//! Each `parse_escape` / `write_string` match arm is pinned by an exact-bytes
//! assertion through the public API, so deleting any single arm changes the
//! observable result. Covers `canonicalize_json`, the snapshot frame parser
//! (via `derive_snapshot_identity`) and the owner-token tuple parser (via
//! `derive_owner_token_from_preimage`).

use eliotr_canonical::{
    JSON_SYNTAX_CODE, JSON_UNICODE_CODE, OWNER_TOKEN_INCARNATION_CODE, OWNER_TOKEN_NAMESPACE_CODE,
    SNAPSHOT_EXPRESSION_CODE, SNAPSHOT_SYNTAX_CODE, SNAPSHOT_UNICODE_CODE, canonicalize_json,
    derive_owner_token_from_preimage, derive_snapshot_identity,
};

fn json_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    canonicalize_json(input).map_err(|error| error.code())
}

#[test]
fn canonical_parse_escape_arms_decode_to_exact_bytes() {
    // (input JSON string, expected canonical JSON string)
    let cases: &[(&[u8], &[u8])] = &[
        (br#""\"""#, br#""\"""#),
        (br#""\\""#, br#""\\""#),
        (br#""\/""#, b"\"/\""),
        (br#""\b""#, br#""\b""#),
        (br#""\f""#, br#""\f""#),
        (br#""\n""#, br#""\n""#),
        (br#""\r""#, br#""\r""#),
        (br#""\t""#, br#""\t""#),
    ];
    for (input, expected) in cases {
        assert_eq!(json_code(input), Ok(expected.to_vec()), "input {input:?}");
    }
}

#[test]
fn canonical_write_string_arms_emit_exact_bytes() {
    // Decoded control byte -> canonical re-escape (minimal JSON escaping).
    let cases: &[(&[u8], &[u8])] = &[
        (br#""\u0008""#, br#""\b""#),
        (br#""\u0009""#, br#""\t""#),
        (br#""\u000a""#, br#""\n""#),
        (br#""\u000c""#, br#""\f""#),
        (br#""\u000d""#, br#""\r""#),
        // Lower-hex trap: every nibble below 10 exercises `b'0' + nibble`.
        (br#""\u0001""#, br#""\u0001""#),
        // Letter-hex trap: the low nibble hits `b'a' + (nibble - 10)`,
        // the high nibble and `>>`/`&` splitting are pinned too.
        (br#""\u001f""#, br#""\u001f""#),
        (br#""\u001b""#, br#""\u001b""#),
    ];
    for (input, expected) in cases {
        assert_eq!(json_code(input), Ok(expected.to_vec()), "input {input:?}");
    }
}

#[test]
fn canonical_rejects_bad_escapes_with_exact_codes() {
    assert_eq!(json_code(br#""\x""#), Err(JSON_SYNTAX_CODE));
    assert_eq!(json_code(br#""\""#), Err(JSON_SYNTAX_CODE));
    assert_eq!(json_code(br#""\u00xz""#), Err(JSON_UNICODE_CODE));
    assert_eq!(json_code(br#""\ud800""#), Err(JSON_UNICODE_CODE));
    assert_eq!(json_code(br#""\udc00""#), Err(JSON_UNICODE_CODE));
    assert_eq!(json_code(br#""\ud800\u0041""#), Err(JSON_UNICODE_CODE));
    // Raw control bytes never take the escape path: Syntax, not Unicode.
    assert_eq!(json_code(b"\"\x1f\""), Err(JSON_SYNTAX_CODE));
    assert_eq!(json_code(b"\"\x00\""), Err(JSON_SYNTAX_CODE));
}

#[test]
fn canonical_surrogate_pair_decodes_to_astral_bytes() {
    assert_eq!(
        json_code(br#""\ud83d\ude00""#),
        Ok("\"\u{1f600}\"".as_bytes().to_vec())
    );
    assert_eq!(
        json_code("\"\u{1f600}\"".as_bytes()),
        Ok("\"\u{1f600}\"".as_bytes().to_vec())
    );
}

#[test]
fn canonical_upper_hex_escapes_match_lower_hex() {
    assert_eq!(json_code(br#""\u004A""#), Ok(b"\"J\"".to_vec()));
    assert_eq!(json_code(br#""\u004a""#), Ok(b"\"J\"".to_vec()));
    assert_eq!(json_code(br#""\u0041""#), Ok(b"\"A\"".to_vec()));
    assert_eq!(json_code(br#""\u000F""#), Ok(br#""\u000f""#.to_vec()));
    assert_eq!(json_code(br#""\u000f""#), Ok(br#""\u000f""#.to_vec()));
    assert_eq!(json_code(br#""\/""#), Ok(b"\"/\"".to_vec()));
}

const SNAPSHOT_STEM: &str = concat!(
    "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
    "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
    "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"",
);

const SNAPSHOT_TAIL: &str = concat!(
    "\",\"disclosure_closure_digest\":",
    "\"0000000000000000000000000000000000000000000000000000000000000000\",",
    "\"purge_ledger_revision\":0,\"created_at\":\"2026-01-01T00:00:00.000Z\",",
    "\"expires_at\":\"2026-01-01T00:15:00.000Z\"}",
);

fn snapshot_with_policy(policy_escape: &str) -> Vec<u8> {
    format!("{SNAPSHOT_STEM}{policy_escape}{SNAPSHOT_TAIL}").into_bytes()
}

#[test]
fn snapshot_frame_escape_arms_decode_policy_ref() {
    // (escaped source fragment, decoded value as it must appear in output)
    let cases: &[(&str, &str)] = &[
        (r"pa\/1", "pa/1"),
        ("pa\\\"1", "pa\\\"1"),
        (r"pa\\1", "pa\\\\1"),
        (r"pa\b1", "pa\\b1"),
        (r"pa\f1", "pa\\f1"),
        (r"pa\n1", "pa\\n1"),
        (r"pa\r1", "pa\\r1"),
        (r"pa\t1", "pa\\t1"),
        ("pa\\u004A1", "paJ1"),
        ("pa\\u004a1", "paJ1"),
    ];
    for (escaped, decoded) in cases {
        let derived = derive_snapshot_identity(&snapshot_with_policy(escaped));
        assert!(derived.is_ok(), "policy escape {escaped}");
        if let Ok(bytes) = derived {
            let text = core::str::from_utf8(&bytes).unwrap_or("");
            assert!(
                text.contains(&format!("\"policy_authority_ref\":\"{decoded}\"")),
                "policy escape {escaped}"
            );
        }
    }
}

#[test]
fn snapshot_frame_rejects_bad_escapes_with_exact_codes() {
    let bad_escape = snapshot_with_policy(r"pa\x1");
    assert_eq!(
        derive_snapshot_identity(&bad_escape).map_err(|error| error.code()),
        Err(SNAPSHOT_SYNTAX_CODE)
    );
    let lone_high = snapshot_with_policy("pa\\ud8001");
    assert_eq!(
        derive_snapshot_identity(&lone_high).map_err(|error| error.code()),
        Err(SNAPSHOT_UNICODE_CODE)
    );
    let lone_low = snapshot_with_policy("pa\\udc001");
    assert_eq!(
        derive_snapshot_identity(&lone_low).map_err(|error| error.code()),
        Err(SNAPSHOT_UNICODE_CODE)
    );
    let bad_hex = snapshot_with_policy("pa\\u00xz1");
    assert_eq!(
        derive_snapshot_identity(&bad_hex).map_err(|error| error.code()),
        Err(SNAPSHOT_UNICODE_CODE)
    );
    // A raw control byte in the policy ref is Syntax, not Unicode.
    let mut raw = snapshot_with_policy("pa1");
    raw.insert(SNAPSHOT_STEM.len() + 2, 0x1f);
    assert_eq!(
        derive_snapshot_identity(&raw).map_err(|error| error.code()),
        Err(SNAPSHOT_SYNTAX_CODE)
    );
}

#[test]
fn snapshot_frame_expression_errors_keep_exact_code() {
    // Guards the `Expression` code arm used by validator kill cases.
    let mut material = core::str::from_utf8(&snapshot_with_policy("pa1"))
        .unwrap_or("")
        .to_owned();
    material = material.replace("\"kind\":\"GLOBAL_LIBRARY\"", "\"kind\":\"NOPE\"");
    assert_eq!(
        derive_snapshot_identity(material.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_EXPRESSION_CODE)
    );
}

fn owner_preimage(namespace: &str, incarnation: &str) -> Vec<u8> {
    format!(
        "[\"eliotr.source-owner.initial.v1\",\"{namespace}\",\"eliotr\",\"{incarnation}\",1,\"ACTIVE\"]"
    )
    .into_bytes()
}

#[test]
fn owner_tuple_escape_arms_decode_identifiers() {
    let canonical =
        derive_owner_token_from_preimage(&owner_preimage("local-imports", "installation-1"));
    assert!(canonical.is_ok());
    // `/` and upper-hex escapes must bind the identical canonical bytes.
    let plain_slash =
        derive_owner_token_from_preimage(&owner_preimage("local/imports", "installation-1"));
    let slash =
        derive_owner_token_from_preimage(&owner_preimage("local\\/imports", "installation-1"));
    assert!(plain_slash.is_ok());
    assert_eq!(plain_slash, slash);
    let upper =
        derive_owner_token_from_preimage(&owner_preimage("local-imports", "installation-\\u0031"));
    assert_eq!(canonical, upper);
    let quote = derive_owner_token_from_preimage(&owner_preimage("local-imports", "a\\\"b"));
    assert_eq!(
        quote.map_err(|error| error.code()),
        Err(OWNER_TOKEN_INCARNATION_CODE)
    );
}

#[test]
fn owner_tuple_control_escapes_fail_identifier_shape_not_syntax() {
    // Deleting a `parse_escape` arm turns these into Syntax; the correct
    // decoder yields Incarnation/Namespace shape errors instead.
    for (namespace, incarnation, code) in [
        ("local-imports", "a\\b1", OWNER_TOKEN_INCARNATION_CODE),
        ("local-imports", "a\\f1", OWNER_TOKEN_INCARNATION_CODE),
        ("local-imports", "a\\n1", OWNER_TOKEN_INCARNATION_CODE),
        ("local-imports", "a\\r1", OWNER_TOKEN_INCARNATION_CODE),
        ("local-imports", "a\\t1", OWNER_TOKEN_INCARNATION_CODE),
        ("a\\bb", "installation-1", OWNER_TOKEN_NAMESPACE_CODE),
    ] {
        assert_eq!(
            derive_owner_token_from_preimage(&owner_preimage(namespace, incarnation))
                .map_err(|error| error.code()),
            Err(code),
            "incarnation {incarnation}"
        );
    }
    // Surrogate pair decodes to non-ASCII, which the ID grammar rejects.
    assert_eq!(
        derive_owner_token_from_preimage(&owner_preimage("local-imports", "a\\ud83d\\ude001"))
            .map_err(|error| error.code()),
        Err(OWNER_TOKEN_INCARNATION_CODE)
    );
}
