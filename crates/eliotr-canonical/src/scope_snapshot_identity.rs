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

#![forbid(unsafe_code)]

use core::cmp::Ordering;
use core::fmt;
use std::collections::BTreeSet;

use crate::sha256::sha256;

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

pub const SNAPSHOT_INPUT_TOO_LARGE_CODE: &str = "ELIOTR_SNAPSHOT_INPUT_TOO_LARGE";
pub const SNAPSHOT_UTF8_CODE: &str = "ELIOTR_SNAPSHOT_UTF8";
pub const SNAPSHOT_SYNTAX_CODE: &str = "ELIOTR_SNAPSHOT_SYNTAX";
pub const SNAPSHOT_DUPLICATE_KEY_CODE: &str = "ELIOTR_SNAPSHOT_DUPLICATE_KEY";
pub const SNAPSHOT_UNICODE_CODE: &str = "ELIOTR_SNAPSHOT_UNICODE";
pub const SNAPSHOT_NUMBER_CODE: &str = "ELIOTR_SNAPSHOT_NUMBER";
pub const SNAPSHOT_DEPTH_LIMIT_CODE: &str = "ELIOTR_SNAPSHOT_DEPTH_LIMIT";
pub const SNAPSHOT_MEMBER_LIMIT_CODE: &str = "ELIOTR_SNAPSHOT_MEMBER_LIMIT";
pub const SNAPSHOT_NODE_LIMIT_CODE: &str = "ELIOTR_SNAPSHOT_NODE_LIMIT";
pub const SNAPSHOT_STRING_TOO_LARGE_CODE: &str = "ELIOTR_SNAPSHOT_STRING_TOO_LARGE";
pub const SNAPSHOT_OUTPUT_TOO_LARGE_CODE: &str = "ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE";
pub const SNAPSHOT_SHAPE_CODE: &str = "ELIOTR_SNAPSHOT_SHAPE";
pub const SNAPSHOT_MISSING_FIELD_CODE: &str = "ELIOTR_SNAPSHOT_MISSING_FIELD";
pub const SNAPSHOT_UNKNOWN_FIELD_CODE: &str = "ELIOTR_SNAPSHOT_UNKNOWN_FIELD";
pub const SNAPSHOT_IDENTIFIER_CODE: &str = "ELIOTR_SNAPSHOT_IDENTIFIER";
pub const SNAPSHOT_DIGEST_CODE: &str = "ELIOTR_SNAPSHOT_DIGEST";
pub const SNAPSHOT_REVISION_CODE: &str = "ELIOTR_SNAPSHOT_REVISION";
pub const SNAPSHOT_TIMESTAMP_CODE: &str = "ELIOTR_SNAPSHOT_TIMESTAMP";
pub const SNAPSHOT_EXPRESSION_CODE: &str = "ELIOTR_SNAPSHOT_EXPRESSION";
pub const SNAPSHOT_ID_MISMATCH_CODE: &str = "ELIOTR_SNAPSHOT_ID_MISMATCH";
pub const SNAPSHOT_DIGEST_MISMATCH_CODE: &str = "ELIOTR_SNAPSHOT_DIGEST_MISMATCH";

/// Deterministic, content-free snapshot-identity rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotIdentityError {
    InputTooLarge {
        actual_bytes: usize,
        max_bytes: usize,
    },
    InvalidUtf8 {
        valid_up_to: usize,
    },
    Syntax {
        offset: usize,
    },
    DuplicateKey {
        offset: usize,
    },
    Unicode {
        offset: usize,
    },
    Number {
        offset: usize,
    },
    DepthLimit {
        max_depth: usize,
    },
    MemberLimit {
        max_members: usize,
    },
    NodeLimit {
        max_nodes: usize,
    },
    StringTooLarge {
        max_bytes: usize,
    },
    OutputTooLarge {
        max_bytes: usize,
    },
    Shape,
    MissingField,
    UnknownField,
    Identifier,
    Digest,
    Revision,
    Timestamp,
    Expression,
    IdMismatch,
    DigestMismatch,
}

