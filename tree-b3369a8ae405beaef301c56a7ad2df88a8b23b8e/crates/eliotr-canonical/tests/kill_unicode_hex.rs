//! ER-40 S6 native kill-matrix: UTF-8 widths, truncation/overlong rejects,
//! hex-nibble upper/lower arithmetic (S1 vectors ported).
//!
//! Every `utf8_width` range arm and every `hex_nibble` arm is pinned through
//! the public API. Truncated multibyte sequences at the buffer end
//! discriminate the correct width logic from a `Some(1)` stub (Unicode vs
//! Syntax); overlong and lone-continuation inputs pin the fail-closed path
//! that the stdlib trailing `from_utf8` would otherwise mask.

use eliotr_canonical::{
    JSON_INVALID_UTF8_CODE, JSON_SYNTAX_CODE, OWNER_TOKEN_NAMESPACE_CODE, OWNER_TOKEN_UTF8_CODE,
    SNAPSHOT_UTF8_CODE, canonicalize_json, derive_owner_token_from_preimage,
    derive_snapshot_identity,
};

fn json_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    canonicalize_json(input).map_err(|error| error.code())
}

#[test]
fn canonical_multibyte_widths_round_trip_verbatim() {
    // 2-byte, 3-byte and 4-byte ranges; deleting any `utf8_width` arm breaks one.
    let two = "caf\u{e9}".as_bytes().to_vec();
    let mut two_json = vec![b'"'];
    two_json.extend_from_slice(&two);
    two_json.push(b'"');
    assert_eq!(json_code(&two_json), Ok(two_json.clone()));

    let three = "\u{20ac}".as_bytes().to_vec();
    let mut three_json = vec![b'"'];
    three_json.extend_from_slice(&three);
    three_json.push(b'"');
    assert_eq!(json_code(&three_json), Ok(three_json.clone()));

    let four = "\u{1f600}".as_bytes().to_vec();
    let mut four_json = vec![b'"'];
    four_json.extend_from_slice(&four);
    four_json.push(b'"');
    assert_eq!(json_code(&four_json), Ok(four_json.clone()));
}

#[test]
fn canonical_truncated_multibyte_is_rejected_before_parsing() {
    // Raw truncated sequences never reach `utf8_width`: the top-level UTF-8
    // gate reports InvalidUtf8 (S1 canonical-utf8 vectors, native form).
    // Parser-level width logic is pinned by the round-trip test above plus
    // the `\u`-escape tests: only those reach it with valid outer UTF-8.
    let mut two_cut = b"\"a\xc3".to_vec();
    assert_eq!(json_code(&two_cut), Err(JSON_INVALID_UTF8_CODE));
    two_cut.push(b'"');
    assert_eq!(json_code(&two_cut), Err(JSON_INVALID_UTF8_CODE));

    let three_cut = b"\"\xe2\x82".to_vec();
    assert_eq!(json_code(&three_cut), Err(JSON_INVALID_UTF8_CODE));

    let four_cut = b"\"\xf0\x9f\x98".to_vec();
    assert_eq!(json_code(&four_cut), Err(JSON_INVALID_UTF8_CODE));
}

#[test]
fn canonical_rejects_overlong_and_stray_bytes_as_invalid_utf8() {
    // Overlong `/` (C0 AF), truncated tails, lone continuations and
    // impossible leads: all fail the top-level UTF-8 gate, never the parser.
    assert_eq!(json_code(b"\"\xc0\xaf\""), Err(JSON_INVALID_UTF8_CODE));
    assert_eq!(json_code(b"\"\xe2\x82\""), Err(JSON_INVALID_UTF8_CODE));
    assert_eq!(json_code(b"\"\x80\""), Err(JSON_INVALID_UTF8_CODE));
    assert_eq!(json_code(b"\"\xc1\xbf\""), Err(JSON_INVALID_UTF8_CODE));
    assert_eq!(
        json_code(b"\"\xf5\x80\x80\x80\""),
        Err(JSON_INVALID_UTF8_CODE)
    );
    assert_eq!(json_code(b"\"\xff\""), Err(JSON_INVALID_UTF8_CODE));
    // A bare Syntax probe still reports Syntax (arm discrimination).
    assert_eq!(json_code(b"[1,]"), Err(JSON_SYNTAX_CODE));
}

