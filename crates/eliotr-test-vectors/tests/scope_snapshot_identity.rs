//! Cross-cutting integration tests for `scope-snapshot-identity.v1`.
//!
//! The committed 52-case corpus already executes through TypeScript, native Rust and
//! Rust/Wasm. These tests prove the properties the task requires beyond single-case
//! execution: ordering and escaped-equivalent metamorphism, replay versus conflicting
//! replay, digest/ID binding on valid-hex tamper, zero/max/max+1 boundaries, parser
//! negatives, and stable operation/error vocabulary. TypeScript remains the authority;
//! this family is `IMPLEMENTED_NOT_LIVE`.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    SNAPSHOT_ID_HEX_CHARS, SNAPSHOT_ID_PREFIX, SNAPSHOT_MEMBERS_MAX, SNAPSHOT_PARTICIPANTS_MAX,
    SNAPSHOT_SCOPE_ATOMS_MAX, SNAPSHOT_SCOPE_DEPTH_MAX, SNAPSHOT_SELECTED_SOURCES_MAX,
    SnapshotIdentityError, derive_snapshot_identity, sha256, verify_snapshot_identity,
};
use eliotr_test_vectors::{
    EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS, SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER,
    SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER, ScopeSnapshotIdentityExpectedError,
    ScopeSnapshotIdentityOperation, ScopeSnapshotIdentityVerificationError,
    parse_scope_snapshot_identity_vector_set, verify_embedded_scope_snapshot_identity_vectors,
    verify_scope_snapshot_identity_vector_set,
};

const DIGEST0: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn material_minimal() -> Vec<u8> {
    format!(
        "{{\"revision\":1,\"resolved_scope_expression\":{{\"kind\":\"GLOBAL_LIBRARY\"}},\
        \"participant_generations\":{{\"p1\":\"g1\"}},\"member_source_revision_refs\":[\"sr1\"],\
        \"source_owner_generations\":{{\"sr1\":\"og1\"}},\"policy_authority_ref\":\"pa1\",\
        \"disclosure_closure_digest\":\"{DIGEST0}\",\"purge_ledger_revision\":0,\
        \"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}}"
    )
    .into_bytes()
}

fn snapshot_field(output: &[u8], key: &str) -> Option<String> {
    let text = core::str::from_utf8(output).ok()?;
    let marker = format!("\"{key}\":\"");
    let start = text.find(&marker)? + marker.len();
    let end = text[start..].find('"').map(|o| start + o)?;
    text.get(start..end).map(str::to_owned)
}

fn derive_ok(input: &[u8]) -> Option<Vec<u8>> {
    let result = derive_snapshot_identity(input);
    assert!(result.is_ok());
    result.ok()
}

fn to_hex(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(ALPHABET[(byte >> 4) as usize] as char);
        out.push(ALPHABET[(byte & 0x0f) as usize] as char);
    }
    out
}

#[test]
fn embedded_vectors_pass() {
    assert_eq!(verify_embedded_scope_snapshot_identity_vectors(), Ok(()));
}

#[test]
fn corpus_shape_is_committed() {
    let parsed = parse_scope_snapshot_identity_vector_set(EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS);
    assert!(parsed.is_ok());
    let Ok(set) = parsed else {
        return;
    };
    assert_eq!(set.cases().len(), 52);
}

#[test]
fn ordering_and_escaped_inputs_share_bytes() {
    let Some(canonical) = derive_ok(&material_minimal()) else {
        return;
    };
    let shuffled = br#"{ "expires_at":"2026-01-01T00:15:00.000Z","created_at":"2026-01-01T00:00:00.000Z","purge_ledger_revision":0,"disclosure_closure_digest":"0000000000000000000000000000000000000000000000000000000000000000","policy_authority_ref":"pa1","source_owner_generations":{"sr1":"og1"},"member_source_revision_refs":["sr1"],"participant_generations":{"p1":"g1"},"resolved_scope_expression":{"kind":"GLOBAL_LIBRARY"},"revision":1 }"#;
    let escaped = br#"{"revision":1,"resolved_scope_expression":{"kind":"GLOBAL_LIBRARY"},"participant_generations":{"p1":"g1"},"member_source_revision_refs":["sr\u0031"],"source_owner_generations":{"sr1":"og1"},"policy_authority_ref":"\u0070a1","disclosure_closure_digest":"0000000000000000000000000000000000000000000000000000000000000000","purge_ledger_revision":0,"created_at":"2026-01-01T00:00:00.000Z","expires_at":"2026-01-01T00:15:00.000Z"}"#;
    assert_eq!(derive_snapshot_identity(shuffled), Ok(canonical.clone()));
    assert_eq!(derive_snapshot_identity(escaped), Ok(canonical));
}