impl SnapshotIdentityError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge { .. } => SNAPSHOT_INPUT_TOO_LARGE_CODE,
            Self::InvalidUtf8 { .. } => SNAPSHOT_UTF8_CODE,
            Self::Syntax { .. } => SNAPSHOT_SYNTAX_CODE,
            Self::DuplicateKey { .. } => SNAPSHOT_DUPLICATE_KEY_CODE,
            Self::Unicode { .. } => SNAPSHOT_UNICODE_CODE,
            Self::Number { .. } => SNAPSHOT_NUMBER_CODE,
            Self::DepthLimit { .. } => SNAPSHOT_DEPTH_LIMIT_CODE,
            Self::MemberLimit { .. } => SNAPSHOT_MEMBER_LIMIT_CODE,
            Self::NodeLimit { .. } => SNAPSHOT_NODE_LIMIT_CODE,
            Self::StringTooLarge { .. } => SNAPSHOT_STRING_TOO_LARGE_CODE,
            Self::OutputTooLarge { .. } => SNAPSHOT_OUTPUT_TOO_LARGE_CODE,
            Self::Shape => SNAPSHOT_SHAPE_CODE,
            Self::MissingField => SNAPSHOT_MISSING_FIELD_CODE,
            Self::UnknownField => SNAPSHOT_UNKNOWN_FIELD_CODE,
            Self::Identifier => SNAPSHOT_IDENTIFIER_CODE,
            Self::Digest => SNAPSHOT_DIGEST_CODE,
            Self::Revision => SNAPSHOT_REVISION_CODE,
            Self::Timestamp => SNAPSHOT_TIMESTAMP_CODE,
            Self::Expression => SNAPSHOT_EXPRESSION_CODE,
            Self::IdMismatch => SNAPSHOT_ID_MISMATCH_CODE,
            Self::DigestMismatch => SNAPSHOT_DIGEST_MISMATCH_CODE,
        }
    }
}

impl fmt::Display for SnapshotIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                f,
                "snapshot input has {actual_bytes} bytes; maximum is {max_bytes}"
            ),
            Self::InvalidUtf8 { valid_up_to } => write!(
                f,
                "snapshot input is invalid after byte offset {valid_up_to}"
            ),
            Self::Syntax { offset } => {
                write!(f, "snapshot JSON syntax error at byte offset {offset}")
            }
            Self::DuplicateKey { offset } => write!(
                f,
                "snapshot JSON duplicate object key at byte offset {offset}"
            ),
            Self::Unicode { offset } => write!(
                f,
                "snapshot JSON Unicode escape is invalid at byte offset {offset}"
            ),
            Self::Number { offset } => write!(
                f,
                "snapshot JSON number is unsupported at byte offset {offset}"
            ),
            Self::DepthLimit { max_depth } => {
                write!(f, "snapshot JSON nesting exceeds maximum depth {max_depth}")
            }
            Self::MemberLimit { max_members } => {
                write!(f, "snapshot member count exceeds maximum {max_members}")
            }
            Self::NodeLimit { max_nodes } => write!(
                f,
                "snapshot JSON value exceeds maximum node count {max_nodes}"
            ),
            Self::StringTooLarge { max_bytes } => write!(
                f,
                "snapshot JSON string exceeds maximum decoded size {max_bytes}"
            ),
            Self::OutputTooLarge { max_bytes } => write!(
                f,
                "snapshot canonical output exceeds maximum size {max_bytes}"
            ),
            Self::Shape => write!(f, "snapshot value has the wrong shape"),
            Self::MissingField => write!(f, "snapshot object is missing a field"),
            Self::UnknownField => write!(f, "snapshot object contains an unknown field"),
            Self::Identifier => write!(f, "snapshot identifier is invalid"),
            Self::Digest => write!(f, "snapshot digest is invalid"),
            Self::Revision => write!(f, "snapshot revision is invalid"),
            Self::Timestamp => write!(f, "snapshot timestamp is invalid"),
            Self::Expression => write!(f, "snapshot scope expression is invalid"),
            Self::IdMismatch => write!(f, "snapshot identifier does not match its payload"),
            Self::DigestMismatch => write!(f, "snapshot digest does not match its payload"),
        }
    }
}

impl std::error::Error for SnapshotIdentityError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Null,
    Boolean(bool),
    Integer(i64),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

impl Value {
    fn as_object(&self) -> Option<&[(String, Self)]> {
        match self {
            Self::Object(m) => Some(m),
            _ => None,
        }
    }
    fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(v) => Some(v),
            _ => None,
        }
    }
    fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }
    fn as_integer(&self) -> Option<i64> {
        match self {
            Self::Integer(n) => Some(*n),
            _ => None,
        }
    }
}

