//! Deterministic `scope-snapshot-identity.v1` shadow primitive.
//!
//! Mirrors the accepted TypeScript authority (`scopeSnapshotIdentityPayload`,
//! `scopeSnapshotDigestPayload`, `expectedSnapshotIdentity`): the identity payload binds
//! `protocol`, `revision`, the resolved expression, participant/owner generations, member
//! revisions, policy authority, disclosure digest, purge revision, the optional client fence
//! and both timestamps. The snapshot ID is `scope-` plus 48 lowercase hex chars of SHA-256
//! over the canonical identity bytes; the digest is SHA-256 over the canonical digest
//! payload (`snapshot_id` plus the identity payload). Keys order by UTF-16 code units.
//!
//! No scope normalization, algebra, resolution, authority, persistence, expiry or D1/R2
//! effects occur here. Callers pass explicit bytes and receive canonical bytes or a
//! content-free typed error.
//!
//! The family is split into cohesive internal modules: `error` (typed vocabulary),
//! `frame` (bounded JSON parser), `timestamp` (`datetime({ offset: true })` parity),
//! `expression` (resolved-expression shape), `material` (material admission) and
//! `emit` (canonical emission plus the single public derive/verify API).

#![forbid(unsafe_code)]

mod emit;
mod error;
mod expression;
mod frame;
mod material;
mod timestamp;

pub use emit::{derive_snapshot_identity, verify_snapshot_identity};
pub use error::{
    SNAPSHOT_DEPTH_LIMIT_CODE, SNAPSHOT_DIGEST_CODE, SNAPSHOT_DIGEST_MISMATCH_CODE,
    SNAPSHOT_DUPLICATE_KEY_CODE, SNAPSHOT_EXPRESSION_CODE, SNAPSHOT_ID_MISMATCH_CODE,
    SNAPSHOT_IDENTIFIER_CODE, SNAPSHOT_INPUT_TOO_LARGE_CODE, SNAPSHOT_MEMBER_LIMIT_CODE,
    SNAPSHOT_MISSING_FIELD_CODE, SNAPSHOT_NODE_LIMIT_CODE, SNAPSHOT_NUMBER_CODE,
    SNAPSHOT_OUTPUT_TOO_LARGE_CODE, SNAPSHOT_REVISION_CODE, SNAPSHOT_SHAPE_CODE,
    SNAPSHOT_STRING_TOO_LARGE_CODE, SNAPSHOT_SYNTAX_CODE, SNAPSHOT_TIMESTAMP_CODE,
    SNAPSHOT_UNICODE_CODE, SNAPSHOT_UNKNOWN_FIELD_CODE, SNAPSHOT_UTF8_CODE, SnapshotIdentityError,
};

/// Protocol bound into every identity payload.
pub const SNAPSHOT_IDENTITY_PROTOCOL: &str = "eliotr.scope-snapshot.v1";
/// Snapshot identifier prefix.
pub const SNAPSHOT_ID_PREFIX: &str = "scope-";
/// Hex chars retained from the identity digest in the snapshot ID.
pub const SNAPSHOT_ID_HEX_CHARS: usize = 48;
/// Exact snapshot ID length in ASCII bytes.
pub const SNAPSHOT_ID_BYTES: usize = SNAPSHOT_ID_PREFIX.len() + SNAPSHOT_ID_HEX_CHARS;
/// Maximum admitted input bytes (`MAX_CANONICAL_BYTES` in the TS service).
pub const SNAPSHOT_INPUT_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Maximum emitted canonical bytes.
pub const SNAPSHOT_OUTPUT_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Maximum decoded bytes in one JSON string.
pub const SNAPSHOT_STRING_MAX_BYTES: usize = 4096;
/// Maximum nested container depth in the frame parser.
pub const SNAPSHOT_PARSER_DEPTH_MAX: usize = 64;
/// Maximum members in one parsed object (owner records reach 50k).
pub const SNAPSHOT_OBJECT_MEMBERS_MAX: usize = 51_000;
/// Maximum items in one parsed array (member lists reach 50k).
pub const SNAPSHOT_ARRAY_ITEMS_MAX: usize = 50_000;
/// Maximum total values in one snapshot document.
pub const SNAPSHOT_NODES_MAX: usize = 250_000;
/// Largest integer represented identically by TypeScript and Rust.
pub const SNAPSHOT_SAFE_INTEGER_MAX: i64 = 9_007_199_254_740_991;
/// Maximum scope-expression nesting depth.
pub const SNAPSHOT_SCOPE_DEPTH_MAX: usize = 32;
/// Maximum scope atoms.
pub const SNAPSHOT_SCOPE_ATOMS_MAX: usize = 256;
/// Maximum selected source IDs.
pub const SNAPSHOT_SELECTED_SOURCES_MAX: usize = 1_000;
/// Maximum snapshot members.
pub const SNAPSHOT_MEMBERS_MAX: usize = 50_000;
/// Maximum participant generations (atoms plus the policy-closure binding).
pub const SNAPSHOT_PARTICIPANTS_MAX: usize = 257;
/// Maximum identifier length in JavaScript UTF-16 code units.
pub const SNAPSHOT_IDENTIFIER_MAX_UTF16: usize = 256;

#[cfg(test)]
mod tests {
    use super::{SnapshotIdentityError, derive_snapshot_identity, verify_snapshot_identity};

