//! ER-40 S6 native kill-matrix: scope validators and verify order (S2+S4).
//!
//! Every validator arm is pinned with the exact public error code through
//! `derive_snapshot_identity` / `verify_snapshot_identity`; mismatch order
//! (ID before digest) is asserted exactly. Owner-token, stable-ID,
//! generation and exhaustive code tables live in `kill_codes.rs`.

use eliotr_canonical::{
    SNAPSHOT_DIGEST_CODE, SNAPSHOT_DIGEST_MISMATCH_CODE, SNAPSHOT_EXPRESSION_CODE,
    SNAPSHOT_ID_MISMATCH_CODE, SNAPSHOT_IDENTIFIER_CODE, SNAPSHOT_MEMBER_LIMIT_CODE,
    SNAPSHOT_MISSING_FIELD_CODE, SNAPSHOT_NUMBER_CODE, SNAPSHOT_REVISION_CODE, SNAPSHOT_SHAPE_CODE,
    SNAPSHOT_UNKNOWN_FIELD_CODE, derive_snapshot_identity, verify_snapshot_identity,
};

const DIGEST0: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn material_with_expression(expression: &str) -> Vec<u8> {
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

fn material_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    derive_snapshot_identity(input).map_err(|error| error.code())
}

fn base_material() -> String {
    core::str::from_utf8(&material_with_expression("{\"kind\":\"GLOBAL_LIBRARY\"}"))
        .unwrap_or("")
        .to_owned()
}

#[test]
fn expression_all_kinds_derive_ok() {
    for expression in [
        "{\"kind\":\"GLOBAL_LIBRARY\"}",
        "{\"kind\":\"PROJECT\",\"project_id\":\"p1\"}",
        "{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[\"s1\",\"s2\"]}",
        "{\"kind\":\"SOURCE_CLASS\",\"source_class\":\"sc1\"}",
        "{\"kind\":\"TAG\",\"tag\":\"t1\"}",
        "{\"kind\":\"UNION\",\"left\":{\"kind\":\"GLOBAL_LIBRARY\"},\"right\":{\"kind\":\"GLOBAL_LIBRARY\"}}",
        "{\"kind\":\"INTERSECT\",\"left\":{\"kind\":\"TAG\",\"tag\":\"t\"},\"right\":{\"kind\":\"PROJECT\",\"project_id\":\"p\"}}",
        "{\"kind\":\"EXCEPT\",\"left\":{\"kind\":\"GLOBAL_LIBRARY\"},\"right\":{\"kind\":\"GLOBAL_LIBRARY\"}}",
    ] {
        assert!(
            material_code(&material_with_expression(expression)).is_ok(),
            "expression {expression}"
        );
    }
}

#[test]
fn expression_shape_failures_report_expression_code() {
    for expression in [
        "{\"kind\":\"NOPE\"}",
        "{\"kind\":\"GLOBAL_LIBRARY\",\"extra\":1}",
        "{\"kind\":\"PROJECT\"}",
        "{\"kind\":\"PROJECT\",\"project_id\":\"p1\",\"extra\":1}",
        "{\"kind\":\"PROJECT\",\"project_id\":123}",
        "{\"kind\":\"PROJECT\",\"project_id\":\"\"}",
        "{\"kind\":\"TAG\",\"tag\":\"t1\",\"extra\":1}",
        "{\"kind\":\"TAG\",\"tag\":5}",
        "{\"kind\":\"SOURCE_CLASS\",\"source_class\":\"\"}",
        "{\"kind\":\"UNION\",\"left\":{\"kind\":\"GLOBAL_LIBRARY\"}}",
        "{\"kind\":\"UNION\",\"left\":{\"kind\":\"GLOBAL_LIBRARY\"},\"right\":{\"kind\":\"GLOBAL_LIBRARY\"},\"extra\":1}",
        "{\"kind\":\"UNION\",\"left\":\"x\",\"right\":{\"kind\":\"GLOBAL_LIBRARY\"}}",
        "{\"kind\":\"UNION\",\"left\":{\"kind\":\"GLOBAL_LIBRARY\"},\"right\":7}",
        "{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":\"s\"}",
        "{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[]}",
        "{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[1]}",
        "{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[\"\"]}",
        "{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[\"s1\",5]}",
        "{}",
        "{\"kind\":123}",
        "\"x\"",
        "7",
    ] {
        assert_eq!(
            material_code(&material_with_expression(expression)),
            Err(SNAPSHOT_EXPRESSION_CODE),
            "expression {expression}"
        );
    }
}