fn field<'a>(members: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    members
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

/// Derives complete canonical snapshot bytes from material JSON bytes.
///
/// The material holds every `ScopeSnapshot` field except `snapshot_id` and `digest`. The
/// output is the canonical full snapshot (derived ID and digest included, UTF-16 key order).
///
/// # Errors
///
/// Returns a typed, content-free error for oversized, non-UTF-8, malformed or invalid input.
pub fn derive_snapshot_identity(material: &[u8]) -> Result<Vec<u8>, SnapshotIdentityError> {
    let root = parse_frame(material)?;
    let members = root.as_object().ok_or(SnapshotIdentityError::Shape)?;
    let parsed = check_material(members)?;
    emit_full_snapshot(&parsed)
}

/// Verifies a complete snapshot document and returns its canonical bytes.
///
/// # Errors
///
/// Returns `IdMismatch` when the recomputed ID differs, `DigestMismatch` when only the
/// digest differs, or a typed content-free error for malformed input.
pub fn verify_snapshot_identity(snapshot: &[u8]) -> Result<Vec<u8>, SnapshotIdentityError> {
    let root = parse_frame(snapshot)?;
    let members = root.as_object().ok_or(SnapshotIdentityError::Shape)?;
    let declared_id = field(members, "snapshot_id")
        .and_then(Value::as_str)
        .ok_or(SnapshotIdentityError::MissingField)?;
    let declared_digest = field(members, "digest")
        .and_then(Value::as_str)
        .ok_or(SnapshotIdentityError::MissingField)?;
    check_snapshot_id_shape(declared_id)?;
    check_digest_shape(declared_digest)?;
    let parsed = check_material(members)?;
    let expected = emit_full_snapshot(&parsed)?;
    let (expected_id, expected_digest) = split_snapshot_output(&expected)?;
    if expected_id != declared_id {
        return Err(SnapshotIdentityError::IdMismatch);
    }
    if expected_digest != declared_digest {
        return Err(SnapshotIdentityError::DigestMismatch);
    }
    Ok(expected)
}

struct Material<'a> {
    members: &'a [(String, Value)],
}

fn check_material(members: &[(String, Value)]) -> Result<Material<'_>, SnapshotIdentityError> {
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

fn check_identifier_record(value: &Value, max_members: usize) -> Result<(), SnapshotIdentityError> {
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

fn check_identifier_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    let units = text.encode_utf16().count();
    if units == 0 || units > SNAPSHOT_IDENTIFIER_MAX_UTF16 {
        return Err(SnapshotIdentityError::Identifier);
    }
    Ok(())
}

fn check_digest_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(SnapshotIdentityError::Digest);
    }
    Ok(())
}

fn check_snapshot_id_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    if text.len() != SNAPSHOT_ID_BYTES
        || !text.starts_with(SNAPSHOT_ID_PREFIX)
        || !text[SNAPSHOT_ID_PREFIX.len()..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(SnapshotIdentityError::Identifier);
    }
    Ok(())
}

fn check_timestamp_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    parse_timestamp(text).ok_or(SnapshotIdentityError::Timestamp)
}

/// Accepts the `datetime({ offset: true })` envelope: `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`.
fn parse_timestamp(text: &str) -> Option<()> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes.len() > 64 || bytes.get(10) != Some(&b'T') {
        return None;
    }
    let date = bytes.get(..10)?;
    if date[4] != b'-' || date[7] != b'-' {
        return None;
    }
    if !(1..=12).contains(&digits(date.get(5..7)?)?)
        || !(1..=31).contains(&digits(date.get(8..10)?)?)
    {
        return None;
    }
    let rest = bytes.get(11..)?;
    if rest.len() < 8 {
        return None;
    }
    let time = rest.get(..8)?;
    if time[2] != b':' || time[5] != b':' {
        return None;
    }
    if digits(time.get(..2)?)? > 23
        || digits(time.get(3..5)?)? > 59
        || digits(time.get(6..8)?)? > 59
    {
        return None;
    }
    let mut zone = rest.get(8..)?;
    if zone.first() == Some(&b'.') {
        zone = zone.get(1..)?;
        let mut frac = 0_usize;
        while zone.first().is_some_and(|b| b.is_ascii_digit()) {
            zone = zone.get(1..)?;
            frac += 1;
            if frac > 9 {
                return None;
            }
        }
        if frac == 0 {
            return None;
        }
    }
    if zone == b"Z" {
        return Some(());
    }
    if zone.len() == 6 && (zone[0] == b'+' || zone[0] == b'-') && zone[3] == b':' {
        if digits(zone.get(1..3)?)? > 23 || digits(zone.get(4..6)?)? > 59 {
            return None;
        }
        return Some(());
    }
    None
}

