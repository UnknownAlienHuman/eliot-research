//! Material admission for `scope-snapshot-identity.v1`.
//!
//! The material holds every `ScopeSnapshot` field except the derived `snapshot_id`
//! and `digest`. Missing, extra and unknown keys fail closed; the derive entry
//! point additionally rejects caller-supplied derived keys instead of silently
//! stripping them.

#![forbid(unsafe_code)]

use super::error::SnapshotIdentityError;
use super::expression::check_expression;
use super::frame::{Value, field};
use super::timestamp::check_timestamp_shape;
use super::{
    SNAPSHOT_IDENTIFIER_MAX_UTF16, SNAPSHOT_MEMBERS_MAX, SNAPSHOT_PARTICIPANTS_MAX,
    SNAPSHOT_SAFE_INTEGER_MAX,
};

pub(crate) struct Material<'a> {
    pub(crate) members: &'a [(String, Value)],
}

pub(crate) fn check_material(
    members: &[(String, Value)],
) -> Result<Material<'_>, SnapshotIdentityError> {
    for (name, _) in members {
        if !matches!(
            name.as_str(),
            "revision"
                | "resolved_scope_expression"
                | "participant_generations"
                | "member_source_revision_refs"
                | "source_owner_generations"
                | "policy_authority_ref"
                | "disclosure_closure_digest"
                | "purge_ledger_revision"
                | "client_fence_ref"
                | "created_at"
                | "expires_at"
                | "snapshot_id"
                | "digest"
        ) {
            return Err(SnapshotIdentityError::UnknownField);
        }
    }
    let require = |key: &str| field(members, key).ok_or(SnapshotIdentityError::MissingField);
    let revision = require("revision")?
        .as_integer()
        .ok_or(SnapshotIdentityError::Shape)?;
    if !(1..=SNAPSHOT_SAFE_INTEGER_MAX).contains(&revision) {
        return Err(SnapshotIdentityError::Revision);
    }
    check_expression(require("resolved_scope_expression")?)?;
    check_identifier_record(
        require("participant_generations")?,
        SNAPSHOT_PARTICIPANTS_MAX,
    )?;
    let member_items = require("member_source_revision_refs")?
        .as_array()
        .ok_or(SnapshotIdentityError::Shape)?;
    if member_items.len() > SNAPSHOT_MEMBERS_MAX {
        return Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_MEMBERS_MAX,
        });
    }
    for item in member_items {
        check_identifier_shape(item.as_str().ok_or(SnapshotIdentityError::Shape)?)?;
    }
    check_identifier_record(require("source_owner_generations")?, SNAPSHOT_MEMBERS_MAX)?;
    check_identifier_shape(
        require("policy_authority_ref")?
            .as_str()
            .ok_or(SnapshotIdentityError::Shape)?,
    )?;
    check_digest_shape(
        require("disclosure_closure_digest")?
            .as_str()
            .ok_or(SnapshotIdentityError::Shape)?,
    )?;
    // Purge revisions share the safe-integer envelope; negatives and non-integers fail here.
    // A purge value is a ledger position, while `revision` is the snapshot generation, so each
    // keeps its own typed error for content-free diagnosis.
    let purge = require("purge_ledger_revision")?
        .as_integer()
        .ok_or(SnapshotIdentityError::Shape)?;
    if !(0..=SNAPSHOT_SAFE_INTEGER_MAX).contains(&purge) {
        return Err(SnapshotIdentityError::Revision);
    }
    if let Some(fence) = field(members, "client_fence_ref") {
        check_identifier_shape(fence.as_str().ok_or(SnapshotIdentityError::Shape)?)?;
    }
    check_timestamp_shape(
        require("created_at")?
            .as_str()
            .ok_or(SnapshotIdentityError::Shape)?,
    )?;
    check_timestamp_shape(
        require("expires_at")?
            .as_str()
            .ok_or(SnapshotIdentityError::Shape)?,
    )?;
    Ok(Material { members })
}

/// Rejects caller-supplied derived keys in derive input, fail-closed with no output.
///
/// The TypeScript authority strips extra keys when building identity payloads; the M2
/// derive path must not silently discard a caller-supplied `snapshot_id` or `digest`,
/// so their presence is an unknown-field rejection. Verification still requires both
/// derived members and is unaffected.
pub(crate) fn reject_derived_keys(
    members: &[(String, Value)],
) -> Result<(), SnapshotIdentityError> {
    if field(members, "snapshot_id").is_some() || field(members, "digest").is_some() {
        return Err(SnapshotIdentityError::UnknownField);
    }
    Ok(())
}

pub(crate) fn check_identifier_record(
    value: &Value,
    max_members: usize,
) -> Result<(), SnapshotIdentityError> {
    let members = value.as_object().ok_or(SnapshotIdentityError::Shape)?;
    if members.len() > max_members {
        return Err(SnapshotIdentityError::MemberLimit { max_members });
    }
    for (key, member) in members {
        check_identifier_shape(key)?;
        check_identifier_shape(member.as_str().ok_or(SnapshotIdentityError::Shape)?)?;
    }
    Ok(())
}

pub(crate) fn check_identifier_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    let units = text.encode_utf16().count();
    if units == 0 || units > SNAPSHOT_IDENTIFIER_MAX_UTF16 {
        return Err(SnapshotIdentityError::Identifier);
    }
    Ok(())
}

pub(crate) fn check_identifier_shape_for_expression(
    text: &str,
) -> Result<(), SnapshotIdentityError> {
    check_identifier_shape(text).map_err(|_| SnapshotIdentityError::Expression)
}

pub(crate) fn check_digest_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(SnapshotIdentityError::Digest);
    }
    Ok(())
}

pub(crate) fn check_snapshot_id_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    if text.len() != super::SNAPSHOT_ID_BYTES
        || !text.starts_with(super::SNAPSHOT_ID_PREFIX)
        || !text[super::SNAPSHOT_ID_PREFIX.len()..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(SnapshotIdentityError::Identifier);
    }
    Ok(())
}