    fn minimal_material() -> Vec<u8> {
        br#"{"revision":1,"resolved_scope_expression":{"kind":"GLOBAL_LIBRARY"},"participant_generations":{"p1":"g1"},"member_source_revision_refs":["sr1"],"source_owner_generations":{"sr1":"og1"},"policy_authority_ref":"pa1","disclosure_closure_digest":"0000000000000000000000000000000000000000000000000000000000000000","purge_ledger_revision":0,"created_at":"2026-01-01T00:00:00.000Z","expires_at":"2026-01-01T00:15:00.000Z"}"#.to_vec()
    }

    fn material_with_timestamps(created_at: &str, expires_at: &str) -> Option<Vec<u8>> {
        let base = minimal_material();
        let text = core::str::from_utf8(&base).ok()?;
        let replaced = text
            .replace("2026-01-01T00:00:00.000Z", created_at)
            .replace("2026-01-01T00:15:00.000Z", expires_at);
        Some(replaced.into_bytes())
    }

    #[test]
    fn derive_is_stable_and_verifiable() {
        let first = derive_snapshot_identity(&minimal_material());
        let second = derive_snapshot_identity(&minimal_material());
        assert!(first.is_ok());
        assert_eq!(first, second);
        if let Ok(bytes) = first {
            assert!(verify_snapshot_identity(&bytes).is_ok());
            assert!(
                core::str::from_utf8(&bytes)
                    .unwrap_or("")
                    .contains("scope-")
            );
        }
    }

    #[test]
    fn rejects_representative_failures() {
        assert!(matches!(
            derive_snapshot_identity(b"{]"),
            Err(SnapshotIdentityError::Syntax { .. })
        ));
        assert!(matches!(
            derive_snapshot_identity(&[0xff]),
            Err(SnapshotIdentityError::InvalidUtf8 { .. })
        ));
        assert!(matches!(
            derive_snapshot_identity(b"{\"a\":1,\"a\":2}"),
            Err(SnapshotIdentityError::DuplicateKey { .. })
        ));
        assert!(matches!(
            derive_snapshot_identity(b"{\"a\":\"\\ud800\"}"),
            Err(SnapshotIdentityError::Unicode { .. })
        ));
        assert!(matches!(
            derive_snapshot_identity(b"{\"a\":1.0}"),
            Err(SnapshotIdentityError::Number { .. })
        ));
        assert!(matches!(
            derive_snapshot_identity(b"[]"),
            Err(SnapshotIdentityError::Shape)
        ));
        assert!(matches!(
            derive_snapshot_identity(b"{}"),
            Err(SnapshotIdentityError::MissingField)
        ));
        assert!(matches!(
            derive_snapshot_identity(b"{\"revision\":0,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},\"participant_generations\":{},\"member_source_revision_refs\":[],\"source_owner_generations\":{},\"policy_authority_ref\":\"p\",\"disclosure_closure_digest\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"purge_ledger_revision\":0,\"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}"),
            Err(SnapshotIdentityError::Revision)
        ));
    }

    #[test]
    fn detects_tampered_readback() {
        let derived = derive_snapshot_identity(&minimal_material());
        assert!(derived.is_ok());
        if let Ok(bytes) = derived {
            let mut tampered = bytes.clone();
            if let Some(last) = tampered.last_mut() {
                *last = if *last == b'}' { b' ' } else { b'}' };
            }
            assert!(verify_snapshot_identity(&tampered).is_err());
        }
    }

    #[test]
    fn formats_errors_without_source_bytes() {
        assert!(
            SnapshotIdentityError::IdMismatch
                .to_string()
                .contains("identifier")
        );
        assert!(
            !SnapshotIdentityError::IdMismatch
                .to_string()
                .contains("scope-")
        );
        assert_eq!(
            SnapshotIdentityError::DigestMismatch.to_string(),
            "snapshot digest does not match its payload"
        );
    }

    #[test]
    fn derive_rejects_caller_supplied_derived_keys() {
        let Ok(base) = core::str::from_utf8(&minimal_material()).map(str::to_owned) else {
            return;
        };
        let stem = base.strip_suffix('}').unwrap_or_default();
        let with_id = format!(
            "{stem},\"snapshot_id\":\"scope-000000000000000000000000000000000000000000000000\"}}"
        );
        assert_eq!(
            derive_snapshot_identity(with_id.as_bytes()),
            Err(SnapshotIdentityError::UnknownField)
        );
        let with_digest = format!(
            "{stem},\"digest\":\"0000000000000000000000000000000000000000000000000000000000000000\"}}"
        );
        assert_eq!(
            derive_snapshot_identity(with_digest.as_bytes()),
            Err(SnapshotIdentityError::UnknownField)
        );
    }

    #[test]
    fn accepts_unbounded_fractional_seconds_verbatim() {
        let Some(ten_digit) = material_with_timestamps(
            "2026-01-01T00:00:00.1234567890Z",
            "2026-01-01T00:15:00.1234567890Z",
        ) else {
            return;
        };
        let derived = derive_snapshot_identity(&ten_digit);
        assert!(derived.is_ok());
        if let Ok(bytes) = derived {
            let text = core::str::from_utf8(&bytes).unwrap_or("");
            assert!(text.contains("2026-01-01T00:00:00.1234567890Z"));
            assert!(verify_snapshot_identity(&bytes).is_ok());
        }
        let Some(offset_long) = material_with_timestamps(
            "2026-01-01T00:00:00.12345678901234567890+05:30",
            "2026-01-01T00:15:00.00000000000000000001-02:00",
        ) else {
            return;
        };
        let derived_offset = derive_snapshot_identity(&offset_long);
        assert!(derived_offset.is_ok());
        if let Ok(bytes) = derived_offset {
            assert!(verify_snapshot_identity(&bytes).is_ok());
        }
    }
}
