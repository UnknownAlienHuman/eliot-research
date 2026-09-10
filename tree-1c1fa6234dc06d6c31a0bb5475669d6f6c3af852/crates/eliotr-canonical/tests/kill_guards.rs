//! ER-40 S6 native kill-matrix: S5 bounded-iteration loops and node budgets.
//!
//! One quick boundary probe per loop family: whitespace tolerance (pins every
//! `skip_ws` loop and its guard), unknown-type literal probes (pin the
//! `null`/`true`/`false` literal arms through the parser-before-material
//! order), and the exact frame node budget (250 000 ok as `UnknownField`
//! proves the parse completed; 250 001 fails as `NodeLimit`).

use eliotr_canonical::{
    JSON_SYNTAX_CODE, SNAPSHOT_DEPTH_LIMIT_CODE, SNAPSHOT_NODE_LIMIT_CODE, SNAPSHOT_NODES_MAX,
    SNAPSHOT_SYNTAX_CODE, SNAPSHOT_UNKNOWN_FIELD_CODE, SnapshotIdentityError, canonicalize_json,
    derive_owner_token_from_preimage, derive_snapshot_identity,
};

const STEM: &str = concat!(
    "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
    "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
    "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"pa1\",",
    "\"disclosure_closure_digest\":",
    "\"0000000000000000000000000000000000000000000000000000000000000000\",",
    "\"purge_ledger_revision\":0,\"created_at\":\"2026-01-01T00:00:00.000Z\",",
    "\"expires_at\":\"2026-01-01T00:15:00.000Z\"}",
);

#[test]
fn whitespace_everywhere_parses_identically() {
    // Commas, brackets and the outer frame tolerate surrounding whitespace;
    // no replacement touches bytes inside string values.
    let pretty = format!(
        "\n  {}\n",
        STEM.replace(',', ",\n  ")
            .replace("[\"", "[ \"")
            .replace("\"]", "\" ]")
    );
    assert_eq!(
        derive_snapshot_identity(pretty.as_bytes()).map_err(|error| error.code()),
        derive_snapshot_identity(STEM.as_bytes()).map_err(|error| error.code())
    );
    assert!(derive_snapshot_identity(pretty.as_bytes()).is_ok());

    let pretty_json = "{\n \"b\" : [ true , false , null ] ,\n \"a\" : 1 \n}";
    assert_eq!(
        canonicalize_json(pretty_json.as_bytes()),
        Ok(br#"{"a":1,"b":[true,false,null]}"#.to_vec())
    );

    let tuple_ws =
        " [ \"eliotr.source-owner.initial.v1\" , \"n\" , \"eliotr\" , \"i\" , 1 , \"ACTIVE\" ] ";
    assert!(derive_owner_token_from_preimage(tuple_ws.as_bytes()).is_ok());
}

#[test]
fn long_whitespace_run_stays_within_guard_budget() {
    let mut input = vec![b' '; 10 * 1024];
    input.extend_from_slice(b"null");
    assert_eq!(canonicalize_json(&input), Ok(b"null".to_vec()));

    let mut framed = vec![b' '; 1024];
    framed.extend_from_slice(STEM.as_bytes());
    framed.push(b' ');
    assert!(derive_snapshot_identity(&framed).is_ok());
}

#[test]
fn unknown_type_probes_pin_literal_and_container_arms() {
    // The frame parser runs before material admission, so every JSON value
    // class surfaces here as UnknownField; a deleted literal/container arm
    // would report Syntax instead.
    for probe in [
        "{\"zzz\":null,\"revision\":1}",
        "{\"zzz\":true,\"revision\":1}",
        "{\"zzz\":false,\"revision\":1}",
        "{\"zzz\":[],\"revision\":1}",
        "{\"zzz\":{},\"revision\":1}",
        "{\"zzz\":0,\"revision\":1}",
        "{\"zzz\":\"s\",\"revision\":1}",
    ] {
        assert_eq!(
            derive_snapshot_identity(probe.as_bytes()).map_err(|error| error.code()),
            Err(SNAPSHOT_UNKNOWN_FIELD_CODE),
            "probe {probe}"
        );
    }
    assert_eq!(
        derive_snapshot_identity(b"{\"zzz\":nul,\"revision\":1}").map_err(|error| error.code()),
        Err(SNAPSHOT_SYNTAX_CODE)
    );
    // Canonical JSON keeps the same literal vocabulary with sorted keys.
    assert_eq!(
        canonicalize_json(b"{\"z\":null,\"a\":[true,false]}"),
        Ok(br#"{"a":[true,false],"z":null}"#.to_vec())
    );
    assert_eq!(
        canonicalize_json(b"{\"z\":nul}").map_err(|error| error.code()),
        Err(JSON_SYNTAX_CODE)
    );
    assert_eq!(
        canonicalize_json(b"{\"z\":nul,\"a\":1}").map_err(|error| error.code()),
        Err(JSON_SYNTAX_CODE)
    );
}

#[test]
fn frame_node_budget_boundary_ok_proves_parse_completed() {
    // 1 root + 49 999 members x 5 nodes + 1 member x 4 nodes = exactly MAX.
    assert_eq!(1 + 49_999 * 5 + 4, SNAPSHOT_NODES_MAX);
    let mut members = Vec::with_capacity(50_000);
    for index in 0..49_999 {
        members.push(format!("\"k{index}\":[0,0,0,0]"));
    }
    members.push("\"last\":[0,0,0]".to_owned());
    let at_max = format!("{{{}}}", members.join(","));
    // Fully parsed (node budget holds), then rejected as unknown material.
    assert_eq!(
        derive_snapshot_identity(at_max.as_bytes()),
        Err(SnapshotIdentityError::UnknownField)
    );

    members.pop();
    members.push("\"last\":[0,0,0,0]".to_owned());
    let over = format!("{{{}}}", members.join(","));
    assert_eq!(
        derive_snapshot_identity(over.as_bytes()),
        Err(SnapshotIdentityError::NodeLimit {
            max_nodes: SNAPSHOT_NODES_MAX
        })
    );
    assert_eq!(
        derive_snapshot_identity(over.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_NODE_LIMIT_CODE)
    );
}

#[test]
fn frame_depth_guard_still_fires_past_nesting_budget() {
    let deep = format!("{{\"z\":{}0{}}}", "[".repeat(200), "]".repeat(200));
    assert_eq!(
        derive_snapshot_identity(deep.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_DEPTH_LIMIT_CODE)
    );
}