#[test]
fn digest_binds_canonical_bytes_and_id() {
    let Some(output) = derive_ok(&material_minimal()) else {
        return;
    };
    let Ok(text) = core::str::from_utf8(&output).map(str::to_owned) else {
        return;
    };
    let (Some(snapshot_id), Some(digest)) = (
        snapshot_field(&output, "snapshot_id"),
        snapshot_field(&output, "digest"),
    ) else {
        return;
    };
    assert!(snapshot_id.starts_with(SNAPSHOT_ID_PREFIX));
    assert_eq!(
        snapshot_id.len(),
        SNAPSHOT_ID_PREFIX.len() + SNAPSHOT_ID_HEX_CHARS
    );
    // The digest commits to the digest payload (`snapshot_id` plus the identity payload,
    // which carries the non-wire `protocol` member), not to the full snapshot itself. Both
    // are canonicalized with the same UTF-16 key order, so the digest preimage is the
    // verified output with its `digest` member removed and the protocol member inserted
    // at its sorted position between `policy_authority_ref` and `purge_ledger_revision`.
    let needle = format!(",\"digest\":\"{digest}\"");
    assert!(text.contains(&needle));
    let without_digest = text.replace(&needle, "");
    let anchor = "\"purge_ledger_revision\"";
    assert!(without_digest.contains(anchor));
    let digest_payload = without_digest.replace(
        anchor,
        "\"protocol\":\"eliotr.scope-snapshot.v1\",\"purge_ledger_revision\"",
    );
    assert_eq!(to_hex(&sha256(digest_payload.as_bytes())), digest);
    assert_eq!(verify_snapshot_identity(&output), Ok(output));
}

#[test]
fn replay_matches_but_conflict_fails() {
    let Some(output) = derive_ok(&material_minimal()) else {
        return;
    };
    assert_eq!(verify_snapshot_identity(&output), Ok(output.clone()));
    let Ok(text) = core::str::from_utf8(&output).map(str::to_owned) else {
        return;
    };
    let conflicting = text.replace(
        "\"member_source_revision_refs\":[\"sr1\"]",
        "\"member_source_revision_refs\":[\"sr1\",\"sr-conflict\"]",
    );
    assert_ne!(conflicting.as_bytes(), output.as_slice());
    assert_eq!(
        verify_snapshot_identity(conflicting.as_bytes()),
        Err(SnapshotIdentityError::IdMismatch)
    );
}