#[test]
fn expression_depth_and_count_overflows_fail_closed() {
    // Balanced UNION tree: 300 atoms at depth ~9 (atoms overflow, not depth).
    let mut level: Vec<String> = (0..300)
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
    assert_eq!(level.len(), 1);
    assert_eq!(
        material_code(&material_with_expression(&level[0])),
        Err(SNAPSHOT_MEMBER_LIMIT_CODE)
    );

    // 1001 selected sources: selected overflow alone.
    let ids = (0..1001)
        .map(|index| format!("\"s{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    assert_eq!(
        material_code(&material_with_expression(&format!(
            "{{\"kind\":\"SELECTED_SOURCES\",\"source_ids\":[{ids}]}}"
        ))),
        Err(SNAPSHOT_MEMBER_LIMIT_CODE)
    );

    // 40-deep UNION chain: scope-depth overflow reports Expression.
    let mut deep = "{\"kind\":\"GLOBAL_LIBRARY\"}".to_owned();
    for _ in 0..40 {
        deep = format!(
            "{{\"kind\":\"UNION\",\"left\":{deep},\"right\":{{\"kind\":\"GLOBAL_LIBRARY\"}}}}"
        );
    }
    assert_eq!(
        material_code(&material_with_expression(&deep)),
        Err(SNAPSHOT_EXPRESSION_CODE)
    );
}

#[test]
fn material_revision_and_purge_envelopes_are_exact() {
    let cases: &[(&str, &str, &str)] = &[
        ("\"revision\":1", "\"purge_ledger_revision\":0", ""),
        (
            "\"revision\":0",
            "\"purge_ledger_revision\":0",
            SNAPSHOT_REVISION_CODE,
        ),
        (
            "\"revision\":-5",
            "\"purge_ledger_revision\":0",
            SNAPSHOT_REVISION_CODE,
        ),
        (
            "\"revision\":\"1\"",
            "\"purge_ledger_revision\":0",
            SNAPSHOT_SHAPE_CODE,
        ),
        (
            "\"revision\":-0",
            "\"purge_ledger_revision\":0",
            SNAPSHOT_NUMBER_CODE,
        ),
        (
            "\"revision\":01",
            "\"purge_ledger_revision\":0",
            SNAPSHOT_NUMBER_CODE,
        ),
        (
            "\"revision\":9007199254740992",
            "\"purge_ledger_revision\":0",
            SNAPSHOT_NUMBER_CODE,
        ),
        (
            "\"revision\":1",
            "\"purge_ledger_revision\":-1",
            SNAPSHOT_REVISION_CODE,
        ),
        (
            "\"revision\":1",
            "\"purge_ledger_revision\":\"0\"",
            SNAPSHOT_SHAPE_CODE,
        ),
        (
            "\"revision\":1",
            "\"purge_ledger_revision\":01",
            SNAPSHOT_NUMBER_CODE,
        ),
    ];
    for (revision, purge, expected) in cases {
        let mut material = base_material();
        material = material.replace("\"revision\":1", revision);
        material = material.replace("\"purge_ledger_revision\":0", purge);
        if expected.is_empty() {
            assert!(material_code(material.as_bytes()).is_ok());
        } else {
            assert_eq!(
                material_code(material.as_bytes()),
                Err(*expected),
                "{revision}/{purge}"
            );
        }
    }
}

#[test]
fn material_digest_identifier_and_key_failures_are_exact() {
    let digest_cases: &[(&str, &str)] = &[
        ("\"policy_authority_ref\":123", SNAPSHOT_SHAPE_CODE),
        ("\"disclosure_closure_digest\":5", SNAPSHOT_SHAPE_CODE),
        (
            "\"disclosure_closure_digest\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"",
            SNAPSHOT_DIGEST_CODE,
        ),
        (
            "\"disclosure_closure_digest\":\"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg\"",
            SNAPSHOT_DIGEST_CODE,
        ),
        ("\"disclosure_closure_digest\":\"00\"", SNAPSHOT_DIGEST_CODE),
        (
            "\"disclosure_closure_digest\":\"00000000000000000000000000000000000000000000000000000000000000000\"",
            SNAPSHOT_DIGEST_CODE,
        ),
        (
            "\"participant_generations\":{\"p1\":5}",
            SNAPSHOT_SHAPE_CODE,
        ),
        (
            "\"participant_generations\":{\"\":1}",
            SNAPSHOT_IDENTIFIER_CODE,
        ),
        ("\"member_source_revision_refs\":[7]", SNAPSHOT_SHAPE_CODE),
        (
            "\"member_source_revision_refs\":[\"\"]",
            SNAPSHOT_IDENTIFIER_CODE,
        ),
        (
            "\"source_owner_generations\":{\"sr1\":\"\"}",
            SNAPSHOT_IDENTIFIER_CODE,
        ),
        ("\"policy_authority_ref\":\"\"", SNAPSHOT_IDENTIFIER_CODE),
    ];
    for (fragment, expected) in digest_cases {
        let key = fragment.split(':').next().unwrap_or("");
        let mut material = base_material();
        // Replace only the first occurrence of the targeted member.
        if let Some(start) = material.find(key) {
            let end = material[start..].find(',').map(|offset| start + offset);
            let end = end.unwrap_or(material.len());
            material.replace_range(start..end, fragment);
        }
        assert_eq!(
            material_code(material.as_bytes()),
            Err(*expected),
            "fragment {fragment}"
        );
    }
    // The optional fence is absent from the base: insert it to probe it.
    let stem = base_material().strip_suffix('}').unwrap_or("").to_owned();
    assert_eq!(
        material_code(format!("{stem},\"client_fence_ref\":\"\"}}").as_bytes()),
        Err(SNAPSHOT_IDENTIFIER_CODE)
    );
    assert_eq!(
        material_code(format!("{stem},\"client_fence_ref\":9}}").as_bytes()),
        Err(SNAPSHOT_SHAPE_CODE)
    );
    assert!(material_code(format!("{stem},\"client_fence_ref\":\"f1\"}}").as_bytes()).is_ok());
}

#[test]
fn material_missing_unknown_and_derived_keys_are_exact() {
    let mut missing = base_material();
    missing = missing.replace(",\"created_at\":\"2026-01-01T00:00:00.000Z\"", "");
    assert_eq!(
        material_code(missing.as_bytes()),
        Err(SNAPSHOT_MISSING_FIELD_CODE)
    );

    let unknown = base_material().replace("{\"revision\":1", "{\"revision\":1,\"zzz\":1");
    assert_eq!(
        material_code(unknown.as_bytes()),
        Err(SNAPSHOT_UNKNOWN_FIELD_CODE)
    );

    let stem = base_material().strip_suffix('}').unwrap_or("").to_owned();
    let with_id = format!(
        "{stem},\"snapshot_id\":\"scope-000000000000000000000000000000000000000000000000\"}}"
    );
    assert_eq!(
        material_code(with_id.as_bytes()),
        Err(SNAPSHOT_UNKNOWN_FIELD_CODE)
    );
    let with_both = format!(
        "{stem},\"snapshot_id\":\"scope-000000000000000000000000000000000000000000000000\",\"digest\":\"{DIGEST0}\"}}"
    );
    assert_eq!(
        material_code(with_both.as_bytes()),
        Err(SNAPSHOT_UNKNOWN_FIELD_CODE)
    );

    // 300 participants exceed the 257 ceiling with MemberLimit.
    let participants = (0..300)
        .map(|index| format!("\"p{index}\":\"g{index}\""))
        .collect::<Vec<_>>()
        .join(",");
    let crowded = base_material().replace("{\"p1\":\"g1\"}", &format!("{{{participants}}}"));
    assert_eq!(
        material_code(crowded.as_bytes()),
        Err(SNAPSHOT_MEMBER_LIMIT_CODE)
    );
}

fn flip_first_after(text: &str, marker: &str, skip: usize) -> Option<String> {
    let start = text.find(marker)? + marker.len() + skip;
    let mut bytes = text.as_bytes().to_vec();
    let byte = *bytes.get(start)?;
    bytes[start] = if byte == b'0' { b'1' } else { b'0' };
    Some(core::str::from_utf8(&bytes).unwrap_or("").to_owned())
}

#[test]
fn verify_mismatch_order_prefers_id_over_digest() {
    let derived = derive_snapshot_identity(&base_material().into_bytes());
    assert!(derived.is_ok());
    let Ok(bytes) = derived else { return };
    let text = core::str::from_utf8(&bytes).unwrap_or("").to_owned();
    assert_eq!(
        verify_snapshot_identity(&bytes).map_err(|error| error.code()),
        Ok(bytes.clone())
    );

    let id_key = "\"snapshot_id\":\"scope-";
    let digest_key = "\"digest\":\"";
    let Some(id_bad) = flip_first_after(&text, id_key, 0) else {
        return;
    };
    assert_eq!(
        verify_snapshot_identity(id_bad.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_ID_MISMATCH_CODE)
    );
    let Some(digest_bad) = flip_first_after(&text, digest_key, 0) else {
        return;
    };
    assert_eq!(
        verify_snapshot_identity(digest_bad.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_DIGEST_MISMATCH_CODE)
    );
    // Both wrong at once still reports the identifier first.
    let Some(both) = flip_first_after(&text, id_key, 0)
        .and_then(|id_only| flip_first_after(&id_only, digest_key, 0))
    else {
        return;
    };
    assert_eq!(
        verify_snapshot_identity(both.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_ID_MISMATCH_CODE)
    );
}

#[test]
fn verify_identifier_and_digest_shapes_are_exact() {
    let derived = derive_snapshot_identity(&base_material().into_bytes());
    assert!(derived.is_ok());
    let Ok(bytes) = derived else { return };
    let text = core::str::from_utf8(&bytes).unwrap_or("").to_owned();

    let no_id = text.replace("\"snapshot_id\":\"", "\"snapshot_idX\":\"");
    assert_eq!(
        verify_snapshot_identity(no_id.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_MISSING_FIELD_CODE)
    );
    // A digest-only document without the identifier is MissingField.
    let Some(digest_at) = text.find("\"digest\":\"") else {
        return;
    };
    let bad_digest_shape = text.split_at(digest_at).0.to_owned() + "\"digest\":\"00\"}";
    assert_eq!(
        verify_snapshot_identity(bad_digest_shape.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_MISSING_FIELD_CODE)
    );
    // Non-hex digest byte and broken ID prefix fail shapes exactly.
    let Some(digest_at) = text.find("\"digest\":\"") else {
        return;
    };
    let mut bad_digest = text.as_bytes().to_vec();
    bad_digest[digest_at + "\"digest\":\"".len()] = b'G';
    let bad_digest = core::str::from_utf8(&bad_digest).unwrap_or("").to_owned();
    let Some(id_at) = text.find("\"snapshot_id\":\"scope-") else {
        return;
    };
    let mut bad_prefix = text.as_bytes().to_vec();
    bad_prefix[id_at + "\"snapshot_id\":\"".len() + 4] = b'X';
    let bad_prefix = core::str::from_utf8(&bad_prefix).unwrap_or("").to_owned();
    for (tampered, expected) in [
        (bad_prefix, SNAPSHOT_IDENTIFIER_CODE),
        (bad_digest, SNAPSHOT_DIGEST_CODE),
    ] {
        assert_eq!(
            verify_snapshot_identity(tampered.as_bytes()).map_err(|error| error.code()),
            Err(expected),
            "tampered shape must fail closed with an exact code"
        );
    }
    // Truncated ID (47 hex) and extended ID (49 hex) are Identifier errors.
    let id_marker = "\"snapshot_id\":\"scope-";
    let Some(id_start) = text.find(id_marker) else {
        return;
    };
    let value_start = id_start + id_marker.len();
    let mut short = text.as_bytes().to_vec();
    short.remove(value_start);
    assert_eq!(
        verify_snapshot_identity(&short).map_err(|error| error.code()),
        Err(SNAPSHOT_IDENTIFIER_CODE)
    );
    let mut long = text.as_bytes().to_vec();
    long.insert(value_start, b'0');
    assert_eq!(
        verify_snapshot_identity(&long).map_err(|error| error.code()),
        Err(SNAPSHOT_IDENTIFIER_CODE)
    );
    // Flipping a payload byte breaks the identifier binding.
    let payload_bad = text.replacen(
        "\"policy_authority_ref\":\"pa1\"",
        "\"policy_authority_ref\":\"pa2\"",
        1,
    );
    assert_eq!(
        verify_snapshot_identity(payload_bad.as_bytes()).map_err(|error| error.code()),
        Err(SNAPSHOT_ID_MISMATCH_CODE)
    );
}
