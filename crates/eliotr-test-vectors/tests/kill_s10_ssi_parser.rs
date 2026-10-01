//! ER-40 S10 scope-snapshot-identity parser cluster (issue #106).
//!
//! Through the public API only. Pins survivors in
//! `crates/eliotr-test-vectors/src/scope_snapshot_identity/parser.rs`:
//!
//! - `Display` for `ScopeSnapshotIdentityParseError` must render the line and
//!   kind (kills `fmt -> Ok(Default::default())`, 73:9) and the line numbers
//!   must be exact (kills `index + 1 -> index - 1 | index * 1`, 237:23, 243:23,
//!   and `offset + 4 -> offset * 4`, 251:34).
//! - `decode_hex` must reject odd-length hex (`|| -> &&`, 111:9), non-hex
//!   bytes (`|| -> &&`, 112:9), and lowercase non-hex like `zz`
//!   (`&& -> ||`, 114:44, which the `A`-`F` gate below does not catch).
//! - Payload/frame/case-id ceilings are strict `>` (kills `> -> == | >=` at
//!   136:18, 216:25, 286:26).
//!
//! The `|| -> &&` survivors in `check_output_shape` (167:31, 187:9, 188:9,
//! 195:9) are masked by the downstream `verify_snapshot_identity` gate which
//! reports the same `InvalidOutputShape` kind; they are documented, not tested.

use eliotr_test_vectors::{
    SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER, SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER,
    parse_scope_snapshot_identity_vector_set,
};

fn frame(body: &str) -> String {
    format!(
        "{SCOPE_SNAPSHOT_IDENTITY_PROTOCOL_HEADER}\n# schema_generation=1\n{SCOPE_SNAPSHOT_IDENTITY_COLUMNS_HEADER}\n{body}\n"
    )
}

fn display_of(source: &str) -> String {
    match parse_scope_snapshot_identity_vector_set(source) {
        Err(error) => format!("{error}"),
        Ok(_) => panic!("expected parse error"),
    }
}

fn assert_kind(source: &str, kind_debug: &str) {
    match parse_scope_snapshot_identity_vector_set(source) {
        Err(error) => {
            let text = format!("{error}");
            assert!(
                text.contains(kind_debug),
                "expected kind {kind_debug}, got: {text}"
            );
        }
        Ok(_) => panic!("expected parse error"),
    }
}

fn assert_not_kind(source: &str, kind_debug: &str) {
    match parse_scope_snapshot_identity_vector_set(source) {
        Err(error) => {
            let text = format!("{error}");
            assert!(
                !text.contains(kind_debug),
                "must not be {kind_debug}, got: {text}"
            );
        }
        Ok(_) => {}
    }
}

#[test]
fn display_renders_line_and_kind() {
    // `fmt -> Ok(Default::default())` renders nothing; the line math mutants
    // shift or panic on the reported line.
    let text = display_of("");
    assert!(
        text.contains("line 1"),
        "Display must name line 1, got: {text}"
    );
    assert!(
        text.contains("MissingHeader"),
        "Display must name the kind, got: {text}"
    );
    let text = display_of("wrong-protocol");
    assert!(
        text.contains("line 1"),
        "Display must name line 1, got: {text}"
    );
    assert!(
        text.contains("UnexpectedHeader"),
        "Display must name the kind, got: {text}"
    );
}

#[test]
fn case_errors_report_one_based_line_numbers() {
    // First case row lives on line 4; `offset + 4 -> offset * 4` reports 0.
    let text = display_of(&frame(""));
    assert!(
        text.contains("line 4"),
        "blank first case must be line 4, got: {text}"
    );
    assert!(
        text.contains("UnexpectedBlankLine"),
        "wrong kind, got: {text}"
    );
}

#[test]
fn decode_hex_rejects_odd_length() {
    // `|| -> &&` on the length check admits odd-length hex (then panics in the
    // decode loop); it must fail closed with `InvalidHex`.
    let row = "odd_len|derive_snapshot_identity|abc|ok|00|-";
    assert_kind(&frame(row), "InvalidHex");
}

#[test]
fn decode_hex_rejects_non_hex_bytes() {
    // `|| -> &&` on the shape check admits even-length non-hex (`zz` decodes
    // to `[0x00]` via `hex_val`'s `_ => 0`); it must fail closed.
    let row = "bad_hex|derive_snapshot_identity|zz|ok|00|-";
    assert_kind(&frame(row), "InvalidHex");
    let row = "upper_hex|derive_snapshot_identity|AB|ok|00|-";
    assert_kind(&frame(row), "InvalidHex");
}

#[test]
fn payload_ceiling_is_strict() {
    // MAX_PAYLOAD_BYTES = 256 * 1024. Exactly MAX decodes; MAX + 1 fails.
    // Kills `> -> ==` and `> -> >=` at decode_hex:136.
    const MAX: usize = 256 * 1024;
    let at_max = "ab".repeat(MAX);
    let row = format!("at_max|derive_snapshot_identity|{at_max}|ok|00|-");
    assert_not_kind(&frame(&row), "PayloadTooLarge");
    let over_max = "ab".repeat(MAX + 1);
    let row = format!("over_max|derive_snapshot_identity|{over_max}|ok|00|-");
    assert_kind(&frame(&row), "PayloadTooLarge");
}

#[test]
fn frame_ceiling_is_strict() {
    // MAX_FRAME_BYTES = 1024 * 1024. A frame of exactly MAX bytes passes the
    // size gate (and fails later on the filler row); MAX + 1 fails closed.
    // Kills `> -> ==` and `> -> >=` at parse:216.
    const MAX: usize = 1024 * 1024;
    let mut at_max = frame("ok_row|derive_snapshot_identity|00|ok|00|-");
    while at_max.len() < MAX {
        at_max.push('x');
    }
    assert_eq!(at_max.len(), MAX);
    assert_not_kind(&at_max, "FrameTooLarge");
    let mut over_max = at_max;
    over_max.push('x');
    assert_eq!(over_max.len(), MAX + 1);
    assert_kind(&over_max, "FrameTooLarge");
}

#[test]
fn case_id_ceiling_is_strict() {
    // MAX_CASE_ID_BYTES = 128. Exactly 128 passes the length gate; 129 fails.
    // Kills `> -> ==` and `> -> >=` at parse:286.
    const MAX: usize = 128;
    let at_max = "a".repeat(MAX);
    let row = format!("{at_max}|bad_operation|-|ok|-|-");
    assert_kind(&frame(&row), "InvalidOperation");
    let over_max = "a".repeat(MAX + 1);
    let row = format!("{over_max}|bad_operation|-|ok|-|-");
    assert_kind(&frame(&row), "CaseIdTooLong");
}
