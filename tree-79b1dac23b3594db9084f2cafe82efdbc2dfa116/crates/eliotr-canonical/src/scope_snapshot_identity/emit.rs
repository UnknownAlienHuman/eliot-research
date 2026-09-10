//! Canonical emission for `scope-snapshot-identity.v1`.
//!
//! The emission binds the non-wire `protocol` member into both hashes: the snapshot
//! ID is `scope-` plus 48 lowercase hex characters of SHA-256 over the canonical
//! identity bytes, and the digest is SHA-256 over the canonical digest payload
//! (`snapshot_id` plus the identity payload). Keys order by UTF-16 code units,
//! matching the current TypeScript `canonicalJson` authority.

#![forbid(unsafe_code)]

use core::cmp::Ordering;

use crate::sha256::sha256;

use super::error::SnapshotIdentityError;
use super::frame::{Value, field, parse_frame};
use super::material::{Material, check_material, reject_derived_keys};
use super::{
    SNAPSHOT_ID_BYTES, SNAPSHOT_ID_HEX_CHARS, SNAPSHOT_ID_PREFIX, SNAPSHOT_IDENTITY_PROTOCOL,
    SNAPSHOT_OUTPUT_MAX_BYTES,
};

/// Derives complete canonical snapshot bytes from material JSON bytes.
///
/// The material holds every `ScopeSnapshot` field except `snapshot_id` and `digest`.
/// Supplying either derived key is a fail-closed unknown-field rejection, not a
/// silent strip. The output is the canonical full snapshot (derived ID and digest
/// included, UTF-16 key order).
///
/// # Errors
///
/// Returns a typed, content-free error for oversized, non-UTF-8, malformed or invalid input.
pub fn derive_snapshot_identity(material: &[u8]) -> Result<Vec<u8>, SnapshotIdentityError> {
    let root = parse_frame(material)?;
    let members = root.as_object().ok_or(SnapshotIdentityError::Shape)?;
    reject_derived_keys(members)?;
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
    super::material::check_snapshot_id_shape(declared_id)?;
    super::material::check_digest_shape(declared_digest)?;
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

pub(crate) fn compare_utf16(left: &str, right: &str) -> Ordering {
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
