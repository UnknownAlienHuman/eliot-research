//! Corpus, parser and vocabulary tests for `scope-snapshot-identity.v1`.

#![forbid(unsafe_code)]

use eliotr_canonical::SnapshotIdentityError;
use eliotr_test_vectors::{
    EMBEDDED_SCOPE_SNAPSHOT_IDENTITY_VECTORS, SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER,
    SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER, ScopeSnapshotIdentityExpectedError,
    ScopeSnapshotIdentityOperation, ScopeSnapshotIdentityVerificationError,
    parse_scope_snapshot_identity_vector_set, verify_embedded_scope_snapshot_identity_vectors,
    verify_scope_snapshot_identity_vector_set,
};

use super::common::{derive_ok, material_minimal, to_hex};

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
    assert_eq!(set.cases().len(), 135);
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