fn digits(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut value = 0_u32;
    for b in bytes {
        value = value.checked_mul(10)?.checked_add(u32::from(*b - b'0'))?;
    }
    Some(value)
}

struct ExprMetrics {
    depth: usize,
    atoms: usize,
    selected: usize,
}

fn check_expression(value: &Value) -> Result<(), SnapshotIdentityError> {
    let mut metrics = ExprMetrics {
        depth: 0,
        atoms: 0,
        selected: 0,
    };
    walk_expression(value, 1, &mut metrics)?;
    if metrics.depth > SNAPSHOT_SCOPE_DEPTH_MAX
        || metrics.atoms > SNAPSHOT_SCOPE_ATOMS_MAX
        || metrics.selected > SNAPSHOT_SELECTED_SOURCES_MAX
    {
        return Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_SCOPE_ATOMS_MAX,
        });
    }
    Ok(())
}

fn walk_expression(
    value: &Value,
    depth: usize,
    metrics: &mut ExprMetrics,
) -> Result<(), SnapshotIdentityError> {
    if depth > metrics.depth {
        metrics.depth = depth;
    }
    if depth > SNAPSHOT_SCOPE_DEPTH_MAX {
        return Err(SnapshotIdentityError::Expression);
    }
    let members = value.as_object().ok_or(SnapshotIdentityError::Expression)?;
    let kind = field(members, "kind")
        .and_then(Value::as_str)
        .ok_or(SnapshotIdentityError::Expression)?;
    let atom_id = |key: &str| {
        let text = field(members, key)
            .and_then(Value::as_str)
            .ok_or(SnapshotIdentityError::Expression)?;
        check_identifier_shape(text).map_err(|_| SnapshotIdentityError::Expression)
    };
    match kind {
        "GLOBAL_LIBRARY" => {
            if members.len() != 1 {
                return Err(SnapshotIdentityError::Expression);
            }
        }
        "PROJECT" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            atom_id("project_id")?;
        }
        "SELECTED_SOURCES" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            let ids = field(members, "source_ids")
                .and_then(Value::as_array)
                .ok_or(SnapshotIdentityError::Expression)?;
            if ids.is_empty() {
                return Err(SnapshotIdentityError::Expression);
            }
            for id in ids {
                check_identifier_shape(id.as_str().ok_or(SnapshotIdentityError::Expression)?)
                    .map_err(|_| SnapshotIdentityError::Expression)?;
            }
            metrics.selected = metrics.selected.saturating_add(ids.len());
        }
        "SOURCE_CLASS" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            atom_id("source_class")?;
        }
        "TAG" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            atom_id("tag")?;
        }
        "UNION" | "INTERSECT" | "EXCEPT" => {
            if members.len() != 3 {
                return Err(SnapshotIdentityError::Expression);
            }
            walk_expression(
                field(members, "left").ok_or(SnapshotIdentityError::Expression)?,
                depth + 1,
                metrics,
            )?;
            walk_expression(
                field(members, "right").ok_or(SnapshotIdentityError::Expression)?,
                depth + 1,
                metrics,
            )?;
            return Ok(());
        }
        _ => return Err(SnapshotIdentityError::Expression),
    }
    metrics.atoms = metrics.atoms.saturating_add(1);
    Ok(())
}

