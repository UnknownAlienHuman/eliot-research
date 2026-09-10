//! ER-40 S6 native kill-matrix: explicit resource limits at max / max+1 (S5).
//!
//! Every `>` boundary is pinned from both sides with programmatically
//! generated inputs (no fixtures): exactly-at-budget succeeds (kills `>=`),
//! one-over fails with the exact code (kills `==`). Depth, member, item and
//! node budgets each get one quick boundary test.

use eliotr_canonical::{
    JSON_DEPTH_LIMIT_CODE, JSON_INPUT_TOO_LARGE_CODE, JSON_ITEM_LIMIT_CODE, JSON_MEMBER_LIMIT_CODE,
    JSON_NODE_LIMIT_CODE, JSON_NUMBER_CODE, JSON_OUTPUT_TOO_LARGE_CODE, JSON_STRING_TOO_LARGE_CODE,
    MAX_CANONICAL_JSON_ARRAY_ITEMS, MAX_CANONICAL_JSON_DEPTH, MAX_CANONICAL_JSON_INPUT_BYTES,
    MAX_CANONICAL_JSON_NODES, MAX_CANONICAL_JSON_OBJECT_MEMBERS, MAX_CANONICAL_JSON_OUTPUT_BYTES,
    MAX_CANONICAL_JSON_STRING_BYTES, OWNER_TOKEN_INPUT_TOO_LARGE_CODE,
    OWNER_TOKEN_PREIMAGE_MAX_BYTES, OWNER_TOKEN_SYNTAX_CODE, SNAPSHOT_DEPTH_LIMIT_CODE,
    SNAPSHOT_INPUT_MAX_BYTES, SNAPSHOT_INPUT_TOO_LARGE_CODE, SNAPSHOT_MEMBER_LIMIT_CODE,
    SNAPSHOT_NUMBER_CODE, SNAPSHOT_OBJECT_MEMBERS_MAX, SNAPSHOT_PARTICIPANTS_MAX,
    SNAPSHOT_STRING_MAX_BYTES, SNAPSHOT_STRING_TOO_LARGE_CODE, SNAPSHOT_UNKNOWN_FIELD_CODE,
    STABLE_ID_INPUT_MAX_BYTES, STABLE_ID_INPUT_TOO_LARGE_CODE, STABLE_ID_MAX_PARTS,
    STABLE_ID_PART_MAX_BYTES, STABLE_ID_PART_TOO_LARGE_CODE, STABLE_ID_PREFIX_MAX_BYTES,
    STABLE_ID_PREFIX_TOO_LARGE_CODE, STABLE_ID_TOO_MANY_PARTS_CODE, SnapshotIdentityError,
    canonicalize_json, derive_snapshot_identity, derive_stable_id,
};

fn json_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    canonicalize_json(input).map_err(|error| error.code())
}

#[test]
fn canonical_input_budget_max_ok_and_max_plus_one_rejected() {
    let mut at_max = b"null".to_vec();
    at_max.extend(core::iter::repeat_n(
        b' ',
        MAX_CANONICAL_JSON_INPUT_BYTES - 4,
    ));
    assert_eq!(at_max.len(), MAX_CANONICAL_JSON_INPUT_BYTES);
    assert_eq!(json_code(&at_max), Ok(b"null".to_vec()));

    let mut over = at_max.clone();
    over.push(b' ');
    assert_eq!(json_code(&over), Err(JSON_INPUT_TOO_LARGE_CODE));
}

#[test]
fn canonical_string_budget_max_ok_and_max_plus_one_rejected() {
    let at_max = format!("\"{}\"", "a".repeat(MAX_CANONICAL_JSON_STRING_BYTES));
    assert!(json_code(at_max.as_bytes()).is_ok());
    let over = format!("\"{}\"", "a".repeat(MAX_CANONICAL_JSON_STRING_BYTES + 1));
    assert_eq!(json_code(over.as_bytes()), Err(JSON_STRING_TOO_LARGE_CODE));
}

#[test]
fn canonical_output_budget_rejects_over_limit_and_admits_large_ok() {
    let item = format!("\"{}\"", "a".repeat(20 * 1024));
    let fits = format!("[{item},{item},{item},{item}]");
    assert!(fits.len() < MAX_CANONICAL_JSON_OUTPUT_BYTES);
    assert!(json_code(fits.as_bytes()).is_ok());

    let heavy = format!("[{item},{item},{item},{item},{item}]");
    assert!(heavy.len() > MAX_CANONICAL_JSON_OUTPUT_BYTES);
    assert!(heavy.len() < MAX_CANONICAL_JSON_INPUT_BYTES);
    assert_eq!(json_code(heavy.as_bytes()), Err(JSON_OUTPUT_TOO_LARGE_CODE));
}

