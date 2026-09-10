//! `datetime({ offset: true })` parity for `scope-snapshot-identity.v1`.
//!
//! The accepted TypeScript authority (`IsoDateTimeSchema`) is
//! `z.string().datetime({ offset: true })` from `zod@4.4.3`
//! (`packages/contracts/src/common.ts:6`). Its exact accepted envelope is the
//! Zod `dateSource` + `timeSource` + offset expression
//! (`node_modules/zod/v4/core/regexes.cjs`, `datetime()`):
//! `YYYY-MM-DDTHH:MM[:SS[.fraction]](Z|±HH:MM)` with Gregorian month/day/leap
//! validity, `HH 00-23`, `MM/SS 00-59`, zone `Z` or `±HH:MM` (`HH 00-23`,
//! `MM 00-59`), and an unbounded fractional-second run (`\.\d+`, at least one
//! digit, only when seconds are present). Seconds are OPTIONAL:
//! `2026-01-01T00:00Z` is admitted. Impossible dates (`2026-02-31`,
//! non-leap `2026-02-29`, `2026-04-31`) are rejected, including the
//! century rule (`1900-02-29` rejected, `2000-02-29` admitted).
//! Timestamps are validated and preserved verbatim; no normalization,
//! clock reads or timezone conversions occur here.

#![forbid(unsafe_code)]

use super::error::SnapshotIdentityError;

pub(crate) fn check_timestamp_shape(text: &str) -> Result<(), SnapshotIdentityError> {
    parse_timestamp(text).ok_or(SnapshotIdentityError::Timestamp)
}

/// Accepts the `datetime({ offset: true })` envelope:
/// `YYYY-MM-DDTHH:MM[:SS[.frac]](Z|±HH:MM)`.
///
/// Seconds are optional (Zod `timeSource` makes `:SS` optional); a fraction
/// requires seconds and at least one digit with no upper bound, matching the
/// admitted Zod schema. Dates use Gregorian month/day/leap validity. The
/// decoded-string ceiling enforced by the frame parser remains the only
/// length bound.
fn parse_timestamp(text: &str) -> Option<()> {
    let bytes = text.as_bytes();
    // Shortest admitted form is `YYYY-MM-DDTHH:MMZ` (17 bytes).
    if bytes.len() < 17 || bytes.get(10) != Some(&b'T') {
        return None;
    }
    let date = bytes.get(..10)?;
    if date[4] != b'-' || date[7] != b'-' {
        return None;
    }
    let year = digits(date.get(..4)?)?;
    let month = digits(date.get(5..7)?)?;
    let day = digits(date.get(8..10)?)?;
    if !(1..=12).contains(&month) {
        return None;
    }
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let rest = bytes.get(11..)?;
    if rest.len() < 5 {
        return None;
    }
    let head = rest.get(..5)?;
    if head[2] != b':' {
        return None;
    }
    if digits(head.get(..2)?)? > 23 || digits(head.get(3..5)?)? > 59 {
        return None;
    }
    let mut zone = rest.get(5..)?;
    if zone.first() == Some(&b':') {
        // Seconds are present: `:SS` with `SS 00-59`.
        if zone.len() < 3 {
            return None;
        }
        if digits(zone.get(1..3)?)? > 59 {
            return None;
        }
        zone = zone.get(3..)?;
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
    } else if zone.first() == Some(&b'.') {
        // Zod rejects fractions without seconds (`00:00.000Z` is invalid).
        return None;
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

fn is_leap_year(year: u32) -> bool {
    // Gregorian rule matching the Zod `dateSource` leap alternative:
    // divisible by 4, except centuries unless divisible by 400.
    // Year 0 (`0000`) is divisible by 400, so it is a leap year here,
    // matching `\d{4}` admission in the Zod expression.
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 31,
    }
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