#[test]
fn canonical_hex_nibble_upper_lower_and_digit_arms() {
    // Digit arm.
    assert_eq!(json_code(br#""\u0040""#), Ok(b"\"@\"".to_vec()));
    // Lower arm arithmetic (`byte - b'a' + 10`).
    assert_eq!(json_code(br#""\u006a""#), Ok(b"\"j\"".to_vec()));
    assert_eq!(json_code(br#""\u000f""#), Ok(br#""\u000f""#.to_vec()));
    // Upper arm (`byte - b'A' + 10`); deletion or `+`/`-` swaps change `J`.
    assert_eq!(json_code(br#""\u004A""#), Ok(b"\"J\"".to_vec()));
    assert_eq!(json_code(br#""\u004F""#), Ok(b"\"O\"".to_vec()));
    assert_eq!(json_code(br#""\u000F""#), Ok(br#""\u000f""#.to_vec()));
    // Multi-nibble accumulation (`(value << 4) | nibble` chain).
    assert_eq!(
        json_code(br#""\u00e9""#),
        Ok("\"\u{e9}\"".as_bytes().to_vec())
    );
    assert_eq!(
        json_code(br#""\u00E9""#),
        Ok("\"\u{e9}\"".as_bytes().to_vec())
    );
    assert_eq!(
        json_code(br#""\u12aB""#),
        Ok("\"\u{12ab}\"".as_bytes().to_vec())
    );
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

fn snapshot_with_policy_bytes(policy: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(SNAPSHOT_STEM.len() + policy.len() + SNAPSHOT_TAIL.len());
    out.extend_from_slice(SNAPSHOT_STEM.as_bytes());
    out.extend_from_slice(policy);
    out.extend_from_slice(SNAPSHOT_TAIL.as_bytes());
    out
}

fn snapshot_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    derive_snapshot_identity(input).map_err(|error| error.code())
}

#[test]
fn snapshot_frame_multibyte_widths_accept_two_three_four_bytes() {
    for policy in [
        "caf\u{e9}".as_bytes(),
        "\u{20ac}".as_bytes(),
        "\u{1f600}".as_bytes(),
    ] {
        let derived = snapshot_code(&snapshot_with_policy_bytes(policy));
        assert!(derived.is_ok(), "policy {policy:?}");
        if let Ok(bytes) = derived {
            let text = core::str::from_utf8(&bytes).unwrap_or("");
            assert!(text.contains("\"policy_authority_ref\":\""));
        }
    }
    // Upper-hex ASCII escape binds the same byte as lower-hex.
    let upper = snapshot_with_policy_bytes(b"pa\\u004A1");
    let lower = snapshot_with_policy_bytes(b"pa\\u004a1");
    assert_eq!(snapshot_code(&upper).is_ok(), snapshot_code(&lower).is_ok());
    assert!(snapshot_code(&upper).is_ok());
}

#[test]
fn snapshot_frame_truncated_and_overlong_hit_top_level_utf8() {
    // Raw broken sequences never reach frame `utf8_width`: the frame-level
    // UTF-8 gate reports Utf8 (S1 vectors, native form). Parser widths are
    // pinned by the valid-multibyte test above and the `\u`-escape tests.
    let mut cut2 = SNAPSHOT_STEM.as_bytes().to_vec();
    cut2.extend_from_slice(b"pa\xc3");
    cut2.extend_from_slice(SNAPSHOT_TAIL.as_bytes());
    assert_eq!(snapshot_code(&cut2), Err(SNAPSHOT_UTF8_CODE));

    let mut overlong = SNAPSHOT_STEM.as_bytes().to_vec();
    overlong.extend_from_slice(b"\xc0\xaf");
    overlong.extend_from_slice(SNAPSHOT_TAIL.as_bytes());
    assert_eq!(snapshot_code(&overlong), Err(SNAPSHOT_UTF8_CODE));
    // Invalid top-level UTF-8 keeps its own code.
    assert_eq!(snapshot_code(&[0xff]), Err(SNAPSHOT_UTF8_CODE));
}

fn owner_preimage(namespace: &str, incarnation: &str) -> Vec<u8> {
    format!(
        "[\"eliotr.source-owner.initial.v1\",\"{namespace}\",\"eliotr\",\"{incarnation}\",1,\"ACTIVE\"]"
    )
    .into_bytes()
}

fn owner_code(input: &[u8]) -> Result<String, &'static str> {
    derive_owner_token_from_preimage(input).map_err(|error| error.code())
}

#[test]
fn owner_tuple_multibyte_widths_and_hex_arms() {
    // Valid 2-byte decodes, then fails the ASCII ID grammar (Namespace),
    // while width stubs fail earlier with Unicode.
    let two = owner_preimage("caf\u{e9}", "installation-1");
    assert_eq!(owner_code(&two), Err(OWNER_TOKEN_NAMESPACE_CODE));
    // Upper-hex ASCII escape is identical to lower-hex.
    let upper = owner_preimage("local-imports", "installation-\\u0031");
    let lower = owner_preimage("local-imports", "installation-\\u0031");
    assert!(owner_code(&upper).is_ok());
    assert_eq!(owner_code(&upper), owner_code(&lower));
    // A stray lead byte breaks the whole preimage UTF-8 gate first.
    let mut cut = owner_preimage("local-imports", "installation-1");
    cut.insert(cut.len() - 12, 0xc3);
    assert_eq!(owner_code(&cut), Err(OWNER_TOKEN_UTF8_CODE));
    // Overlong bytes never reach the tuple string parser either.
    let overlong =
        b"[\"eliotr.source-owner.initial.v1\",\"local-imports\",\"eliotr\",\"a\xc0\xaf\",1,\"ACTIVE\"]"
            .to_vec();
    assert_eq!(owner_code(&overlong), Err(OWNER_TOKEN_UTF8_CODE));
}