fn emit_full_snapshot(parsed: &Material<'_>) -> Result<Vec<u8>, SnapshotIdentityError> {
    let protocol = Value::String(SNAPSHOT_IDENTITY_PROTOCOL.to_owned());
    let mut identity: Vec<(&str, &Value)> = Vec::with_capacity(parsed.members.len() + 1);
    identity.push(("protocol", &protocol));
    for (name, value) in parsed.members {
        if name == "snapshot_id" || name == "digest" {
            continue;
        }
        identity.push((name.as_str(), value));
    }
    let identity_bytes = write_canonical(&identity)?;
    let snapshot_id = format_snapshot_id(&sha256(&identity_bytes));
    let owned_id = Value::String(snapshot_id);
    let mut digest_fields: Vec<(&str, &Value)> = Vec::with_capacity(identity.len() + 1);
    digest_fields.push(("snapshot_id", &owned_id));
    for entry in &identity {
        digest_fields.push(*entry);
    }
    let digest_hex = to_hex(&sha256(&write_canonical(&digest_fields)?));
    let owned_digest = Value::String(digest_hex);
    let mut full: Vec<(&str, &Value)> = Vec::with_capacity(parsed.members.len() + 2);
    for (name, value) in parsed.members {
        if name == "snapshot_id" || name == "digest" {
            continue;
        }
        full.push((name.as_str(), value));
    }
    full.push(("snapshot_id", &owned_id));
    full.push(("digest", &owned_digest));
    write_canonical(&full)
}

fn split_snapshot_output(bytes: &[u8]) -> Result<(&str, &str), SnapshotIdentityError> {
    let text = core::str::from_utf8(bytes).map_err(|_| SnapshotIdentityError::Shape)?;
    let id_key = "\"snapshot_id\":\"";
    let digest_key = "\"digest\":\"";
    let id_start = text.find(id_key).ok_or(SnapshotIdentityError::Shape)? + id_key.len();
    let id_end = text
        .get(id_start..)
        .and_then(|r| r.find('"'))
        .map(|o| id_start + o)
        .ok_or(SnapshotIdentityError::Shape)?;
    let digest_start =
        text.find(digest_key).ok_or(SnapshotIdentityError::Shape)? + digest_key.len();
    let digest_end = text
        .get(digest_start..)
        .and_then(|r| r.find('"'))
        .map(|o| digest_start + o)
        .ok_or(SnapshotIdentityError::Shape)?;
    Ok((
        text.get(id_start..id_end)
            .ok_or(SnapshotIdentityError::Shape)?,
        text.get(digest_start..digest_end)
            .ok_or(SnapshotIdentityError::Shape)?,
    ))
}

fn format_snapshot_id(digest: &[u8; 32]) -> String {
    let hex = to_hex(digest);
    let mut out = String::with_capacity(SNAPSHOT_ID_BYTES);
    out.push_str(SNAPSHOT_ID_PREFIX);
    out.push_str(&hex[..SNAPSHOT_ID_HEX_CHARS]);
    out
}

fn to_hex(digest: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(char::from(lower_hex(byte >> 4)));
        out.push(char::from(lower_hex(byte & 0x0f)));
    }
    out
}

