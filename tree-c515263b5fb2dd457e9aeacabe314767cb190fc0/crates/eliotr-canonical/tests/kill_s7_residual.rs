//! ER-40 S7 residual kill-matrix: S6 survivors (run 34180006437, 107 missed).
//!
//! Style matches S6 `kill_*.rs`: `#[test]` through the public API only,
//! programmatic generation (no fixtures), exact bytes and exact error codes/
//! structs. Hardcoded ceilings (no `MAX_*` const reads) pin `*`/`+` const
//! mutants; triple MAX-1/MAX/MAX+1 boundaries pin every `>`/`>=`/`==`/`<`
//! guard; nontrivial codepoints pin unicode arithmetic.

use eliotr_canonical::{
    CanonicalJsonError, MAX_CANONICAL_JSON_DEPTH, MAX_CANONICAL_JSON_INPUT_BYTES,
    MAX_CANONICAL_JSON_PARSER_STEPS, OWNER_TOKEN_PREIMAGE_MAX_BYTES, OwnerTokenError,
    SNAPSHOT_INPUT_MAX_BYTES, SNAPSHOT_OUTPUT_MAX_BYTES, SNAPSHOT_PARSER_STEPS_MAX,
    STABLE_ID_DIGEST_HEX_BYTES, STABLE_ID_INPUT_MAX_BYTES, STABLE_ID_MAX_BYTES,
    STABLE_ID_MAX_PARTS, STABLE_ID_MIN_BYTES, StableIdError, canonicalize_json, derive_owner_token,
    derive_owner_token_from_preimage, derive_snapshot_identity, derive_stable_id,
    derive_stable_id_frame, validate_owner_token, validate_stable_id,
};

fn json_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    canonicalize_json(input).map_err(|error| error.code())
}

fn snapshot_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    derive_snapshot_identity(input).map_err(|error| error.code())
}

fn owner_code(input: &[u8]) -> Result<String, &'static str> {
    derive_owner_token_from_preimage(input).map_err(|error| error.code())
}

fn owner_preimage(namespace: &str, incarnation: &str) -> Vec<u8> {
    format!("[\"eliotr.source-owner.initial.v1\",\"{namespace}\",\"eliotr\",\"{incarnation}\",1,\"ACTIVE\"]")
        .into_bytes()
}

// ---------------------------------------------------------------------------
// A. Const ceilings are exact (kills `*`/`+` const mutants that self-referential
// S6 tests could not see because they built inputs from the mutated const).
// ---------------------------------------------------------------------------

#[test]
fn const_ceilings_are_hardcoded_exact() {
    // 128 * 1024 = 131072; +1 guard.
    assert_eq!(MAX_CANONICAL_JSON_INPUT_BYTES, 131_072);
    assert_eq!(MAX_CANONICAL_JSON_PARSER_STEPS, 131_073);
    assert_eq!(MAX_CANONICAL_JSON_DEPTH, 64);
    // 2 * 1024 * 1024 = 2097152; a `*`->`+` mutant gives 1048578 or 3072.
    assert_eq!(SNAPSHOT_INPUT_MAX_BYTES, 2_097_152);
    assert_eq!(SNAPSHOT_OUTPUT_MAX_BYTES, 2_097_152);
    assert_eq!(SNAPSHOT_PARSER_STEPS_MAX, 2_097_153);
    // 2048 + 1 guard.
    assert_eq!(OWNER_TOKEN_PREIMAGE_MAX_BYTES, 2048);
    assert_eq!(eliotr_canonical::OWNER_TOKEN_PARSER_STEPS_MAX, 2049);
    // 64 * 1024 frame ceiling; 1 + 1 + 48 identifier envelope.
    assert_eq!(STABLE_ID_INPUT_MAX_BYTES, 65_536);
    assert_eq!(STABLE_ID_DIGEST_HEX_BYTES, 48);
    assert_eq!(STABLE_ID_MIN_BYTES, 50);
    assert_eq!(STABLE_ID_MAX_BYTES, 113);
    assert_eq!(STABLE_ID_MAX_PARTS, 32);
}

// ---------------------------------------------------------------------------
// B. Canonical object-depth boundary (kills canonical_json:173 `depth+1`->`*`).
// S6 pinned array depth only; the object path kept its own `depth + 1`.
// ---------------------------------------------------------------------------

#[test]
fn canonical_object_depth_64_ok_65_depth_limit() {
    // 64 nested objects admit; 65 exceed. Each level is `{"k":...}`.
    let mut ok: Vec<u8> = Vec::new();
    for _ in 0..64 {
        ok.extend_from_slice(b"{\"k\":");
    }
    ok.extend_from_slice(b"0");
    for _ in 0..64 {
        ok.extend_from_slice(b"}");
    }
    assert!(json_code(&ok).is_ok(), "64 objects must admit");

    let mut over = Vec::new();
    for _ in 0..65 {
        over.extend_from_slice(b"{\"k\":");
    }
    over.extend_from_slice(b"0");
    for _ in 0..65 {
        over.extend_from_slice(b"}");
    }
    assert_eq!(
        json_code(&over),
        Err(eliotr_canonical::JSON_DEPTH_LIMIT_CODE)
    );
    assert_eq!(
        canonicalize_json(&over),
        Err(CanonicalJsonError::DepthLimit { max_depth: 64 })
    );
}

