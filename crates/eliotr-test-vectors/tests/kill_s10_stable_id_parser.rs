//! ER-40 S10 stable-id parser cluster (issue #106).
//!
//! Through the public API only. Pins survivors in
//! `crates/eliotr-test-vectors/src/stable_id/parser.rs`:
//!
//! - `StableIdParseError::line` must report the exact one-based line (kills
//!   `line -> 1` at 83:9, `index + 1 -> index * 1` at 124:37, and
//!   `*line + 1 -> *line - 1 | *line * 1` at 202:54).
//! - `parse_hex` must reject empty input (`|| -> &&`, 322:25), must count
//!   decoded bytes with `/ 2` (`/ -> %`, 329:37), and the payload ceiling is
//!   strict `>` (`> -> == | >=`, 330:22).
//! - Frame/case-id ceilings are strict `>` (`> -> == | >=` at 111:20, 167:26).
//! - Every documented error code parses, including `ELIOTR_STABLE_ID_NUL`
//!   (kills `delete match arm STABLE_ID_NUL_CODE`, 304:9).

use eliotr_canonical::STABLE_ID_NUL_CODE;
use eliotr_test_vectors::{
    STABLE_ID_COLUMNS_HEADER, STABLE_ID_PROTOCOL_HEADER, StableIdParseErrorKind,
    parse_stable_id_vector_set,
};

fn frame(row: &str) -> String {
    format!(
        "{STABLE_ID_PROTOCOL_HEADER}\n# schema_generation=1\n{STABLE_ID_COLUMNS_HEADER}\n{row}\n"
    )
}

fn headers_only() -> String {
    format!("{STABLE_ID_PROTOCOL_HEADER}\n# schema_generation=1\n{STABLE_ID_COLUMNS_HEADER}\n")
}

#[test]
fn error_lines_are_one_based() {
    // NoCases on a headers-only frame is reported at line 4.
    // Kills `line -> 1` (83:9) and `*line + 1` mutants (202:54).
    let no_cases = parse_stable_id_vector_set(&headers_only());
    assert!(no_cases.is_err(), "expected NoCases");
    if let Err(error) = no_cases {
        assert!(
            matches!(error.kind(), StableIdParseErrorKind::NoCases),
            "wrong kind: {:?}",
            error.kind()
        );
        assert_eq!(error.line(), 4, "NoCases must be reported at line 4");
    }
    // A malformed first case row is reported at line 4.
    // Kills `index + 1 -> index * 1` (124:37).
    let malformed_first = parse_stable_id_vector_set(&frame("broken"));
    assert!(
        malformed_first.is_err(),
        "expected WrongColumnCount on first case row"
    );
    if let Err(error) = malformed_first {
        assert!(
            matches!(
                error.kind(),
                StableIdParseErrorKind::WrongColumnCount { .. }
            ),
            "wrong kind: {:?}",
            error.kind()
        );
        assert_eq!(error.line(), 4, "first case row must be line 4");
    }
    // A malformed second case row is reported at line 5.
    let two_rows = format!("ok1|derive_stable_id|00|error|-|{STABLE_ID_NUL_CODE}\nbroken");
    let malformed_second = parse_stable_id_vector_set(&frame(&two_rows));
    assert!(
        malformed_second.is_err(),
        "expected WrongColumnCount on second case row"
    );
    if let Err(error) = malformed_second {
        assert!(
            matches!(
                error.kind(),
                StableIdParseErrorKind::WrongColumnCount { .. }
            ),
            "wrong kind: {:?}",
            error.kind()
        );
        assert_eq!(error.line(), 5, "second case row must be line 5");
    }
}

#[test]
fn parse_hex_rejects_empty_input() {
    // `|| -> &&` on `value.is_empty()` admits `""` (decodes to `[]`);
    // it must fail closed with `InvalidHex`.
    let row = "empty_hex|derive_stable_id||ok|00|-";
    assert!(
        matches!(
            parse_stable_id_vector_set(&frame(row)),
            Err(error) if matches!(
                error.kind(),
                StableIdParseErrorKind::InvalidHex { field: "input_hex" }
            )
        ),
        "empty hex must be InvalidHex"
    );
}

