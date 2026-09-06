//! Boundary and ceiling tests for `scope-snapshot-identity.v1`.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    SNAPSHOT_MEMBERS_MAX, SNAPSHOT_PARTICIPANTS_MAX, SNAPSHOT_SCOPE_ATOMS_MAX,
    SNAPSHOT_SCOPE_DEPTH_MAX, SNAPSHOT_SELECTED_SOURCES_MAX, SnapshotIdentityError,
    derive_snapshot_identity,
};

use super::common::{DIGEST0, material_minimal};

#[test]
fn zero_members_derive_but_empty_identifiers_fail() {
    let zero = br#"{"revision":1,"resolved_scope_expression":{"kind":"GLOBAL_LIBRARY"},"participant_generations":{},"member_source_revision_refs":[],"source_owner_generations":{},"policy_authority_ref":"pa0","disclosure_closure_digest":"0000000000000000000000000000000000000000000000000000000000000000","purge_ledger_revision":0,"created_at":"2026-01-01T00:00:00.000Z","expires_at":"2026-01-01T00:15:00.000Z"}"#;
    assert!(derive_snapshot_identity(zero).is_ok());
    let empty_id = br#"{"revision":1,"resolved_scope_expression":{"kind":"GLOBAL_LIBRARY"},"participant_generations":{},"member_source_revision_refs":[],"source_owner_generations":{},"policy_authority_ref":"","disclosure_closure_digest":"0000000000000000000000000000000000000000000000000000000000000000","purge_ledger_revision":0,"created_at":"2026-01-01T00:00:00.000Z","expires_at":"2026-01-01T00:15:00.000Z"}"#;
    assert_eq!(
        derive_snapshot_identity(empty_id),
        Err(SnapshotIdentityError::Identifier)
    );
}

#[test]
fn max_identifier_admits_but_max_plus_one_fails() {
    let build = |id: &str| {
        format!(
            "{{\"revision\":1,\"resolved_scope_expression\":{{\"kind\":\"GLOBAL_LIBRARY\"}},\
            \"participant_generations\":{{}},\"member_source_revision_refs\":[],\
            \"source_owner_generations\":{{}},\"policy_authority_ref\":\"{id}\",\
            \"disclosure_closure_digest\":\"{DIGEST0}\",\"purge_ledger_revision\":0,\
            \"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}}"
        )
        .into_bytes()
    };
    assert!(derive_snapshot_identity(&build(&"a".repeat(256))).is_ok());
    assert_eq!(
        derive_snapshot_identity(&build(&"a".repeat(257))),
        Err(SnapshotIdentityError::Identifier)
    );
}

#[test]
fn member_and_participant_ceilings_hold() {
    let members: Vec<String> = (0..SNAPSHOT_MEMBERS_MAX)
        .map(|i| format!("\"m{i}\""))
        .collect();
    let owners: Vec<String> = (0..SNAPSHOT_MEMBERS_MAX)
        .map(|i| format!("\"m{i}\":\"o{i}\""))
        .collect();
    let full = format!(
        "{{\"revision\":1,\"resolved_scope_expression\":{{\"kind\":\"GLOBAL_LIBRARY\"}},\
        \"participant_generations\":{{\"p\":\"g\"}},\"member_source_revision_refs\":[{}],\
        \"source_owner_generations\":{{{}}},\"policy_authority_ref\":\"pa\",\
        \"disclosure_closure_digest\":\"{DIGEST0}\",\"purge_ledger_revision\":0,\
        \"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}}",
        members.join(","),
        owners.join(",")
    );
    assert!(derive_snapshot_identity(full.as_bytes()).is_ok());
    let overflow = full.replacen("\"m0\"", "\"m0\",\"m-overflow\"", 1);
    assert_eq!(
        derive_snapshot_identity(overflow.as_bytes()),
        Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_MEMBERS_MAX
        })
    );
    let participants: Vec<String> = (0..=SNAPSHOT_PARTICIPANTS_MAX)
        .map(|i| format!("\"p{i}\":\"g{i}\""))
        .collect();
    let too_many = format!(
        "{{\"revision\":1,\"resolved_scope_expression\":{{\"kind\":\"GLOBAL_LIBRARY\"}},\
        \"participant_generations\":{{{}}},\"member_source_revision_refs\":[],\
        \"source_owner_generations\":{{}},\"policy_authority_ref\":\"pa\",\
        \"disclosure_closure_digest\":\"{DIGEST0}\",\"purge_ledger_revision\":0,\
        \"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}}",
        participants.join(",")
    );
    assert_eq!(
        derive_snapshot_identity(too_many.as_bytes()),
        Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_PARTICIPANTS_MAX
        })
    );
}

