//! Derive, binding and replay tests for `scope-snapshot-identity.v1`.

#![forbid(unsafe_code)]

use eliotr_canonical::{
    SNAPSHOT_ID_HEX_CHARS, SNAPSHOT_ID_PREFIX, SnapshotIdentityError, derive_snapshot_identity,
    sha256, verify_snapshot_identity,
};

use super::common::{derive_ok, material_minimal, snapshot_field};

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