#[test]
fn parse_hex_counts_decoded_bytes() {
    // `/ -> %` on `value.len() / 2` zeroes the decoded size, disabling the
    // payload ceiling; a 2*(MAX+1)-char input must fail closed.
    // MAX_STABLE_ID_VECTOR_PAYLOAD_BYTES = 256 * 1024.
    const MAX: usize = 256 * 1024;
    let huge = "ab".repeat(MAX + 1);
    let row = format!("huge|derive_stable_id|{huge}|ok|00|-");
    assert!(
        matches!(
            parse_stable_id_vector_set(&frame(&row)),
            Err(error) if matches!(
                error.kind(),
                StableIdParseErrorKind::PayloadTooLarge { .. }
            )
        ),
        "oversized payload must be PayloadTooLarge"
    );
}

#[test]
fn payload_ceiling_is_strict() {
    // Exactly MAX decodes; MAX + 1 fails. Kills `> -> == | >=` at 330:22.
    const MAX: usize = 256 * 1024;
    let at_max = "ab".repeat(MAX);
    let row = format!("at_max|derive_stable_id|{at_max}|ok|00|-");
    let result = parse_stable_id_vector_set(&frame(&row));
    assert!(
        !matches!(
            result,
            Err(ref error) if matches!(
                error.kind(),
                StableIdParseErrorKind::PayloadTooLarge { .. }
            )
        ),
        "exactly MAX payload bytes must not be PayloadTooLarge"
    );
    let over_max = "ab".repeat(MAX + 1);
    let row = format!("over_max|derive_stable_id|{over_max}|ok|00|-");
    assert!(
        matches!(
            parse_stable_id_vector_set(&frame(&row)),
            Err(error)
                if matches!(
                    error.kind(),
                    StableIdParseErrorKind::PayloadTooLarge {
                        actual_bytes,
                        ..
                    } if *actual_bytes == MAX + 1
                )
        ),
        "MAX+1 payload bytes must be PayloadTooLarge"
    );
}

#[test]
fn frame_ceiling_is_strict() {
    // MAX_STABLE_ID_VECTOR_FRAME_BYTES = 1024 * 1024.
    // Kills `> -> == | >=` at 111:20.
    const MAX: usize = 1024 * 1024;
    let mut at_max = frame("ok_row|derive_stable_id|00|ok|00|-");
    while at_max.len() < MAX {
        at_max.push('x');
    }
    assert_eq!(at_max.len(), MAX);
    let result = parse_stable_id_vector_set(&at_max);
    assert!(
        !matches!(
            result,
            Err(ref error) if matches!(
                error.kind(),
                StableIdParseErrorKind::FrameTooLarge { .. }
            )
        ),
        "exactly MAX frame bytes must not be FrameTooLarge"
    );
    let mut over_max = at_max;
    over_max.push('x');
    assert!(
        matches!(
            parse_stable_id_vector_set(&over_max),
            Err(error) if matches!(
                error.kind(),
                StableIdParseErrorKind::FrameTooLarge { .. }
            )
        ),
        "MAX+1 frame bytes must be FrameTooLarge"
    );
}

#[test]
fn case_id_ceiling_is_strict() {
    // MAX_STABLE_ID_VECTOR_CASE_ID_BYTES = 128.
    // Kills `> -> == | >=` at 167:26.
    const MAX: usize = 128;
    let at_max = "a".repeat(MAX);
    let row = format!("{at_max}|bad_operation|-|ok|-|-");
    assert!(
        matches!(
            parse_stable_id_vector_set(&frame(&row)),
            Err(error) if matches!(
                error.kind(),
                StableIdParseErrorKind::InvalidOperation
            )
        ),
        "128-byte case id must pass the length gate"
    );
    let over_max = "a".repeat(MAX + 1);
    let row = format!("{over_max}|bad_operation|-|ok|-|-");
    assert!(
        matches!(
            parse_stable_id_vector_set(&frame(&row)),
            Err(error)
                if matches!(
                    error.kind(),
                    StableIdParseErrorKind::CaseIdTooLong { actual_bytes, .. }
                    if *actual_bytes == MAX + 1
                )
        ),
        "129-byte case id must be CaseIdTooLong"
    );
}

#[test]
fn nul_error_code_parses() {
    // Deleting the `STABLE_ID_NUL_CODE` match arm turns it into
    // `UnknownErrorCode`; the documented code must keep parsing.
    let row = format!("nul_case|derive_stable_id|00|error|-|{STABLE_ID_NUL_CODE}");
    let parsed = parse_stable_id_vector_set(&frame(&row));
    assert!(parsed.is_ok(), "ELIOTR_STABLE_ID_NUL must parse");
    let Ok(set) = parsed else {
        return;
    };
    assert_eq!(set.cases().len(), 1);
    assert_eq!(set.cases()[0].case_id(), "nul_case");
}