const fn lower_hex(nibble: u8) -> u8 {
    match nibble {
        0..=9 => b'0' + nibble,
        _ => b'a' + (nibble - 10),
    }
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn write_canonical(fields: &[(&str, &Value)]) -> Result<Vec<u8>, SnapshotIdentityError> {
    let mut sorted: Vec<(&str, &Value)> = fields.to_vec();
    sorted.sort_by(|left, right| compare_utf16(left.0, right.0));
    let mut writer = SnapshotWriter::new();
    writer.write_object(&sorted)?;
    Ok(writer.finish())
}

struct SnapshotWriter {
    output: Vec<u8>,
}

impl SnapshotWriter {
    fn new() -> Self {
        Self { output: Vec::new() }
    }
    fn finish(self) -> Vec<u8> {
        self.output
    }
    fn push_bytes(&mut self, bytes: &[u8]) -> Result<(), SnapshotIdentityError> {
        if self.output.len().saturating_add(bytes.len()) > SNAPSHOT_OUTPUT_MAX_BYTES {
            return Err(SnapshotIdentityError::OutputTooLarge {
                max_bytes: SNAPSHOT_OUTPUT_MAX_BYTES,
            });
        }
        self.output.extend_from_slice(bytes);
        Ok(())
    }
    fn push_byte(&mut self, byte: u8) -> Result<(), SnapshotIdentityError> {
        self.push_bytes(&[byte])
    }
    fn write_value(&mut self, value: &Value) -> Result<(), SnapshotIdentityError> {
        match value {
            Value::Null => self.push_bytes(b"null"),
            Value::Boolean(true) => self.push_bytes(b"true"),
            Value::Boolean(false) => self.push_bytes(b"false"),
            Value::Integer(n) => self.push_bytes(n.to_string().as_bytes()),
            Value::String(s) => self.write_string(s),
            Value::Array(items) => {
                self.push_byte(b'[')?;
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        self.push_byte(b',')?;
                    }
                    self.write_value(item)?;
                }
                self.push_byte(b']')
            }
            Value::Object(members) => {
                let mut sorted: Vec<(&str, &Value)> =
                    members.iter().map(|(k, v)| (k.as_str(), v)).collect();
                sorted.sort_by(|a, b| compare_utf16(a.0, b.0));
                self.write_object(&sorted)
            }
        }
    }
    fn write_object(&mut self, fields: &[(&str, &Value)]) -> Result<(), SnapshotIdentityError> {
        self.push_byte(b'{')?;
        for (i, (key, value)) in fields.iter().enumerate() {
            if i > 0 {
                self.push_byte(b',')?;
            }
            self.write_string(key)?;
            self.push_byte(b':')?;
            self.write_value(value)?;
        }
        self.push_byte(b'}')
    }
    fn write_string(&mut self, text: &str) -> Result<(), SnapshotIdentityError> {
        self.push_byte(b'"')?;
        for byte in text.as_bytes() {
            match *byte {
                b'"' => self.push_bytes(b"\\\""),
                b'\\' => self.push_bytes(b"\\\\"),
                0x08 => self.push_bytes(b"\\b"),
                0x09 => self.push_bytes(b"\\t"),
                0x0a => self.push_bytes(b"\\n"),
                0x0c => self.push_bytes(b"\\f"),
                0x0d => self.push_bytes(b"\\r"),
                0x00..=0x1f => self.push_bytes(&[
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    lower_hex(byte >> 4),
                    lower_hex(byte & 0x0f),
                ]),
                _ => self.push_byte(*byte),
            }?;
        }
        self.push_byte(b'"')
    }
}

struct FrameParser<'a> {
    input: &'a [u8],
    cursor: usize,
    nodes: usize,
}

fn parse_frame(input: &[u8]) -> Result<Value, SnapshotIdentityError> {
    if input.len() > SNAPSHOT_INPUT_MAX_BYTES {
        return Err(SnapshotIdentityError::InputTooLarge {
            actual_bytes: input.len(),
            max_bytes: SNAPSHOT_INPUT_MAX_BYTES,
        });
    }
    core::str::from_utf8(input).map_err(|e| SnapshotIdentityError::InvalidUtf8 {
        valid_up_to: e.valid_up_to(),
    })?;
    let mut parser = FrameParser {
        input,
        cursor: 0,
        nodes: 0,
    };
    parser.skip_ws();
    let value = parser.parse_value(0)?;
    parser.skip_ws();
    if parser.cursor != input.len() {
        return Err(SnapshotIdentityError::Syntax {
            offset: parser.cursor,
        });
    }
    Ok(value)
}