#[test]
fn valid_hex_tamper_breaks_the_id() {
    let Some(output) = derive_ok(&material_minimal()) else {
        return;
    };
    let Ok(text) = core::str::from_utf8(&output).map(str::to_owned) else {
        return;
    };
    let tampered = text.replace("\"pa1\"", "\"foreign-policy-9\"");
    assert_eq!(
        verify_snapshot_identity(tampered.as_bytes()),
        Err(SnapshotIdentityError::IdMismatch)
    );
    let (Some(snapshot_id), Some(digest)) = (
        snapshot_field(&output, "snapshot_id"),
        snapshot_field(&output, "digest"),
    ) else {
        return;
    };
    let flipped = format!(
        "{}{}",
        &snapshot_id[..snapshot_id.len() - 1],
        if snapshot_id.ends_with('0') { "1" } else { "0" }
    );
    let tampered_id = text.replace(&snapshot_id, &flipped);
    assert_eq!(
        verify_snapshot_identity(tampered_id.as_bytes()),
        Err(SnapshotIdentityError::IdMismatch)
    );
    let flipped_digest = format!(
        "{}{}",
        &digest[..digest.len() - 1],
        if digest.ends_with('0') { "1" } else { "0" }
    );
    let tampered_digest = text.replace(&digest, &flipped_digest);
    assert_eq!(
        verify_snapshot_identity(tampered_digest.as_bytes()),
        Err(SnapshotIdentityError::DigestMismatch)
    );
}

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
fn derive_rejects_supplied_snapshot_id_and_digest() {
    let Ok(base) = core::str::from_utf8(&material_minimal()).map(str::to_owned) else {
        return;
    };
    let Some(stem) = base.strip_suffix('}') else {
        return;
    };
    for derived in [
        format!("{stem},\"snapshot_id\":\"scope-{}\"}}", "0".repeat(48)),
        format!("{stem},\"digest\":\"{}\"}}", "0".repeat(64)),
    ] {
        assert_eq!(
            derive_snapshot_identity(derived.as_bytes()),
            Err(SnapshotIdentityError::UnknownField)
        );
    }
}