#[test]
fn scope_depth_atom_and_selected_ceilings_hold() {
    assert_eq!(SNAPSHOT_SCOPE_DEPTH_MAX, 32);
    assert_eq!(SNAPSHOT_SCOPE_ATOMS_MAX, 256);
    assert_eq!(SNAPSHOT_SELECTED_SOURCES_MAX, 1_000);
    let mut deep = "{\"kind\":\"GLOBAL_LIBRARY\"}".to_owned();
    for _ in 0..SNAPSHOT_SCOPE_DEPTH_MAX {
        deep = format!(
            "{{\"kind\":\"UNION\",\"left\":{deep},\"right\":{{\"kind\":\"GLOBAL_LIBRARY\"}}}}"
        );
    }
    let material = |expression: &str| {
        format!(
            "{{\"revision\":1,\"resolved_scope_expression\":{expression},\
            \"participant_generations\":{{}},\"member_source_revision_refs\":[],\
            \"source_owner_generations\":{{}},\"policy_authority_ref\":\"pa\",\
            \"disclosure_closure_digest\":\"{DIGEST0}\",\"purge_ledger_revision\":0,\
            \"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}}"
        )
        .into_bytes()
    };
    assert!(derive_snapshot_identity(&material(&deep)).is_err());
    let ids: Vec<String> = (0..=1_000).map(|i| format!("\"s{i}\"")).collect();
    let selected = format!(
        "{{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[{}]}}",
        ids.join(",")
    );
    assert_eq!(
        derive_snapshot_identity(&material(&selected)),
        Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_SCOPE_ATOMS_MAX
        })
    );
}

#[test]
fn oversized_payload_fails_before_allocation() {
    let mut big = material_minimal();
    big.resize(2 * 1024 * 1024 + 1, b' ');
    assert_eq!(
        derive_snapshot_identity(&big),
        Err(SnapshotIdentityError::InputTooLarge {
            actual_bytes: big.len(),
            max_bytes: 2 * 1024 * 1024
        })
    );
}

#[test]
fn frame_depth_string_and_node_ceilings_hold() {
    let mut deep = String::from("1");
    for _ in 0..70 {
        deep = format!("[{deep}]");
    }
    assert_eq!(
        derive_snapshot_identity(deep.as_bytes()),
        Err(SnapshotIdentityError::DepthLimit { max_depth: 64 })
    );
    let big_string = format!("{{\"a\":\"{}\"}}", "a".repeat(5000));
    assert_eq!(
        derive_snapshot_identity(big_string.as_bytes()),
        Err(SnapshotIdentityError::StringTooLarge { max_bytes: 4096 })
    );
    // Wide-plus-deep documents exhaust the node budget before any per-object ceiling:
    // 51k members with six nodes each exceed the 250k total while every object stays
    // within its own member limit and the input stays within its byte budget.
    let mut members = String::new();
    for i in 0..51_000 {
        if i > 0 {
            members.push(',');
        }
        members.push_str(&format!("\"m{i}\":{{\"a\":{{\"b\":{{\"c\":[1]}}}}}}"));
    }
    let bushy = format!("{{{members}}}");
    assert!(bushy.len() < 2 * 1024 * 1024);
    assert_eq!(
        derive_snapshot_identity(bushy.as_bytes()),
        Err(SnapshotIdentityError::NodeLimit { max_nodes: 250_000 })
    );
}
