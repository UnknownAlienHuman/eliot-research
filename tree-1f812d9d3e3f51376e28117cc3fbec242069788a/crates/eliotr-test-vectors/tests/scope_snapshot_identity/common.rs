//! Shared helpers for the `scope-snapshot-identity.v1` integration tests.
//!
//! Single family only: `scope-snapshot-identity.v1` (ER-40). No second family.

#![forbid(unsafe_code)]

pub(crate) const DIGEST0: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub(crate) fn material_minimal() -> Vec<u8> {
    format!(
        "{{\"revision\":1,\"resolved_scope_expression\":{{\"kind\":\"GLOBAL_LIBRARY\"}},\
        \"participant_generations\":{{\"p1\":\"g1\"}},\"member_source_revision_refs\":[\"sr1\"],\
        \"source_owner_generations\":{{\"sr1\":\"og1\"}},\"policy_authority_ref\":\"pa1\",\
        \"disclosure_closure_digest\":\"{DIGEST0}\",\"purge_ledger_revision\":0,\
        \"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}}"
    )
    .into_bytes()
}

pub(crate) fn material_with_timestamps(created_at: &str, expires_at: &str) -> Option<Vec<u8>> {
    let base = material_minimal();
    let text = core::str::from_utf8(&base).ok()?;
    let replaced = text
        .replace("2026-01-01T00:00:00.000Z", created_at)
        .replace("2026-01-01T00:15:00.000Z", expires_at);
    Some(replaced.into_bytes())
}

pub(crate) fn snapshot_field(output: &[u8], key: &str) -> Option<String> {
    let text = core::str::from_utf8(output).ok()?;
    let marker = format!("\"{key}\":\"");
    let start = text.find(&marker)? + marker.len();
    let end = text[start..].find('"').map(|o| start + o)?;
    text.get(start..end).map(str::to_owned)
}

pub(crate) fn derive_ok(input: &[u8]) -> Option<Vec<u8>> {
    let result = eliotr_canonical::derive_snapshot_identity(input);
    assert!(result.is_ok());
    result.ok()
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(ALPHABET[(byte >> 4) as usize] as char);
        out.push(ALPHABET[(byte & 0x0f) as usize] as char);
    }
    out
}