#[test]
fn fractional_seconds_beyond_nine_digits_round_trip() {
    let cases = [
        (
            "2026-01-01T00:00:00.1234567890Z",
            "2026-01-01T00:15:00.1234567890Z",
        ),
        (
            "2026-01-01T00:00:00.12345678901234567890+05:30",
            "2026-06-02T12:00:00.00000000000000000001-02:00",
        ),
    ];
    for (created, expires) in cases {
        let Ok(base) = core::str::from_utf8(&material_minimal()).map(str::to_owned) else {
            return;
        };
        let material = base
            .replace("2026-01-01T00:00:00.000Z", created)
            .replace("2026-01-01T00:15:00.000Z", expires);
        let derived = derive_snapshot_identity(material.as_bytes());
        assert!(derived.is_ok());
        if let Ok(bytes) = derived {
            assert!(core::str::from_utf8(&bytes).unwrap_or("").contains(created));
            assert_eq!(verify_snapshot_identity(&bytes), Ok(bytes));
        }
    }
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
fn detects_every_semantic_mismatch() {
    let row = |suffix: &str| {
        format!(
            "{SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER}\n# schema_generation=1\n{SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER}\n{suffix}\n"
        )
    };
    let Some(minimal_output) = derive_ok(&material_minimal()) else {
        return;
    };
    let minimal_bytes = material_minimal();
    let Ok(minimal_text) = core::str::from_utf8(&minimal_bytes).map(str::to_owned) else {
        return;
    };
    let variant = minimal_text.replace("\"pa1\"", "\"pa2\"");
    let Some(other_output) = derive_ok(variant.as_bytes()) else {
        return;
    };
    let mismatch = parse_scope_snapshot_identity_vector_set(&row(&format!(
        "wrong_output|derive_snapshot_identity|{}|ok|{}|-",
        to_hex(&minimal_bytes),
        to_hex(&other_output)
    )));
    assert!(mismatch.is_ok());
    if let Ok(set) = mismatch {
        assert!(matches!(
            verify_scope_snapshot_identity_vector_set(&set),
            Err(ScopeSnapshotIdentityVerificationError::OutputMismatch { .. })
        ));
    }
    let unexpected_error = row(&format!(
        "unexpected_error|derive_snapshot_identity|5b5d|ok|{}|-",
        to_hex(&minimal_output)
    ));
    let parsed_unexpected = parse_scope_snapshot_identity_vector_set(&unexpected_error);
    assert!(parsed_unexpected.is_ok());
    if let Ok(set) = parsed_unexpected {
        assert!(matches!(
            verify_scope_snapshot_identity_vector_set(&set),
            Err(ScopeSnapshotIdentityVerificationError::UnexpectedError { .. })
        ));
    }
    let unexpected_success = row(&format!(
        "unexpected_success|derive_snapshot_identity|{}|error|-|ELIOTR_SNAPSHOT_SHAPE",
        to_hex(&minimal_bytes)
    ));
    let parsed_success = parse_scope_snapshot_identity_vector_set(&unexpected_success);
    assert!(parsed_success.is_ok());
    if let Ok(set) = parsed_success {
        assert!(matches!(
            verify_scope_snapshot_identity_vector_set(&set),
            Err(ScopeSnapshotIdentityVerificationError::UnexpectedSuccess { .. })
        ));
    }
    let wrong_code = row("wrong_code|derive_snapshot_identity|5b5d|error|-|ELIOTR_SNAPSHOT_UTF8");
    let parsed_code = parse_scope_snapshot_identity_vector_set(&wrong_code);
    assert!(parsed_code.is_ok());
    if let Ok(set) = parsed_code {
        assert!(matches!(
            verify_scope_snapshot_identity_vector_set(&set),
            Err(ScopeSnapshotIdentityVerificationError::ErrorCodeMismatch { .. })
        ));
    }
}

#[test]
fn rejects_frame_shape_identity_and_operation_failures() {
    let frame = |body: &str| {
        format!(
            "{SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER}\n# schema_generation=1\n{SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER}\n{body}\n"
        )
    };
    let Some(minimal_output) = derive_ok(&material_minimal()) else {
        return;
    };
    let valid_hex = to_hex(&minimal_output);
    let base = format!(
        "ok_case|derive_snapshot_identity|{}|ok|{}|-",
        to_hex(&material_minimal()),
        valid_hex
    );
    assert!(
        parse_scope_snapshot_identity_vector_set(
            &frame(&base).replace("scope-snapshot-identity.v1", "unknown.v1")
        )
        .is_err()
    );
    assert!(parse_scope_snapshot_identity_vector_set(&frame(&format!("{base}\n{base}"))).is_err());
    assert!(
        parse_scope_snapshot_identity_vector_set(&frame(&base.replace("ok_case", "__proto__")))
            .is_err()
    );
    assert!(
        parse_scope_snapshot_identity_vector_set(&frame(
            &base.replace("derive_snapshot_identity", "unknown_operation")
        ))
        .is_err()
    );
    assert!(
        parse_scope_snapshot_identity_vector_set(&frame(&base.replace(&valid_hex, "61"))).is_err()
    );
    let unknown_error = format!(
        "bad_code|derive_snapshot_identity|{}|error|-|ELIOTR_UNKNOWN",
        to_hex(&material_minimal())
    );
    assert!(parse_scope_snapshot_identity_vector_set(&frame(&unknown_error)).is_err());
    let incompatible_row = format!(
        "bad_compat|derive_snapshot_identity|{}|error|-|ELIOTR_SNAPSHOT_ID_MISMATCH",
        to_hex(&material_minimal())
    );
    assert!(parse_scope_snapshot_identity_vector_set(&frame(&incompatible_row)).is_err());
}

#[test]
fn error_codes_and_operations_are_stable() {
    assert_eq!(
        ScopeSnapshotIdentityOperation::DeriveSnapshotIdentity,
        ScopeSnapshotIdentityOperation::DeriveSnapshotIdentity
    );
    for code in [
        ScopeSnapshotIdentityExpectedError::InputTooLarge,
        ScopeSnapshotIdentityExpectedError::IdMismatch,
        ScopeSnapshotIdentityExpectedError::DigestMismatch,
    ] {
        assert!(code.code().starts_with("ELIOTR_SNAPSHOT_"));
    }
    assert!(
        !ScopeSnapshotIdentityExpectedError::IdMismatch
            .code()
            .contains("scope-")
    );
}

#[test]
fn every_kernel_error_formats_without_source_content() {
    use eliotr_canonical::{
        SNAPSHOT_DEPTH_LIMIT_CODE, SNAPSHOT_DIGEST_CODE, SNAPSHOT_DIGEST_MISMATCH_CODE,
        SNAPSHOT_DUPLICATE_KEY_CODE, SNAPSHOT_EXPRESSION_CODE, SNAPSHOT_ID_MISMATCH_CODE,
        SNAPSHOT_IDENTIFIER_CODE, SNAPSHOT_INPUT_TOO_LARGE_CODE, SNAPSHOT_MEMBER_LIMIT_CODE,
        SNAPSHOT_MISSING_FIELD_CODE, SNAPSHOT_NODE_LIMIT_CODE, SNAPSHOT_NUMBER_CODE,
        SNAPSHOT_OUTPUT_TOO_LARGE_CODE, SNAPSHOT_REVISION_CODE, SNAPSHOT_SHAPE_CODE,
        SNAPSHOT_STRING_TOO_LARGE_CODE, SNAPSHOT_SYNTAX_CODE, SNAPSHOT_TIMESTAMP_CODE,
        SNAPSHOT_UNICODE_CODE, SNAPSHOT_UNKNOWN_FIELD_CODE, SNAPSHOT_UTF8_CODE,
    };
    let cases: [(SnapshotIdentityError, &str); 21] = [
        (
            SnapshotIdentityError::InputTooLarge {
                actual_bytes: 3,
                max_bytes: 2,
            },
            SNAPSHOT_INPUT_TOO_LARGE_CODE,
        ),
        (
            SnapshotIdentityError::InvalidUtf8 { valid_up_to: 1 },
            SNAPSHOT_UTF8_CODE,
        ),
        (
            SnapshotIdentityError::Syntax { offset: 0 },
            SNAPSHOT_SYNTAX_CODE,
        ),
        (
            SnapshotIdentityError::DuplicateKey { offset: 0 },
            SNAPSHOT_DUPLICATE_KEY_CODE,
        ),
        (
            SnapshotIdentityError::Unicode { offset: 0 },
            SNAPSHOT_UNICODE_CODE,
        ),
        (
            SnapshotIdentityError::Number { offset: 0 },
            SNAPSHOT_NUMBER_CODE,
        ),
        (
            SnapshotIdentityError::DepthLimit { max_depth: 64 },
            SNAPSHOT_DEPTH_LIMIT_CODE,
        ),
        (
            SnapshotIdentityError::MemberLimit { max_members: 7 },
            SNAPSHOT_MEMBER_LIMIT_CODE,
        ),
        (
            SnapshotIdentityError::NodeLimit { max_nodes: 9 },
            SNAPSHOT_NODE_LIMIT_CODE,
        ),
        (
            SnapshotIdentityError::StringTooLarge { max_bytes: 11 },
            SNAPSHOT_STRING_TOO_LARGE_CODE,
        ),
        (
            SnapshotIdentityError::OutputTooLarge { max_bytes: 13 },
            SNAPSHOT_OUTPUT_TOO_LARGE_CODE,
        ),
        (SnapshotIdentityError::Shape, SNAPSHOT_SHAPE_CODE),
        (
            SnapshotIdentityError::MissingField,
            SNAPSHOT_MISSING_FIELD_CODE,
        ),
        (
            SnapshotIdentityError::UnknownField,
            SNAPSHOT_UNKNOWN_FIELD_CODE,
        ),
        (SnapshotIdentityError::Identifier, SNAPSHOT_IDENTIFIER_CODE),
        (SnapshotIdentityError::Digest, SNAPSHOT_DIGEST_CODE),
        (SnapshotIdentityError::Revision, SNAPSHOT_REVISION_CODE),
        (SnapshotIdentityError::Timestamp, SNAPSHOT_TIMESTAMP_CODE),
        (SnapshotIdentityError::Expression, SNAPSHOT_EXPRESSION_CODE),
        (SnapshotIdentityError::IdMismatch, SNAPSHOT_ID_MISMATCH_CODE),
        (
            SnapshotIdentityError::DigestMismatch,
            SNAPSHOT_DIGEST_MISMATCH_CODE,
        ),
    ];
    for (error, code) in cases {
        assert_eq!(error.code(), code);
        let message = error.to_string();
        assert!(!message.is_empty());
        assert!(!message.contains("sr1"));
        assert!(!message.contains("scope-"));
    }
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