impl FrameParser<'_> {
    fn parse_value(&mut self, depth: usize) -> Result<Value, SnapshotIdentityError> {
        if self.nodes >= SNAPSHOT_NODES_MAX {
            return Err(SnapshotIdentityError::NodeLimit {
                max_nodes: SNAPSHOT_NODES_MAX,
            });
        }
        self.nodes += 1;
        match self.peek() {
            Some(b'n') => self.literal(b"null", Value::Null),
            Some(b't') => self.literal(b"true", Value::Boolean(true)),
            Some(b'f') => self.literal(b"false", Value::Boolean(false)),
            Some(b'"') => self.parse_string().map(Value::String),
            Some(b'[') => self.parse_array(depth),
            Some(b'{') => self.parse_object(depth),
            Some(b'-' | b'0'..=b'9') => self.parse_integer().map(Value::Integer),
            _ => Err(self.syntax()),
        }
    }
    fn literal(&mut self, literal: &[u8], value: Value) -> Result<Value, SnapshotIdentityError> {
        let end = self.cursor.saturating_add(literal.len());
        if self.input.get(self.cursor..end) != Some(literal) {
            return Err(self.syntax());
        }
        self.cursor = end;
        Ok(value)
    }
    fn parse_array(&mut self, depth: usize) -> Result<Value, SnapshotIdentityError> {
        self.enter(depth)?;
        self.cursor += 1;
        self.skip_ws();
        let mut values = Vec::new();
        if self.eat(b']') {
            return Ok(Value::Array(values));
        }
        loop {
            if values.len() >= SNAPSHOT_ARRAY_ITEMS_MAX {
                return Err(SnapshotIdentityError::MemberLimit {
                    max_members: SNAPSHOT_ARRAY_ITEMS_MAX,
                });
            }
            values.push(self.parse_value(depth + 1)?);
            self.skip_ws();
            if self.eat(b']') {
                break;
            }
            if !self.eat(b',') {
                return Err(self.syntax());
            }
            self.skip_ws();
        }
        Ok(Value::Array(values))
    }
    fn parse_object(&mut self, depth: usize) -> Result<Value, SnapshotIdentityError> {
        self.enter(depth)?;
        self.cursor += 1;
        self.skip_ws();
        let mut members = Vec::new();
        let mut keys = BTreeSet::new();
        if self.eat(b'}') {
            return Ok(Value::Object(members));
        }
        loop {
            if members.len() >= SNAPSHOT_OBJECT_MEMBERS_MAX {
                return Err(SnapshotIdentityError::MemberLimit {
                    max_members: SNAPSHOT_OBJECT_MEMBERS_MAX,
                });
            }
            let key_offset = self.cursor;
            if self.peek() != Some(b'"') {
                return Err(self.syntax());
            }
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(SnapshotIdentityError::DuplicateKey { offset: key_offset });
            }
            self.skip_ws();
            if !self.eat(b':') {
                return Err(self.syntax());
            }
            self.skip_ws();
            let value = self.parse_value(depth + 1)?;
            members.push((key, value));
            self.skip_ws();
            if self.eat(b'}') {
                break;
            }
            if !self.eat(b',') {
                return Err(self.syntax());
            }
            self.skip_ws();
        }
        members.sort_by(|a, b| compare_utf16(a.0.as_str(), b.0.as_str()));
        Ok(Value::Object(members))
    }
    fn enter(&self, depth: usize) -> Result<(), SnapshotIdentityError> {
        if depth >= SNAPSHOT_PARSER_DEPTH_MAX {
            return Err(SnapshotIdentityError::DepthLimit {
                max_depth: SNAPSHOT_PARSER_DEPTH_MAX,
            });
        }
        Ok(())
    }
    fn parse_integer(&mut self) -> Result<i64, SnapshotIdentityError> {
        let start = self.cursor;
        let negative = self.eat(b'-');
        let digits_start = self.cursor;
        match self.peek() {
            Some(b'0') => {
                self.cursor += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(SnapshotIdentityError::Number { offset: start });
                }
            }
            Some(b'1'..=b'9') => {
                self.cursor += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.cursor += 1;
                }
            }
            _ => return Err(SnapshotIdentityError::Number { offset: start }),
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(SnapshotIdentityError::Number { offset: start });
        }
        let mut magnitude = 0_i64;
        let raw = self
            .input
            .get(digits_start..self.cursor)
            .ok_or(SnapshotIdentityError::Number { offset: start })?;
        for byte in raw {
            let digit = i64::from(*byte - b'0');
            if magnitude > (SNAPSHOT_SAFE_INTEGER_MAX - digit) / 10 {
                return Err(SnapshotIdentityError::Number { offset: start });
            }
            magnitude = magnitude * 10 + digit;
        }
        if negative && magnitude == 0 {
            return Err(SnapshotIdentityError::Number { offset: start });
        }
        Ok(if negative { -magnitude } else { magnitude })
    }
    fn parse_string(&mut self) -> Result<String, SnapshotIdentityError> {
        let start = self.cursor;
        if !self.eat(b'"') {
            return Err(self.syntax());
        }
        let mut out = Vec::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err(SnapshotIdentityError::Syntax { offset: start });
            };
            match byte {
                b'"' => {
                    self.cursor += 1;
                    return String::from_utf8(out)
                        .map_err(|_| SnapshotIdentityError::Unicode { offset: start });
                }
                b'\\' => {
                    self.cursor += 1;
                    self.escape(&mut out)?;
                }
                0x00..=0x1f => return Err(self.syntax()),
                0x20..=0x7f => {
                    self.cursor += 1;
                    push_str_byte(&mut out, &[byte])?;
                }
                _ => {
                    let Some(width) = utf8_width(byte) else {
                        return Err(SnapshotIdentityError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    let end = self.cursor.saturating_add(width);
                    let Some(bytes) = self.input.get(self.cursor..end) else {
                        return Err(SnapshotIdentityError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    push_str_byte(&mut out, bytes)?;
                    self.cursor = end;
                }
            }
        }
    }
    fn escape(&mut self, out: &mut Vec<u8>) -> Result<(), SnapshotIdentityError> {
        let offset = self.cursor.saturating_sub(1);
        let Some(esc) = self.peek() else {
            return Err(SnapshotIdentityError::Syntax { offset });
        };
        self.cursor += 1;
        match esc {
            b'"' => push_str_byte(out, b"\""),
            b'\\' => push_str_byte(out, b"\\"),
            b'/' => push_str_byte(out, b"/"),
            b'b' => push_str_byte(out, &[0x08]),
            b'f' => push_str_byte(out, &[0x0c]),
            b'n' => push_str_byte(out, b"\n"),
            b'r' => push_str_byte(out, b"\r"),
            b't' => push_str_byte(out, b"\t"),
            b'u' => self.unicode_escape(out, offset),
            _ => Err(SnapshotIdentityError::Syntax { offset }),
        }
    }
    fn unicode_escape(
        &mut self,
        out: &mut Vec<u8>,
        offset: usize,
    ) -> Result<(), SnapshotIdentityError> {
        let first = self.hex_quad(offset)?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.input.get(self.cursor..self.cursor.saturating_add(2)) != Some(b"\\u") {
                return Err(SnapshotIdentityError::Unicode { offset });
            }
            self.cursor += 2;
            let second = self.hex_quad(offset)?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(SnapshotIdentityError::Unicode { offset });
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err(SnapshotIdentityError::Unicode { offset });
        } else {
            u32::from(first)
        };
        let Some(ch) = char::from_u32(scalar) else {
            return Err(SnapshotIdentityError::Unicode { offset });
        };
        let mut encoded = [0_u8; 4];
        push_str_byte(out, ch.encode_utf8(&mut encoded).as_bytes())
    }
    fn hex_quad(&mut self, offset: usize) -> Result<u16, SnapshotIdentityError> {
        let end = self.cursor.saturating_add(4);
        let Some(bytes) = self.input.get(self.cursor..end) else {
            return Err(SnapshotIdentityError::Unicode { offset });
        };
        let mut value = 0_u16;
        for byte in bytes {
            let Some(nibble) = hex_nibble(*byte) else {
                return Err(SnapshotIdentityError::Unicode { offset });
            };
            value = (value << 4) | u16::from(nibble);
        }
        self.cursor = end;
        Ok(value)
    }
    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.cursor += 1;
        }
    }
    fn eat(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn peek(&self) -> Option<u8> {
        self.input.get(self.cursor).copied()
    }
    const fn syntax(&self) -> SnapshotIdentityError {
        SnapshotIdentityError::Syntax {
            offset: self.cursor,
        }
    }
}

fn push_str_byte(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), SnapshotIdentityError> {
    if out.len().saturating_add(bytes.len()) > SNAPSHOT_STRING_MAX_BYTES {
        return Err(SnapshotIdentityError::StringTooLarge {
            max_bytes: SNAPSHOT_STRING_MAX_BYTES,
        });
    }
    out.extend_from_slice(bytes);
    Ok(())
}

const fn utf8_width(byte: u8) -> Option<usize> {
    match byte {
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{SnapshotIdentityError, derive_snapshot_identity, verify_snapshot_identity};

    fn minimal_material() -> Vec<u8> {
        br#"{"revision":1,"resolved_scope_expression":{"kind":"GLOBAL_LIBRARY"},"participant_generations":{"p1":"g1"},"member_source_revision_refs":["sr1"],"source_owner_generations":{"sr1":"og1"},"policy_authority_ref":"pa1","disclosure_closure_digest":"0000000000000000000000000000000000000000000000000000000000000000","purge_ledger_revision":0,"created_at":"2026-01-01T00:00:00.000Z","expires_at":"2026-01-01T00:15:00.000Z"}"#.to_vec()
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
}
