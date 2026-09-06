//! `datetime({ offset: true })` parity for `scope-snapshot-identity.v1`.
//!
//! The accepted TypeScript authority (`IsoDateTimeSchema`) admits the envelope
//! `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` with an unbounded fractional-second
//! run: `z.string().datetime({ offset: true })` accepts more than nine fractional
//! digits. Timestamps are validated and preserved verbatim; no normalization,
//! clock reads or timezone conversions occur here.

#![forbid(unsafe_code)]

use super::error::SnapshotIdentityError;

pub(crate) fn check_timestamp_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    parse_timestamp(text).ok_or(SnapshotIdentityError::Timestamp)
}

/// Accepts the `datetime({ offset: true })` envelope: `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`.
///
/// The fractional run requires at least one digit when the dot is present and has no
/// upper bound, matching the admitted Zod schema. The decoded-string ceiling enforced
/// by the frame parser remains the only length bound.
fn parse_timestamp(text: &str) -> Option<()> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes.get(10) != Some(&b'T') {
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
            frac = frac.saturating_add(1);
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