// ---------------------------------------------------------------------------
// C. Canonical output budget exactly MAX (kills canonical_json:514 `>` mutants).
// Array-item and member ceilings are 256/128, so the exact-MAX output is built
// from 5 mid-size strings (no other ceiling fires).
// ---------------------------------------------------------------------------

#[test]
fn canonical_output_exact_max_ok_and_max_plus_one_rejected() {
    // Hardcoded ceiling: 96 * 1024 = 98304.
    const OUT_MAX: usize = 96 * 1024;
    assert_eq!(OUT_MAX, 98_304);
    // Search once for lengths giving exactly OUT_MAX / OUT_MAX+1.
    // 5 strings: output = 1 + sum(len+2) + 4 + 1 = sum(len) + 16.
    // Need sum(len) = 98288 for exact MAX, 98289 for MAX+1.
    let base = 19_657usize; // 5 * 19657 = 98285
    // 98285 + 16 = 98301 (3 short); add 3 to the last item.
    let lens_ok = [base, base, base, base, base + 3];
    assert_eq!(lens_ok.iter().sum::<usize>() + 16, OUT_MAX);
    let items: Vec<String> = lens_ok
        .iter()
        .map(|len| format!("\"{}\"", "a".repeat(*len)))
        .collect();
    let at_max = format!("[{}]", items.join(","));
    let out = json_code(at_max.as_bytes());
    assert!(out.is_ok(), "exactly 98304 output bytes must admit");
    assert_eq!(out.map(|v| v.len()), Ok(OUT_MAX));

    let lens_over = [base, base, base, base, base + 4];
    let items_over: Vec<String> = lens_over
        .iter()
        .map(|len| format!("\"{}\"", "a".repeat(*len)))
        .collect();
    let over = format!("[{}]", items_over.join(","));
    assert_eq!(
        json_code(over.as_bytes()),
        Err(eliotr_canonical::JSON_OUTPUT_TOO_LARGE_CODE)
    );
    assert_eq!(
        canonicalize_json(over.as_bytes()),
        Err(CanonicalJsonError::OutputTooLarge { max_bytes: 98_304 })
    );
}

// ---------------------------------------------------------------------------
// D. Snapshot writer comma (kills emit:196 `i>0` -> `<`).
// ---------------------------------------------------------------------------

const SNAPSHOT_STEM: &str = concat!(
    "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
    "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
    "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"pa1\",",
    "\"disclosure_closure_digest\":",
    "\"0000000000000000000000000000000000000000000000000000000000000000\",",
    "\"purge_ledger_revision\":0,\"created_at\":\"2026-01-01T00:00:00.000Z\",",
    "\"expires_at\":\"2026-01-01T00:15:00.000Z\"}",
);

#[test]
fn snapshot_two_member_refs_emit_exact_comma() {
    let two = SNAPSHOT_STEM.replace("[\"sr1\"]", "[\"sr1\",\"sr2\"]");
    let derived = derive_snapshot_identity(two.as_bytes());
    assert!(derived.is_ok());
    if let Ok(bytes) = derived {
        let text = core::str::from_utf8(&bytes).unwrap_or("");
        // The `<` mutant drops every comma, so the exact pair pins it.
        assert!(
            text.contains("\"member_source_revision_refs\":[\"sr1\",\"sr2\"]"),
            "two refs must be comma-joined: {text}"
        );
    }
    let three = SNAPSHOT_STEM.replace("[\"sr1\"]", "[\"a\",\"b\",\"c\"]");
    let derived3 = derive_snapshot_identity(three.as_bytes());
    assert!(derived3.is_ok());
    if let Ok(bytes) = derived3 {
        let text = core::str::from_utf8(&bytes).unwrap_or("");
        assert!(text.contains("[\"a\",\"b\",\"c\"]"), "three refs: {text}");
    }
}

// ---------------------------------------------------------------------------
// E. Snapshot control escapes incl. hex splitting (kills emit:234,239,240).
// ---------------------------------------------------------------------------

fn snapshot_with_policy(policy_escape: &str) -> Vec<u8> {
    const STEM: &str = concat!(
        "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
        "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
        "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"",
    );
    const TAIL: &str = concat!(
        "\",\"disclosure_closure_digest\":",
        "\"0000000000000000000000000000000000000000000000000000000000000000\",",
        "\"purge_ledger_revision\":0,\"created_at\":\"2026-01-01T00:00:00.000Z\",",
        "\"expires_at\":\"2026-01-01T00:15:00.000Z\"}",
    );
    format!("{STEM}{policy_escape}{TAIL}").into_bytes()
}

