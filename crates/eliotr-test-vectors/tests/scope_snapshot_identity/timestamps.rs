//! Timestamp parity tests for `scope-snapshot-identity.v1`.
//!
//! Tracks the admitted `IsoDateTimeSchema` (`z.string().datetime({ offset: true })`,
//! `zod@4.4.3`) exactly: optional seconds, Gregorian month/day/leap validity,
//! offsets, and unbounded fractions. Preserved verbatim; no normalization.

#![forbid(unsafe_code)]

use eliotr_canonical::{SnapshotIdentityError, derive_snapshot_identity, verify_snapshot_identity};

use super::common::{material_minimal, material_with_timestamps};

fn derive_with(created: &str, expires: &str) -> Result<Vec<u8>, SnapshotIdentityError> {
    let minimal = material_minimal();
    let Ok(base) = core::str::from_utf8(&minimal) else {
        return Err(SnapshotIdentityError::Shape);
    };
    let material = base
        .replace("2026-01-01T00:00:00.000Z", created)
        .replace("2026-01-01T00:15:00.000Z", expires);
    derive_snapshot_identity(material.as_bytes())
}

#[test]
fn fractional_seconds_beyond_nine_digits_round_trip() {
    let cases = [
        (
            "2026-01-01T00:00:00.1234567890Z",
            "2026-01-01T00:15:00.1234567890Z",
        ),
        (
            "2026-01-01T00:00:00.12345678901234567890+05:30",
            "2026-06-02T12:00:00.00000000000000000001-02:00",
        ),
    ];
    for (created, expires) in cases {
        let Ok(base) = core::str::from_utf8(&material_minimal()).map(str::to_owned) else {
            return;
        };
        let material = base
            .replace("2026-01-01T00:00:00.000Z", created)
            .replace("2026-01-01T00:15:00.000Z", expires);
        let derived = derive_snapshot_identity(material.as_bytes());
        assert!(derived.is_ok());
        if let Ok(bytes) = derived {
            assert!(core::str::from_utf8(&bytes).unwrap_or("").contains(created));
            assert_eq!(verify_snapshot_identity(&bytes), Ok(bytes));
        }
    }
}

#[test]
fn optional_seconds_admit_z_and_offset() {
    // `2026-01-01T00:00Z` is admitted by `datetime({ offset: true })`.
    for (created, expires) in [
        ("2026-01-01T00:00Z", "2026-01-01T00:15Z"),
        ("2026-01-01T00:00+05:30", "2026-06-02T12:00-02:00"),
        ("2026-02-28T23:59Z", "2026-03-01T00:00Z"),
    ] {
        let derived = derive_with(created, expires);
        assert!(
            derived.is_ok(),
            "optional seconds rejected: {created}/{expires}"
        );
        if let Ok(bytes) = derived {
            let text = core::str::from_utf8(&bytes).unwrap_or("");
            assert!(text.contains(created), "verbatim timestamp lost: {created}");
            assert_eq!(verify_snapshot_identity(&bytes), Ok(bytes));
        }
    }
}

#[test]
fn impossible_month_day_rejects() {
    // Month 13, day 32/00, and 30-day-month day 31 all fail closed.
    for (created, expires) in [
        ("2026-02-31T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-04-31T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-09-31T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-11-31T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-06-31T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-01-32T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-01-00T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-00-10T00:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-13-01T00:00:00Z", "2026-01-01T00:15:00.000Z"),
    ] {
        assert_eq!(
            derive_with(created, expires),
            Err(SnapshotIdentityError::Timestamp),
            "impossible date admitted: {created}"
        );
    }
}

#[test]
fn leap_rules_follow_gregorian_calendar() {
    // Leap day valid on leap years (2024, 2000), rejected otherwise (2026, 1900).
    for (created, expires, ok) in [
        ("2024-02-29T00:00:00Z", "2024-02-29T00:15:00Z", true),
        ("2000-02-29T00:00:00Z", "2000-02-29T00:15:00Z", true),
        ("2026-02-29T00:00:00Z", "2026-01-01T00:15:00.000Z", false),
        ("1900-02-29T00:00:00Z", "2026-01-01T00:15:00.000Z", false),
        ("2026-02-29T00:00Z", "2026-03-01T00:00Z", false),
        ("2024-02-29T00:00Z", "2024-02-29T00:15Z", true),
    ] {
        let result = derive_with(created, expires);
        if ok {
            assert!(result.is_ok(), "leap case rejected: {created}");
        } else {
            assert_eq!(
                result,
                Err(SnapshotIdentityError::Timestamp),
                "non-leap Feb 29 admitted: {created}"
            );
        }
    }
}

#[test]
fn thirty_and_thirty_one_day_boundaries_hold() {
    // 30-day months admit day 30; 31-day months admit day 31; Feb admits 28.
    for (created, expires) in [
        ("2026-04-30T00:00:00Z", "2026-04-30T00:15:00Z"),
        ("2026-01-31T00:00:00Z", "2026-01-31T00:15:00Z"),
        ("2026-12-31T23:59:59Z", "2026-12-31T23:59Z"),
        ("2026-02-28T00:00:00Z", "2026-02-28T00:15Z"),
    ] {
        assert!(
            derive_with(created, expires).is_ok(),
            "boundary rejected: {created}"
        );
    }
    // Fractions without seconds are rejected (`00:00.000Z` invalid per Zod).
    assert_eq!(
        derive_with("2026-01-01T00:00.000Z", "2026-01-01T00:15:00.000Z"),
        Err(SnapshotIdentityError::Timestamp)
    );
    // Offsets stay bounded: hour 00-23, minute 00-59.
    assert_eq!(
        derive_with("2026-01-01T00:00:00+24:00", "2026-01-01T00:15:00.000Z"),
        Err(SnapshotIdentityError::Timestamp)
    );
    assert_eq!(
        derive_with("2026-01-01T00:00:00+23:60", "2026-01-01T00:15:00.000Z"),
        Err(SnapshotIdentityError::Timestamp)
    );
    assert!(derive_with("2026-01-01T00:00:00+23:59", "2026-01-01T00:15:00Z").is_ok());
}

#[test]
fn seconds_and_zone_shapes_stay_strict() {
    // Hour/minute/second ceilings and zone spelling stay fail-closed.
    for (created, expires) in [
        ("2026-01-01T24:00:00Z", "2026-01-01T00:15:00.000Z"),
        ("2026-01-01T00:60Z", "2026-01-01T00:15:00.000Z"),
        ("2026-01-01T00:00:60Z", "2026-01-01T00:15:00.000Z"),
        ("2026-01-01T00:00:00.000", "2026-01-01T00:15:00.000Z"),
        ("2026-01-01T00:00:00z", "2026-01-01T00:15:00.000Z"),
    ] {
        assert_eq!(
            derive_with(created, expires),
            Err(SnapshotIdentityError::Timestamp),
            "malformed time admitted: {created}"
        );
    }
    // Untouched helper path still round-trips optional seconds verbatim.
    let Some(with_optional) = material_with_timestamps("2026-01-01T00:00Z", "2026-01-01T00:15Z")
    else {
        return;
    };
    let derived = derive_snapshot_identity(&with_optional);
    assert!(derived.is_ok());
}