#[test]
fn canonical_array_item_budget_boundary() {
    let at_max = format!("[{}]", vec!["0"; MAX_CANONICAL_JSON_ARRAY_ITEMS].join(","));
    assert!(json_code(at_max.as_bytes()).is_ok());
    let over = format!(
        "[{}]",
        vec!["0"; MAX_CANONICAL_JSON_ARRAY_ITEMS + 1].join(",")
    );
    assert_eq!(json_code(over.as_bytes()), Err(JSON_ITEM_LIMIT_CODE));
}

#[test]
fn canonical_object_member_budget_boundary() {
    let at_max = format!(
        "{{{}}}",
        (0..MAX_CANONICAL_JSON_OBJECT_MEMBERS)
            .map(|index| format!("\"k{index}\":0"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert!(json_code(at_max.as_bytes()).is_ok());
    let over = format!(
        "{{{}}}",
        (0..=MAX_CANONICAL_JSON_OBJECT_MEMBERS)
            .map(|index| format!("\"k{index}\":0"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_eq!(json_code(over.as_bytes()), Err(JSON_MEMBER_LIMIT_CODE));
}

#[test]
fn canonical_depth_budget_boundary() {
    let at_max = format!(
        "{}0{}",
        "[".repeat(MAX_CANONICAL_JSON_DEPTH),
        "]".repeat(MAX_CANONICAL_JSON_DEPTH)
    );
    assert!(json_code(at_max.as_bytes()).is_ok());
    let over = format!(
        "{}0{}",
        "[".repeat(MAX_CANONICAL_JSON_DEPTH + 1),
        "]".repeat(MAX_CANONICAL_JSON_DEPTH + 1)
    );
    assert_eq!(json_code(over.as_bytes()), Err(JSON_DEPTH_LIMIT_CODE));
}

#[test]
fn canonical_node_budget_boundary() {
    // 1 object + 128 arrays + 889 zeros = exactly MAX_CANONICAL_JSON_NODES.
    let mut members = Vec::new();
    for index in 0..MAX_CANONICAL_JSON_OBJECT_MEMBERS - 1 {
        members.push(format!("\"k{index}\":[0,0,0,0,0,0,0]"));
    }
    members.push("\"last\":[0,0,0,0,0,0]".to_owned());
    let at_max = format!("{{{}}}", members.join(","));
    assert_eq!(
        1 + MAX_CANONICAL_JSON_OBJECT_MEMBERS + 127 * 7 + 6,
        MAX_CANONICAL_JSON_NODES
    );
    assert!(json_code(at_max.as_bytes()).is_ok());

    members.pop();
    members.push("\"last\":[0,0,0,0,0,0,0]".to_owned());
    let over = format!("{{{}}}", members.join(","));
    assert_eq!(json_code(over.as_bytes()), Err(JSON_NODE_LIMIT_CODE));
}

#[test]
fn canonical_long_digit_integers_are_numbers_not_steps() {
    let digits = vec![b'9'; 100];
    assert_eq!(json_code(&digits), Err(JSON_NUMBER_CODE));
    assert_eq!(json_code(b"9007199254740992"), Err(JSON_NUMBER_CODE));
    assert_eq!(
        json_code(b"9007199254740991"),
        Ok(b"9007199254740991".to_vec())
    );
}

const SNAPSHOT_STEM: &str = concat!(
    "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
    "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
    "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"pa1\",",
    "\"disclosure_closure_digest\":",
    "\"0000000000000000000000000000000000000000000000000000000000000000\",",
    "\"purge_ledger_revision\":0,\"created_at\":\"2026-01-01T00:00:00.000Z\",",
    "\"expires_at\":\"2026-01-01T00:15:00.000Z\"}",
);

fn snapshot_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    derive_snapshot_identity(input).map_err(|error| error.code())
}

#[test]
fn snapshot_input_budget_max_ok_and_max_plus_one_rejected() {
    let mut at_max = SNAPSHOT_STEM.as_bytes().to_vec();
    at_max.extend(core::iter::repeat_n(
        b' ',
        SNAPSHOT_INPUT_MAX_BYTES - at_max.len(),
    ));
    assert_eq!(at_max.len(), SNAPSHOT_INPUT_MAX_BYTES);
    assert!(snapshot_code(&at_max).is_ok());

    let mut over = at_max.clone();
    over.push(b' ');
    assert_eq!(snapshot_code(&over), Err(SNAPSHOT_INPUT_TOO_LARGE_CODE));
}

#[test]
fn snapshot_string_budget_max_ok_and_max_plus_one_rejected() {
    // No material identifier reaches 4096 (UTF-16 ceiling is 256), so the
    // parser-level byte budget is probed with an unknown key: a fully parsed
    // 4096-byte value surfaces as UnknownField, 4097 as StringTooLarge.
    let at_max = format!("{{\"z\":\"{}\",\"revision\":1}}", "a".repeat(4096));
    assert_eq!(
        snapshot_code(at_max.as_bytes()),
        Err(SNAPSHOT_UNKNOWN_FIELD_CODE)
    );
    let over = format!("{{\"z\":\"{}\",\"revision\":1}}", "a".repeat(4097));
    assert_eq!(
        snapshot_code(over.as_bytes()),
        Err(SNAPSHOT_STRING_TOO_LARGE_CODE)
    );
    assert_eq!(SNAPSHOT_STRING_MAX_BYTES, 4096);
}

#[test]
fn snapshot_member_array_budget_boundary() {
    let refs = (0..50_000)
        .map(|index| format!("\"sr{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let at_max = SNAPSHOT_STEM.replace("[\"sr1\"]", &format!("[{refs}]"));
    assert!(snapshot_code(at_max.as_bytes()).is_ok());

    let refs_over = (0..=50_000)
        .map(|index| format!("\"sr{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let over = SNAPSHOT_STEM.replace("[\"sr1\"]", &format!("[{refs_over}]"));
    assert_eq!(
        snapshot_code(over.as_bytes()),
        Err(SNAPSHOT_MEMBER_LIMIT_CODE)
    );
}

#[test]
fn snapshot_object_member_parser_budget_reports_exact_limit() {
    let big_record = (0..SNAPSHOT_OBJECT_MEMBERS_MAX)
        .map(|index| format!("\"p{index}\":\"g{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let at_max = SNAPSHOT_STEM.replace("{\"p1\":\"g1\"}", &format!("{{{big_record}}}"));
    // Parses past the frame budget, then fails the participant ceiling.
    assert_eq!(
        derive_snapshot_identity(at_max.as_bytes()),
        Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_PARTICIPANTS_MAX
        })
    );

    let big_over = (0..=SNAPSHOT_OBJECT_MEMBERS_MAX)
        .map(|index| format!("\"p{index}\":\"g{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let over = SNAPSHOT_STEM.replace("{\"p1\":\"g1\"}", &format!("{{{big_over}}}"));
    assert_eq!(
        derive_snapshot_identity(over.as_bytes()),
        Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_OBJECT_MEMBERS_MAX
        })
    );
}

#[test]
fn snapshot_depth_budget_boundary_reports_depth_then_shape() {
    // 62 nested arrays parse, then the unknown key fails (parser passed).
    let ok_depth = format!("{{\"z\":{}0{}}}", "[".repeat(62), "]".repeat(62));
    assert_eq!(
        snapshot_code(ok_depth.as_bytes()),
        Err(SNAPSHOT_UNKNOWN_FIELD_CODE)
    );
    let over_depth = format!("{{\"z\":{}0{}}}", "[".repeat(64), "]".repeat(64));
    assert_eq!(
        snapshot_code(over_depth.as_bytes()),
        Err(SNAPSHOT_DEPTH_LIMIT_CODE)
    );
}

#[test]
fn snapshot_long_digit_revisions_are_numbers() {
    let big = SNAPSHOT_STEM.replace(
        "\"revision\":1",
        &format!("\"revision\":{}", "9".repeat(30)),
    );
    assert_eq!(snapshot_code(big.as_bytes()), Err(SNAPSHOT_NUMBER_CODE));
    let max_safe = SNAPSHOT_STEM.replace("\"revision\":1", "\"revision\":9007199254740991");
    assert!(snapshot_code(max_safe.as_bytes()).is_ok());
    let over_safe = SNAPSHOT_STEM.replace("\"revision\":1", "\"revision\":9007199254740992");
    assert_eq!(
        snapshot_code(over_safe.as_bytes()),
        Err(SNAPSHOT_NUMBER_CODE)
    );
}

#[test]
fn owner_preimage_budget_max_ok_and_max_plus_one_rejected() {
    let base = "[\"eliotr.source-owner.initial.v1\",\"local-imports\",\"eliotr\",\"installation-1\",1,\"ACTIVE\"]";
    let mut at_max = base.as_bytes().to_vec();
    at_max.extend(core::iter::repeat_n(
        b' ',
        OWNER_TOKEN_PREIMAGE_MAX_BYTES - at_max.len(),
    ));
    assert_eq!(at_max.len(), OWNER_TOKEN_PREIMAGE_MAX_BYTES);
    let result = derive_owner_token_from_preimage_alias(&at_max).map_err(owner_code_alias);
    assert!(result.is_ok(), "expected ok at exactly MAX");

    let mut over = at_max.clone();
    over.push(b' ');
    assert_eq!(
        derive_owner_token_from_preimage_alias(&over).map_err(owner_code_alias),
        Err(OWNER_TOKEN_INPUT_TOO_LARGE_CODE)
    );
}

fn derive_owner_token_from_preimage_alias(
    input: &[u8],
) -> Result<String, eliotr_canonical::OwnerTokenError> {
    eliotr_canonical::derive_owner_token_from_preimage(input)
}

fn owner_code_alias(error: eliotr_canonical::OwnerTokenError) -> &'static str {
    error.code()
}

#[test]
fn owner_tuple_long_digit_revision_is_syntax() {
    let big = format!(
        "[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",{},\"ACTIVE\"]",
        "9".repeat(25)
    );
    assert_eq!(
        derive_owner_token_from_preimage_alias(big.as_bytes()).map_err(owner_code_alias),
        Err(OWNER_TOKEN_SYNTAX_CODE)
    );
}

#[test]
fn stable_id_length_and_count_budgets_boundary() {
    // Prefix 64 ok / 65 rejected.
    let prefix_ok = vec![b'a'; STABLE_ID_PREFIX_MAX_BYTES];
    assert!(derive_stable_id(&prefix_ok, &[]).is_ok());
    let prefix_over = vec![b'a'; STABLE_ID_PREFIX_MAX_BYTES + 1];
    assert_eq!(
        derive_stable_id(&prefix_over, &[]).map_err(eliotr_canonical::StableIdError::code),
        Err(STABLE_ID_PREFIX_TOO_LARGE_CODE)
    );
    // 32 parts ok / 33 rejected.
    let parts_32 = vec![b"x" as &[u8]; STABLE_ID_MAX_PARTS];
    assert!(derive_stable_id(b"p", &parts_32).is_ok());
    let parts_33 = vec![b"x" as &[u8]; STABLE_ID_MAX_PARTS + 1];
    assert_eq!(
        derive_stable_id(b"p", &parts_33).map_err(eliotr_canonical::StableIdError::code),
        Err(STABLE_ID_TOO_MANY_PARTS_CODE)
    );
    // Part 4096 ok / 4097 rejected.
    let part_ok = vec![b'y'; STABLE_ID_PART_MAX_BYTES];
    assert!(derive_stable_id(b"p", &[part_ok.as_slice()]).is_ok());
    let part_over = vec![b'y'; STABLE_ID_PART_MAX_BYTES + 1];
    assert_eq!(
        derive_stable_id(b"p", &[part_over.as_slice()])
            .map_err(eliotr_canonical::StableIdError::code),
        Err(STABLE_ID_PART_TOO_LARGE_CODE)
    );
}

#[test]
fn stable_id_total_input_budget_max_ok_and_max_plus_one_rejected() {
    // 64 + 15*(1+4096) + (1+4016) = exactly STABLE_ID_INPUT_MAX_BYTES.
    let mut parts: Vec<Vec<u8>> = (0..15).map(|_| vec![b'q'; 4096]).collect();
    parts.push(vec![b'q'; 4016]);
    let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    let prefix = vec![b'z'; 64];
    let total = prefix.len() + refs.iter().map(|part| 1 + part.len()).sum::<usize>();
    assert_eq!(total, STABLE_ID_INPUT_MAX_BYTES);
    assert!(derive_stable_id(&prefix, &refs).is_ok());

    parts.pop();
    parts.push(vec![b'q'; 4017]);
    let refs_over: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    assert_eq!(
        derive_stable_id(&prefix, &refs_over).map_err(eliotr_canonical::StableIdError::code),
        Err(STABLE_ID_INPUT_TOO_LARGE_CODE)
    );
}

#[test]
fn stable_id_shortest_and_longest_identifiers_validate() {
    let shortest = format!("a-{}", "0".repeat(48));
    assert_eq!(shortest.len(), 50);
    assert!(eliotr_canonical::validate_stable_id(shortest.as_bytes()).is_ok());
    let longest = format!("{}-{}", "b".repeat(64), "f".repeat(48));
    assert_eq!(longest.len(), 113);
    assert!(eliotr_canonical::validate_stable_id(longest.as_bytes()).is_ok());
}