#[test]
fn snapshot_emit_control_escapes_are_exact_lowercase() {
    // 0x01 -> `\u0001` (both nibbles < 10 pin `b'0'+nibble`).
    let one = snapshot_with_policy("pa\\u00011");
    let derived = derive_snapshot_identity(&one);
    assert!(derived.is_ok());
    if let Ok(bytes) = derived {
        let text = core::str::from_utf8(&bytes).unwrap_or("");
        assert!(
            text.contains("\"policy_authority_ref\":\"pa\\u00011\""),
            "control 0x01 must re-escape lowercase: {text}"
        );
        assert!(!text.contains('\u{1}'), "raw 0x01 must not leak");
    }
    // 0x1F -> `\u001f`: high nibble 1 pins `>>4`, low nibble 15 pins
    // `& 0x0f` and `b'a'+(nibble-10)`. `>>`->`<<` gives 240, `&`->`|`
    // gives 31, both miss `f`.
    for (escape, expected) in [
        ("pa\\u001f1", "pa\\u001f1"),
        ("pa\\u001b1", "pa\\u001b1"),
        // 0x0A has the minimal `\n` arm (not the generic `\u00xx` arm).
        ("pa\\u000a1", "pa\\n1"),
    ] {
        let derived = derive_snapshot_identity(&snapshot_with_policy(escape));
        assert!(derived.is_ok(), "escape {escape}");
        if let Ok(bytes) = derived {
            let text = core::str::from_utf8(&bytes).unwrap_or("");
            assert!(
                text.contains(&format!("\"policy_authority_ref\":\"{expected}\"")),
                "escape {escape}: {text}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// F. Exact owner token + snapshot id pin `lower_hex -10` (kills owner:371,
// emit:147 ` -10` -> `/10`). Digests contain a-f (see hardcoded vectors).
// ---------------------------------------------------------------------------

#[test]
fn owner_token_exact_vector_pins_lower_hex_letters() {
    // Independent Python sha256 vector:
    // sha256(b'["eliotr.source-owner.initial.v1","local-imports","eliotr","installation-1",1,"ACTIVE"]')
    // = 54338a13cb0368c09e1f9023dc0e93e091a6d8f7002fbec253ed8c6e3ca3a6c2
    let expected = "owner-54338a13cb0368c09e1f9023dc0e93e091a6d8f7002fbec253ed8c6e3ca3a6c2";
    let token = derive_owner_token(b"local-imports", b"installation-1");
    assert_eq!(token.as_deref(), Ok(expected));
    // The second hex char `4` pins the digit arm, `a`/`b`/`c` pin `-10`.
    assert!(expected.contains('a') && expected.contains('b') && expected.contains('c'));
    // `/10` mutant maps 10->`b`, 15->`b` (10/10=1->`b`, 15/10=1->`b`), so `a` vanishes.
    assert!(expected.contains('a'), "letter-hex must be present");
}

#[test]
fn snapshot_id_and_digest_are_lowercase_hex_with_letters() {
    let derived = derive_snapshot_identity(SNAPSHOT_STEM.as_bytes());
    assert!(derived.is_ok());
    if let Ok(bytes) = derived {
        let text = core::str::from_utf8(&bytes).unwrap_or("").to_owned();
        let id_key = "\"snapshot_id\":\"scope-";
        let digest_key = "\"digest\":\"";
        let id_start = text.find(id_key).unwrap_or(0) + id_key.len();
        let id_hex = text.get(id_start..id_start + 48).unwrap_or("");
        // Independent vector (current code): pins both `lower_hex` copies
        // (emit:147). `/10` maps 10..=15 to `b`, corrupting these letters.
        assert_eq!(id_hex, "202f190e71f9cd36e2a94fc5f6a4a47e0ab0019b007e60b9");
        let digest_start = text.find(digest_key).unwrap_or(0) + digest_key.len();
        let digest_hex = text.get(digest_start..digest_start + 64).unwrap_or("");
        assert_eq!(
            digest_hex,
            "42296776bd6fae32f5f77f80870e6f5f15e308d941865ca93259745b231ce163"
        );
        // Verify round-trips (binds the digest, not just its shape).
        assert!(eliotr_canonical::verify_snapshot_identity(&bytes).is_ok());
    }
}

// ---------------------------------------------------------------------------
// G. Owner-tuple backslash + raw-control arms (kills tuple:199,162).
// ---------------------------------------------------------------------------

#[test]
fn owner_tuple_backslash_escape_binds_identifier_error() {
    // `\\` decodes to `\`, which the ID grammar rejects (Incarnation).
    // Deleting the `b'\\'` arm turns it into Syntax instead.
    let backslash = owner_preimage("local-imports", "a\\\\b");
    assert_eq!(
        owner_code(&backslash),
        Err(eliotr_canonical::OWNER_TOKEN_INCARNATION_CODE)
    );
    let slash = owner_preimage("local-imports", "a\\/b");
    // `\/` decodes to `/`, which IS allowed in IDs, so it binds ok.
    assert!(owner_code(&slash).is_ok());
    assert_eq!(
        owner_code(&slash),
        derive_owner_token_from_preimage(owner_preimage("local-imports", "a/b").as_slice())
            .map_err(|error| error.code())
    );
}

#[test]
fn owner_tuple_raw_control_is_syntax_not_unicode() {
    // Raw 0x1F inside the incarnation: correct arm reports Syntax;
    // deleting the `0x00..=0x1f` arm falls through to `utf8_width` (None)
    // and reports Unicode instead. Build `"i\x1F"` explicitly.
    let mut raw_1f = b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i".to_vec();
    raw_1f.push(0x1f);
    raw_1f.extend_from_slice(b"\",1,\"ACTIVE\"]");
    assert_eq!(
        owner_code(&raw_1f),
        Err(eliotr_canonical::OWNER_TOKEN_SYNTAX_CODE)
    );
    let mut raw_00 = b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i".to_vec();
    raw_00.push(0x00);
    raw_00.extend_from_slice(b"\",1,\"ACTIVE\"]");
    assert_eq!(
        owner_code(&raw_00),
        Err(eliotr_canonical::OWNER_TOKEN_SYNTAX_CODE)
    );
}

// ---------------------------------------------------------------------------
// H. Owner-tuple revision edges (kills tuple:124 x2,129,132).
// ---------------------------------------------------------------------------

#[test]
fn owner_tuple_negative_zero_is_syntax_not_revision() {
    // `-0` is a Number rejection (negative zero); `==`->`!=` would admit 0
    // and surface Revision instead.
    let neg_zero =
        b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",-0,\"ACTIVE\"]".to_vec();
    assert_eq!(
        owner_code(&neg_zero),
        Err(eliotr_canonical::OWNER_TOKEN_SYNTAX_CODE)
    );
}

#[test]
fn owner_tuple_negative_one_is_revision_and_unary_minus_pins() {
    // `-1` parses to -1 (Revision); deleting `-` (`-magnitude` -> `magnitude`)
    // binds 1 and admits, so the token would verify.
    let neg_one =
        b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",-1,\"ACTIVE\"]".to_vec();
    assert_eq!(
        owner_code(&neg_one),
        Err(eliotr_canonical::OWNER_TOKEN_REVISION_CODE)
    );
    // Sanity: 1 admits.
    let one = b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",1,\"ACTIVE\"]".to_vec();
    assert!(owner_code(&one).is_ok());
}

#[test]
fn owner_tuple_i64_max_parses_then_revision() {
    // 9223372036854775807 = i64::MAX: magnitude guard `>` admits exactly,
    // `>=` and `/`->`%` reject with Syntax. Post-parse it is Revision (!=1).
    let max =
        b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",9223372036854775807,\"ACTIVE\"]"
            .to_vec();
    assert_eq!(
        owner_code(&max),
        Err(eliotr_canonical::OWNER_TOKEN_REVISION_CODE)
    );
    let over =
        b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",9223372036854775808,\"ACTIVE\"]"
            .to_vec();
    assert_eq!(
        owner_code(&over),
        Err(eliotr_canonical::OWNER_TOKEN_SYNTAX_CODE)
    );
}

#[test]
fn owner_tuple_single_element_is_shape_not_syntax() {
    // After the first field the parser expects `,`; `]` is Shape.
    // `==`->`!=` flips Shape/Syntax here.
    let single = b"[\"eliotr.source-owner.initial.v1\"]".to_vec();
    assert_eq!(
        owner_code(&single),
        Err(eliotr_canonical::OWNER_TOKEN_SHAPE_CODE)
    );
    let garbage = b"[\"eliotr.source-owner.initial.v1\" X]".to_vec();
    assert_eq!(
        owner_code(&garbage),
        Err(eliotr_canonical::OWNER_TOKEN_SYNTAX_CODE)
    );
}

// ---------------------------------------------------------------------------
// I. Owner-tuple 3-byte / 4-byte widths + upper-hex deletion
// (kills tuple:308,309,322-del; 321/322 arithmetic is pinned via `j`/`J`).
// ---------------------------------------------------------------------------

#[test]
fn owner_tuple_three_and_four_byte_widths_hit_namespace_not_unicode() {
    // 3-byte `\u20ac` (euro) and 4-byte surrogate pair decode to non-ASCII,
    // which the ASCII ID grammar rejects (Namespace). Deleting either width
    // arm (or the `A-F` nibble arm for the pair) reports Unicode instead.
    for (namespace, label) in [
        ("caf\u{20ac}", "3-byte euro"),
        ("a\u{1f600}b", "4-byte emoji raw"),
    ] {
        let input = owner_preimage(namespace, "installation-1");
        assert_eq!(
            owner_code(&input),
            Err(eliotr_canonical::OWNER_TOKEN_NAMESPACE_CODE),
            "{label}"
        );
    }
    // Escaped 3-byte euro via `\u20ac` in the namespace.
    let escaped_euro = owner_preimage("a\\u20acb", "installation-1");
    assert_eq!(
        owner_code(&escaped_euro),
        Err(eliotr_canonical::OWNER_TOKEN_NAMESPACE_CODE)
    );
    // Escaped surrogate pair `\uD83D\uDE00` (emoji) in the namespace.
    let escaped_pair = owner_preimage("a\\ud83d\\ude00b", "installation-1");
    assert_eq!(
        owner_code(&escaped_pair),
        Err(eliotr_canonical::OWNER_TOKEN_NAMESPACE_CODE)
    );
}

#[test]
fn owner_tuple_hex_nibble_upper_lower_digit_are_exact() {
    // `j` (0x6a) pins lower ` - b'a' + 10`; `J` (0x4a) pins upper
    // ` - b'A' + 10`; deleting `A-F` breaks `J`.
    let lower_j = owner_preimage("local-imports", "installation-\\u006a");
    let plain_j = owner_preimage("local-imports", "installation-j");
    assert!(owner_code(&lower_j).is_ok());
    assert_eq!(owner_code(&lower_j), owner_code(&plain_j));

    let upper_j = owner_preimage("local-imports", "installation-\\u004A");
    let plain_upper = owner_preimage("local-imports", "installation-J");
    assert!(owner_code(&upper_j).is_ok());
    assert_eq!(owner_code(&upper_j), owner_code(&plain_upper));

    // `o`/`O` pin the second letter of each arm.
    let lower_o = owner_preimage("local-imports", "installation-\\u006f");
    assert_eq!(
        owner_code(&lower_o),
        owner_code(&owner_preimage("local-imports", "installation-o"))
    );
    let upper_o = owner_preimage("local-imports", "installation-\\u004F");
    assert_eq!(
        owner_code(&upper_o),
        owner_code(&owner_preimage("local-imports", "installation-O"))
    );
    // Digit arm.
    let digit = owner_preimage("local-imports", "installation-\\u0031");
    assert_eq!(
        owner_code(&digit),
        owner_code(&owner_preimage("local-imports", "installation-1"))
    );
}

// ---------------------------------------------------------------------------
// J. Snapshot frame surrogate pairs incl. arithmetic (kills frame:318,321,
// 323,326 x8 via exact UTF-8 bytes; tuple:227 shares the formula but its IDs
// reject astral, so the observable pin lives here where unicode is admitted).
// ---------------------------------------------------------------------------

#[test]
fn snapshot_surrogate_pair_decodes_to_exact_astral_bytes() {
    // `\uD83D\uDE00` -> U+1F600 -> F0 9F 98 80. Small `\u0041` is blind to
    // shifts (`<<`->`>>` keeps small values plausible); CJK + astral are not.
    let pair = snapshot_with_policy("pa\\ud83d\\ude001");
    let derived = derive_snapshot_identity(&pair);
    assert!(derived.is_ok(), "valid pair must admit");
    if let Ok(bytes) = derived {
        let text = core::str::from_utf8(&bytes).unwrap_or("");
        assert!(
            text.contains("pa\u{1f600}1"),
            "astral bytes must be exact F0 9F 98 80: {text}"
        );
    }
    // CJK `\u4E2D` -> E4 B8 AD pins multi-nibble `<<4 |` accumulation.
    let cjk = snapshot_with_policy("pa\\u4e2d1");
    let derived_cjk = derive_snapshot_identity(&cjk);
    assert!(derived_cjk.is_ok());
    if let Ok(bytes) = derived_cjk {
        let text = core::str::from_utf8(&bytes).unwrap_or("");
        assert!(text.contains("pa\u{4e2d}1"), "CJK must be exact: {text}");
    }
    // `\u00e9` (e-acute, C3 A9) pins the low-nibble path with a letter.
    let acute = snapshot_with_policy("pa\\u00e91");
    let derived_acute = derive_snapshot_identity(&acute);
    assert!(derived_acute.is_ok());
    if let Ok(bytes) = derived_acute {
        let text = core::str::from_utf8(&bytes).unwrap_or("");
        assert!(text.contains("pa\u{e9}1"), "e-acute must be exact: {text}");
    }
}

#[test]
fn snapshot_surrogate_guards_reject_exact_codes() {
    // High surrogate without a `\u` low half: `!=` pins the `\\u` lookahead.
    // `!=`->`==` admits the valid pair as Unicode instead of ok.
    let lone_high = snapshot_with_policy("pa\\ud83d1");
    assert_eq!(
        derive_snapshot_identity(&lone_high).map_err(|error| error.code()),
        Err(eliotr_canonical::SNAPSHOT_UNICODE_CODE)
    );
    // High + non-low second (`\u0041` = `A`): `!contains(low)` pins `!`.
    // Deleting `!` admits it.
    let bad_second = snapshot_with_policy("pa\\ud83d\\u00411");
    assert_eq!(
        derive_snapshot_identity(&bad_second).map_err(|error| error.code()),
        Err(eliotr_canonical::SNAPSHOT_UNICODE_CODE)
    );
    // Lone low surrogate.
    let lone_low = snapshot_with_policy("pa\\udc001");
    assert_eq!(
        derive_snapshot_identity(&lone_low).map_err(|error| error.code()),
        Err(eliotr_canonical::SNAPSHOT_UNICODE_CODE)
    );
}

// ---------------------------------------------------------------------------
// K. Expression exact ceilings (kills expression:28,29,46,111;
// 27/43 depth-final/tracking are dead: walk fails first — see report).
// ---------------------------------------------------------------------------

fn material_with_expression(expression: &str) -> Vec<u8> {
    const DIGEST0: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    format!(
        "{{\"revision\":1,\"resolved_scope_expression\":{expression},\
        \"participant_generations\":{{\"p1\":\"g1\"}},\
        \"member_source_revision_refs\":[\"sr1\"],\
        \"source_owner_generations\":{{\"sr1\":\"og1\"}},\
        \"policy_authority_ref\":\"pa1\",\
        \"disclosure_closure_digest\":\"{DIGEST0}\",\
        \"purge_ledger_revision\":0,\
        \"created_at\":\"2026-01-01T00:00:00.000Z\",\
        \"expires_at\":\"2026-01-01T00:15:00.000Z\"}}"
    )
    .into_bytes()
}

fn balanced_union(leaves: usize) -> String {
    let mut level: Vec<String> = (0..leaves)
        .map(|index| format!("{{\"kind\":\"TAG\",\"tag\":\"t{index}\"}}"))
        .collect();
    while level.len() > 1 {
        let mut next = Vec::new();
        let mut items = level.into_iter();
        while let Some(left) = items.next() {
            if let Some(right) = items.next() {
                next.push(format!(
                    "{{\"kind\":\"UNION\",\"left\":{left},\"right\":{right}}}"
                ));
            } else {
                next.push(left);
            }
        }
        level = next;
    }
    level.into_iter().next().unwrap_or_default()
}

#[test]
fn expression_atoms_256_ok_257_member_limit() {
    // Hardcoded ceiling: 256 atoms. `>` admits 256, `>=` rejects it.
    let at_max = balanced_union(256);
    assert!(
        snapshot_code(&material_with_expression(&at_max)).is_ok(),
        "256 atoms must admit"
    );
    let over = balanced_union(257);
    assert_eq!(
        snapshot_code(&material_with_expression(&over)),
        Err(eliotr_canonical::SNAPSHOT_MEMBER_LIMIT_CODE)
    );
}

#[test]
fn expression_selected_1000_ok_1001_member_limit() {
    let ids_max = (0..1000)
        .map(|index| format!("\"s{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let at_max = format!("{{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[{ids_max}]}}");
    assert!(
        snapshot_code(&material_with_expression(&at_max)).is_ok(),
        "1000 selected must admit"
    );
    let ids_over = (0..1001)
        .map(|index| format!("\"s{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let over = format!("{{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[{ids_over}]}}");
    assert_eq!(
        snapshot_code(&material_with_expression(&over)),
        Err(eliotr_canonical::SNAPSHOT_MEMBER_LIMIT_CODE)
    );
}

#[test]
fn expression_depth_32_ok_33_expression() {
    // Hardcoded ceiling: 32. Walk guard `depth > 32` admits 32, rejects 33;
    // `>=` rejects 32, `==` rejects 32 yet admits 33, `depth+1`->`*1` never
    // deepens and admits 33. Chain: depth = nests + 1.
    let mut at_max = "{\"kind\":\"GLOBAL_LIBRARY\"}".to_owned();
    for _ in 0..31 {
        at_max = format!(
            "{{\"kind\":\"UNION\",\"left\":{at_max},\"right\":{{\"kind\":\"GLOBAL_LIBRARY\"}}}}"
        );
    }
    assert!(
        snapshot_code(&material_with_expression(&at_max)).is_ok(),
        "depth 32 must admit"
    );
    let mut over = "{\"kind\":\"GLOBAL_LIBRARY\"}".to_owned();
    for _ in 0..32 {
        over = format!(
            "{{\"kind\":\"UNION\",\"left\":{over},\"right\":{{\"kind\":\"GLOBAL_LIBRARY\"}}}}"
        );
    }
    assert_eq!(
        snapshot_code(&material_with_expression(&over)),
        Err(eliotr_canonical::SNAPSHOT_EXPRESSION_CODE)
    );
}

// ---------------------------------------------------------------------------
// L. Material exact ceilings (kills material:125,137 x2).
// ---------------------------------------------------------------------------

fn base_material() -> String {
    core::str::from_utf8(&material_with_expression("{\"kind\":\"GLOBAL_LIBRARY\"}"))
        .unwrap_or("")
        .to_owned()
}

#[test]
fn material_participants_257_ok_258_member_limit() {
    // Hardcoded ceiling: 257 participant generations.
    let ok_members = (0..257)
        .map(|index| format!("\"p{index}\":\"g{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let at_max = base_material().replace("{\"p1\":\"g1\"}", &format!("{{{ok_members}}}"));
    assert!(
        snapshot_code(at_max.as_bytes()).is_ok(),
        "257 participants must admit"
    );
    let over_members = (0..258)
        .map(|index| format!("\"p{index}\":\"g{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let over = base_material().replace("{\"p1\":\"g1\"}", &format!("{{{over_members}}}"));
    assert_eq!(
        snapshot_code(over.as_bytes()),
        Err(eliotr_canonical::SNAPSHOT_MEMBER_LIMIT_CODE)
    );
}

#[test]
fn material_identifier_256_ok_257_identifier() {
    // Hardcoded ceiling: 256 UTF-16 units. `>` admits 256, `>=`/`==` reject.
    let ok_id = "a".repeat(256);
    let at_max = base_material().replace("\"pa1\"", &format!("\"{ok_id}\""));
    assert!(
        snapshot_code(at_max.as_bytes()).is_ok(),
        "256-unit identifier must admit"
    );
    let over_id = "a".repeat(257);
    let over = base_material().replace("\"pa1\"", &format!("\"{over_id}\""));
    assert_eq!(
        snapshot_code(over.as_bytes()),
        Err(eliotr_canonical::SNAPSHOT_IDENTIFIER_CODE)
    );
    assert_eq!(
        base_material().replace("\"pa1\"", "\"\""),
        base_material().replace("\"pa1\"", "\"\"")
    );
    let empty = base_material().replace("\"pa1\"", "\"\"");
    assert_eq!(
        snapshot_code(empty.as_bytes()),
        Err(eliotr_canonical::SNAPSHOT_IDENTIFIER_CODE)
    );
}

// ---------------------------------------------------------------------------
// M. Timestamp single-side dashes + year-letter digits (kills timestamp:41,120).
// ---------------------------------------------------------------------------

const TS_STEM: &str = concat!(
    "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
    "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
    "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"pa1\",",
    "\"disclosure_closure_digest\":",
    "\"0000000000000000000000000000000000000000000000000000000000000000\",",
    "\"purge_ledger_revision\":0,\"created_at\":\"",
);
const TS_MID: &str = "\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}";

fn with_created(created_at: &str) -> Vec<u8> {
    format!("{TS_STEM}{created_at}{TS_MID}").into_bytes()
}

#[test]
fn timestamp_exactly_one_dash_wrong_is_timestamp() {
    // `||` admits only when both dashes are right; `&&` admits when either
    // is right. Each input below has exactly one side true.
    for bad in [
        "2026/01-01T00:00:00Z",
        "2026-01/01T00:00:00Z",
        "2026/01-01T00:00:00+05:30",
        "2026-01/01T00:00:00-02:00",
    ] {
        assert_eq!(
            derive_snapshot_identity(&with_created(bad)).map_err(|error| error.code()),
            Err(eliotr_canonical::SNAPSHOT_TIMESTAMP_CODE),
            "single-side dash {bad}"
        );
    }
    assert!(derive_snapshot_identity(&with_created("2026-01-01T00:00:00Z")).is_ok());
}

#[test]
fn timestamp_year_letter_is_timestamp_not_garbage_year() {
    // `digits` guard is `empty || !all-digit`; `&&` computes garbage
    // (`202a` -> 2069) and would admit. The letter must fail closed.
    for bad in [
        "202a-01-01T00:00:00Z",
        "2026-0a-01T00:00:00Z",
        "2026-01-0aT00:00:00Z",
        "2026-01-01T0a:00:00Z",
        "2026-01-01T00:00:00+0a:00",
    ] {
        assert_eq!(
            derive_snapshot_identity(&with_created(bad)).map_err(|error| error.code()),
            Err(eliotr_canonical::SNAPSHOT_TIMESTAMP_CODE),
            "letter {bad}"
        );
    }
}

// ---------------------------------------------------------------------------
// N. Stable-ID frame input, part-count value, alphabet offset, length values
// (kills stable:226 x2,241 x2,280 x4).
// ---------------------------------------------------------------------------

#[test]
fn stable_frame_input_65536_ok_65537_too_large() {
    // Hardcoded ceiling: 64 * 1024 = 65536. `>` admits exactly MAX,
    // `>=`/`==` reject it.
    let mut parts: Vec<Vec<u8>> = (0..15).map(|_| vec![b'q'; 4096]).collect();
    parts.push(vec![b'q'; 4016]);
    let prefix = vec![b'z'; 64];
    let total = prefix.len() + parts.iter().map(|part| 1 + part.len()).sum::<usize>();
    assert_eq!(total, 65_536);
    let mut at_max = prefix.clone();
    for part in &parts {
        at_max.push(0);
        at_max.extend_from_slice(part);
    }
    assert_eq!(at_max.len(), 65_536);
    assert!(
        derive_stable_id_frame(&at_max).is_ok(),
        "exactly 65536 frame bytes must admit"
    );
    let mut over = at_max.clone();
    // Append one more payload byte to the last part (still valid prefix).
    over.push(b'q');
    assert_eq!(over.len(), 65_537);
    assert_eq!(
        derive_stable_id_frame(&over).map_err(StableIdError::code),
        Err(eliotr_canonical::STABLE_ID_INPUT_TOO_LARGE_CODE)
    );
    assert_eq!(
        derive_stable_id_frame(&over),
        Err(StableIdError::InputTooLarge {
            actual_bytes: 65_537,
            max_bytes: 65_536
        })
    );
}

#[test]
fn stable_frame_too_many_parts_reports_exact_count() {
    // 32 parts admit, 33 fail with actual_parts = 33. `+1`->`-1` gives 31,
    // `+1`->`*1` gives 32.
    let parts_32 = vec![b"x" as &[u8]; 32];
    assert!(derive_stable_id(b"p", &parts_32).is_ok());
    let mut frame_33 = b"p".to_vec();
    for _ in 0..33 {
        frame_33.push(0);
        frame_33.push(b'x');
    }
    assert_eq!(
        derive_stable_id_frame(&frame_33),
        Err(StableIdError::TooManyParts {
            actual_parts: 33,
            max_parts: 32
        })
    );
    assert_eq!(
        derive_stable_id(b"p", &vec![b"x" as &[u8]; 33]).map_err(StableIdError::code),
        Err(eliotr_canonical::STABLE_ID_TOO_MANY_PARTS_CODE)
    );
}

#[test]
fn stable_validate_alphabet_offset_is_exact_past_start() {
    // `owner-` analogue: first digest byte (offset 2 for `a-...`) is blind to
    // the second `+` when index==0 for owner, but stable separator+1 keeps
    // both `+` load-bearing past the start. Use digest index 5.
    let mut id = format!("a-{}", "0".repeat(48)).into_bytes();
    // Digest starts at 2; corrupt index 5 -> offset 7.
    id[2 + 5] = b'G';
    assert_eq!(
        validate_stable_id(&id),
        Err(StableIdError::InvalidAlphabet { offset: 7 })
    );
    assert_eq!(
        validate_stable_id(&id).map_err(StableIdError::code),
        Err(eliotr_canonical::STABLE_ID_ALPHABET_CODE)
    );
    // Corrupt the last digest byte -> offset 49.
    let mut last = format!("a-{}", "0".repeat(48)).into_bytes();
    let last_pos = last.len() - 1;
    last[last_pos] = b'g';
    assert_eq!(
        validate_stable_id(&last),
        Err(StableIdError::InvalidAlphabet { offset: last_pos })
    );
}

#[test]
fn stable_validate_length_values_are_exact() {
    // MIN = 50 (`a-` + 48), MAX = 113 (64 + 1 + 48). Values (not just codes)
    // pin the `1+1+48` const mutants: 49 would pass a MIN=49/48 mutant at the
    // first gate yet still fail as Length at the digest gate with the same
    // code, so the struct values discriminate.
    assert_eq!(STABLE_ID_MIN_BYTES, 50);
    assert_eq!(STABLE_ID_MAX_BYTES, 113);
    let short = format!("a-{}", "0".repeat(47));
    assert_eq!(short.len(), 49);
    assert_eq!(
        validate_stable_id(short.as_bytes()),
        Err(StableIdError::InvalidLength {
            actual_bytes: 49,
            min_bytes: 50,
            max_bytes: 113
        })
    );
    let longest = format!("{}-{}", "b".repeat(64), "f".repeat(48));
    assert_eq!(longest.len(), 113);
    assert!(validate_stable_id(longest.as_bytes()).is_ok());
    let too_long = format!("{}-{}", "b".repeat(64), "f".repeat(49));
    assert_eq!(
        validate_stable_id(too_long.as_bytes()).map_err(StableIdError::code),
        Err(eliotr_canonical::STABLE_ID_LENGTH_CODE)
    );
}

// ---------------------------------------------------------------------------
// O. Owner-token alphabet offset past the start (kills owner:297 `+`->`-`).
// Index 0 is blind (6+0 == 6-0); index 5 is not.
// ---------------------------------------------------------------------------

#[test]
fn owner_validate_alphabet_offset_past_start_is_exact() {
    let token = derive_owner_token(b"local-imports", b"installation-1");
    assert!(token.is_ok());
    let Ok(token) = token else { return };
    let mut mid = token.as_bytes().to_vec();
    // Digest index 5 -> offset 6 + 5 = 11. `-` mutant gives 6 - 5 = 1.
    mid[6 + 5] = b'G';
    assert_eq!(
        validate_owner_token(&mid),
        Err(OwnerTokenError::InvalidAlphabet { offset: 11 })
    );
    let mut last = token.as_bytes().to_vec();
    let last_pos = last.len() - 1;
    last[last_pos] = b'G';
    assert_eq!(
        validate_owner_token(&last),
        Err(OwnerTokenError::InvalidAlphabet { offset: last_pos })
    );
}

// ---------------------------------------------------------------------------
// P. Snapshot input ceiling hardcoded (kills scope:49 `*`->`+`).
// ---------------------------------------------------------------------------

#[test]
fn snapshot_input_hardcoded_2097152_ok() {
    // Correct MAX is 2097152; `2*1024*1024` -> `2+1024*1024`=1048578 or
    // `2*1024+1024`=3072 would reject a 2097152-byte input.
    let mut at_max = SNAPSHOT_STEM.as_bytes().to_vec();
    at_max.extend(core::iter::repeat_n(b' ', 2_097_152 - at_max.len()));
    assert_eq!(at_max.len(), 2_097_152);
    assert!(snapshot_code(&at_max).is_ok());
}
