//! Kill-tests for the `scope_snapshot_identity::model` survivors (S10).
//!
//! Survivors and how they die:
//! - `ScopeSnapshotIdentityExpectedError::parse` must admit every kernel code
//!   (`delete match arm`, 125:13 `ELIOTR_SNAPSHOT_INPUT_TOO_LARGE`, 133:13
//!   `ELIOTR_SNAPSHOT_NODE_LIMIT`, 135:13 `ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE`).
//!   The parser resolves `error_code` through `parse` without running the
//!   kernel, so a well-formed `error` row with each code must parse.
//! - `ScopeSnapshotIdentityVector::case_id` must return the declared id
//!   (`-> "" | "xyzzy"`, 173:9).

use eliotr_test_vectors::ScopeSnapshotIdentityVerificationError;
use eliotr_test_vectors::parse_scope_snapshot_identity_vector_set;

fn frame(row: &str) -> String {
    format!(
        "# protocol=eliotr.test-vectors.scope-snapshot-identity.v1\n\
         # schema_generation=1\n\
         # columns=case_id|operation|input_hex|expected|output_hex|error_code\n\
         {row}\n"
    )
}

fn error_row(case_id: &str, code: &str) -> String {
    frame(&format!(
        "{case_id}|derive_snapshot_identity|00|error|-|{code}"
    ))
}

#[test]
fn parse_admits_input_too_large_code() {
    let parsed = parse_scope_snapshot_identity_vector_set(&error_row(
        "err_input_too_large",
        "ELIOTR_SNAPSHOT_INPUT_TOO_LARGE",
    ));
    assert!(
        parsed.is_ok(),
        "ELIOTR_SNAPSHOT_INPUT_TOO_LARGE must parse: {:?}",
        parsed.as_ref().err()
    );
    let Ok(set) = parsed else {
        return;
    };
    assert_eq!(set.cases().len(), 1);
}

#[test]
fn parse_admits_node_limit_code() {
    let parsed = parse_scope_snapshot_identity_vector_set(&error_row(
        "err_node_limit",
        "ELIOTR_SNAPSHOT_NODE_LIMIT",
    ));
    assert!(
        parsed.is_ok(),
        "ELIOTR_SNAPSHOT_NODE_LIMIT must parse: {:?}",
        parsed.as_ref().err()
    );
    let Ok(set) = parsed else {
        return;
    };
    assert_eq!(set.cases().len(), 1);
}

#[test]
fn parse_admits_output_too_large_code() {
    let parsed = parse_scope_snapshot_identity_vector_set(&error_row(
        "err_output_too_large",
        "ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE",
    ));
    assert!(
        parsed.is_ok(),
        "ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE must parse: {:?}",
        parsed.as_ref().err()
    );
    let Ok(set) = parsed else {
        return;
    };
    assert_eq!(set.cases().len(), 1);
}

#[test]
fn vector_case_id_returns_declared_id() {
    let parsed = parse_scope_snapshot_identity_vector_set(&error_row(
        "my_case_42",
        "ELIOTR_SNAPSHOT_SYNTAX",
    ));
    assert!(
        parsed.is_ok(),
        "error row must parse: {:?}",
        parsed.as_ref().err()
    );
    let Ok(set) = parsed else {
        return;
    };
    assert_eq!(set.cases()[0].case_id(), "my_case_42");
}

#[test]
fn verification_error_display_is_not_empty() {
    // Kills `fmt -> Ok(Default::default())` (44:9): the Display impl must
    // render the case identity instead of succeeding silently.
    let err = ScopeSnapshotIdentityVerificationError::UnexpectedSuccess {
        case_id: "display_probe".to_owned(),
    };
    let rendered = format!("{err}");
    assert!(
        rendered.contains("display_probe"),
        "Display must name the case, got: {rendered:?}"
    );
}
