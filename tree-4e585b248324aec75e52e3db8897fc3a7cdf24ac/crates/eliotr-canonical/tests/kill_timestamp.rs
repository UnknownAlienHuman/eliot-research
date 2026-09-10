//! ER-40 S6 native kill-matrix: `datetime({ offset: true })` parity (S4).
//!
//! Every hour/minute/second/offset/fraction bound and every Gregorian
//! leap/month/day rule is pinned with exact `SNAPSHOT_TIMESTAMP` codes on
//! rejection and derive-ok on the valid side of each boundary (23 vs 24,
//! 59 vs 60, leap vs non-leap centuries).

use eliotr_canonical::{SNAPSHOT_TIMESTAMP_CODE, derive_snapshot_identity};

const STEM: &str = concat!(
    "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
    "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
    "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"pa1\",",
    "\"disclosure_closure_digest\":",
    "\"0000000000000000000000000000000000000000000000000000000000000000\",",
    "\"purge_ledger_revision\":0,\"created_at\":\"",
);

const MID: &str = "\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}";

fn with_created(created_at: &str) -> Vec<u8> {
    format!("{STEM}{created_at}{MID}").into_bytes()
}

fn code_for(created_at: &str) -> Result<Vec<u8>, &'static str> {
    derive_snapshot_identity(&with_created(created_at)).map_err(|error| error.code())
}

#[test]
fn timestamp_valid_boundaries_derive_ok() {
    for accepted in [
        "2026-01-01T00:00Z",
        "2026-01-01T00:00:00Z",
        "2026-01-01T23:59:59Z",
        "2026-01-01T00:00:00.0Z",
        "2026-01-01T00:00:00.12345678901234567890Z",
        "2026-01-01T00:00:00+00:00",
        "2026-01-01T00:00:00-00:00",
        "2026-01-01T00:00:00+23:59",
        "2026-01-01T00:00:00-23:59",
        "2026-01-01T00:00:00+05:30",
        "2000-02-29T00:00:00Z",
        "2024-02-29T00:00:00Z",
        "0000-02-29T00:00:00Z",
        "2026-01-31T00:00:00Z",
        "2026-04-30T00:00:00Z",
        "2026-12-31T23:59:59.999-02:00",
    ] {
        assert!(code_for(accepted).is_ok(), "timestamp {accepted}");
    }
}

#[test]
fn timestamp_hour_minute_second_bounds_reject() {
    for rejected in [
        "2026-01-01T24:00:00Z",
        "2026-01-01T24:00Z",
        "2026-01-01T00:60:00Z",
        "2026-01-01T00:60Z",
        "2026-01-01T00:00:60Z",
        "2026-01-01T99:00:00Z",
    ] {
        assert_eq!(
            code_for(rejected),
            Err(SNAPSHOT_TIMESTAMP_CODE),
            "{rejected}"
        );
    }
}

#[test]
fn timestamp_offset_bounds_reject() {
    for rejected in [
        "2026-01-01T00:00:00+24:00",
        "2026-01-01T00:00:00-24:00",
        "2026-01-01T00:00:00+23:60",
        "2026-01-01T00:00:00+23:59:00",
        "2026-01-01T00:00:00+0530",
        "2026-01-01T00:00:00Z00",
    ] {
        assert_eq!(
            code_for(rejected),
            Err(SNAPSHOT_TIMESTAMP_CODE),
            "{rejected}"
        );
    }
}

#[test]
fn timestamp_fraction_rules_reject() {
    for rejected in [
        "2026-01-01T00:00:00.Z",
        "2026-01-01T00:00.000Z",
        "2026-01-01T00:00.000+05:30",
        "2026-01-01T00:00:00.",
        "2026-01-01T00:00:00Z ",
    ] {
        assert_eq!(
            code_for(rejected),
            Err(SNAPSHOT_TIMESTAMP_CODE),
            "{rejected}"
        );
    }
    // Fraction without seconds but with zone offset is still rejected.
    assert_eq!(
        code_for("2026-01-01T00:00.000+05:30"),
        Err(SNAPSHOT_TIMESTAMP_CODE)
    );
}

#[test]
fn timestamp_gregorian_calendar_rejects_impossible_dates() {
    for rejected in [
        "2026-02-30T00:00:00Z",
        "2026-02-29T00:00:00Z",
        "1900-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-09-31T00:00:00Z",
        "2026-06-31T00:00:00Z",
        "2026-11-31T00:00:00Z",
        "2026-00-10T00:00:00Z",
        "2026-13-10T00:00:00Z",
        "2026-01-00T00:00:00Z",
        "2026-01-32T00:00:00Z",
    ] {
        assert_eq!(
            code_for(rejected),
            Err(SNAPSHOT_TIMESTAMP_CODE),
            "{rejected}"
        );
    }
}

#[test]
fn timestamp_shape_rejects_malformed_envelopes() {
    for rejected in [
        "2026-01-01 00:00:00Z",
        "2026-01-01T00:00",
        "2026/01/01T00:00:00Z",
        "2026-01-01T00-00-00Z",
        "not-a-timestamp",
        "2026-0a-01T00:00:00Z",
        "2026-01-01T0a:00:00Z",
        "",
    ] {
        assert_eq!(
            code_for(rejected),
            Err(SNAPSHOT_TIMESTAMP_CODE),
            "{rejected}"
        );
    }
}
