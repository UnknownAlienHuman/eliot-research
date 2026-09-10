//! ER-40 S8 final kill-matrix: residual MISSED from run 34183847846 (issue #106).
//!
//! Style matches S6/S7 `kill_*.rs`: `#[test]` through the public API only,
//! programmatic generation (no fixtures), absolute hardcoded expectations
//! (exact bytes, exact error codes AND structs). Per the S7 lesson, no
//! differential `formA == formB` asserts: every expectation is an absolute
//! value computed independently (hand-counted offsets, hand-computed Unicode
//! scalars, hardcoded ceilings).
//!
//! Killed here (verified by manual rollback, see Track 3 report):
//! - `owner_token_tuple.rs:227` `+`->`-` (col 22) and `-`->`+` (col 81) in
//!   `TupleParser::parse_unicode_escape` — surrogate-arithmetic pins;
//! - `expression.rs:111` `+`->`-` / `+`->`*` in `walk_expression` — right-side
//!   depth pin (S7 pinned the left call at line 106 only);
//! - `emit.rs:175` `>`->`==` / `>`->`>=` in `SnapshotWriter::push_bytes` —
//!   exact-2MiB-output pin.
//!
//! The remaining residue is provably equivalent (see `.cargo/mutants.toml`
//! proofs) and is pinned — not killed — by the tests at the bottom.

use eliotr_canonical::{
    CanonicalJsonError, OWNER_TOKEN_NAMESPACE_CODE, OWNER_TOKEN_REVISION_CODE, OwnerTokenError,
    SNAPSHOT_EXPRESSION_CODE, SNAPSHOT_OUTPUT_TOO_LARGE_CODE, SNAPSHOT_TIMESTAMP_CODE,
    SnapshotIdentityError, canonicalize_json, derive_owner_token_from_preimage,
    derive_snapshot_identity,
};

fn owner_code(input: &[u8]) -> Result<String, &'static str> {
    derive_owner_token_from_preimage(input).map_err(|error| error.code())
}

fn snapshot_code(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    derive_snapshot_identity(input).map_err(|error| error.code())
}

// ---------------------------------------------------------------------------
// A. Owner-tuple surrogate arithmetic (kills tuple:227 col-22 `+`->`-` and
// col-81 `-`->`+`). Both mutants keep every *small* pair inside the astral
// range (still Namespace), so S7's `\uD83D\uDE00` vector was blind to them.
// These two inputs push the formula to its edges: an ASCII landing (col 22)
// and a beyond-U+10FFFF landing (col 81).
// ---------------------------------------------------------------------------

#[test]
fn owner_tuple_surrogate_arithmetic_ascii_landing_is_namespace() {
    // Hand-computed: 0xD840 - 0xD800 = 0x40; 0x40 << 10 = 0x10000.
    // Correct scalar: 0x10000 + 0x10000 + 0x41 = 0x20041 (U+20041, astral).
    // Non-ASCII in the namespace fails as Namespace — absolute expectation.
    // The col-22 `+`->`-` mutant computes (0x10000 - 0x10000) + 0x41 = 0x41
    // (`A`), decodes namespace "aAb" (valid ID) and admits the preimage.
    let input = b"[\"eliotr.source-owner.initial.v1\",\"a\\uD840\\uDC41b\",\"eliotr\",\"installation-1\",1,\"ACTIVE\"]"
        .to_vec();
    assert_eq!(owner_code(&input), Err(OWNER_TOKEN_NAMESPACE_CODE));
    assert_eq!(
        derive_owner_token_from_preimage(&input),
        Err(OwnerTokenError::Namespace)
    );
}

#[test]
fn owner_tuple_high_surrogate_pair_stays_namespace() {
    // Hand-computed: 0xDBFF - 0xD800 = 0x3FF; 0x3FF << 10 = 0xFFC00.
    // Correct scalar: 0x10000 + 0xFFC00 + 0x3FF = 0x10FFFF (U+10FFFF).
    // The col-81 `-`->`+` mutant computes
    // 0x10000 + 0xFFC00 + (0xDFFF + 0xDC00) = 0x12BBFF, which has no scalar,
    // so it reports Unicode instead of Namespace.
    let input = b"[\"eliotr.source-owner.initial.v1\",\"a\\uDBFF\\uDFFFb\",\"eliotr\",\"installation-1\",1,\"ACTIVE\"]"
        .to_vec();
    assert_eq!(owner_code(&input), Err(OWNER_TOKEN_NAMESPACE_CODE));
    assert_eq!(
        derive_owner_token_from_preimage(&input),
        Err(OwnerTokenError::Namespace)
    );
}

// ---------------------------------------------------------------------------
// B. Expression right-side depth (kills expression:111 `+`->`-` / `+`->`*`).
// S7's `expression_depth_32_ok_33_expression` nests via `left`, so only the
// line-106 call was pinned. Nesting via `right` pins the line-111 call:
// `depth - 1` under-counts (and panics on underflow) while `depth * 1`
// never deepens, so a 33-deep right chain is wrongly admitted.
// ---------------------------------------------------------------------------

fn right_nested_union(wraps: usize) -> Vec<u8> {
    const DIGEST0: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    let mut expression = "{\"kind\":\"GLOBAL_LIBRARY\"}".to_owned();
    for _ in 0..wraps {
        expression = format!(
            "{{\"kind\":\"UNION\",\"left\":{{\"kind\":\"GLOBAL_LIBRARY\"}},\"right\":{expression}}}"
        );
    }
    format!(
        "{{\"revision\":1,\"resolved_scope_expression\":{expression},\
        \"participant_generations\":{{\"p1\":\"g1\"}},\
        \"member_source_revision_refs\":[\"sr1\"],\
        \"source_owner_generations\":{{\"sr1\":\"og1\"}},\
        \"policy_authority_ref\":\"pa1\",\
        \"disclosure_closure_digest\":\"{DIGEST0}\",\
        \"purge_ledger_revision\":0,\
        \"created_at\":\"2026-01-01T00:00:00.000Z\",\
        \"expires_at\":\"2026-01-01T00:15:00.000Z\"}}"
    )
    .into_bytes()
}

#[test]
fn expression_right_depth_32_ok_33_expression() {
    // Hardcoded ceiling: 32. Chain depth = wraps + 1.
    assert!(
        snapshot_code(&right_nested_union(31)).is_ok(),
        "right depth 32 must admit"
    );
    assert_eq!(
        snapshot_code(&right_nested_union(32)),
        Err(SNAPSHOT_EXPRESSION_CODE)
    );
    assert_eq!(
        derive_snapshot_identity(&right_nested_union(32)),
        Err(SnapshotIdentityError::Expression)
    );
}

// ---------------------------------------------------------------------------
// C. Snapshot output budget exactly MAX (kills emit:175 `>`->`==` /
// `>`->`>=`). Both mutants reject an output of exactly MAX bytes while the
// original admits it, so one exact-MAX test kills both. Content is ~8200
// member refs (each <= 255 UTF-16 units, so identifiers stay valid); the
// deficit to exactly 2 * 1024 * 1024 is distributed programmatically.
// ---------------------------------------------------------------------------

const SNAPSHOT_OUT_MAX: usize = 2_097_152; // 2 * 1024 * 1024, hardcoded.
const OUT_REF_COUNT: usize = 8_200;
const OUT_REF_LEN: usize = 250;

fn snapshot_material_with_member_refs(ref_count: usize, ref_len: usize, bump: usize) -> Vec<u8> {
    const HEAD: &str = "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[";
    const TAIL: &str = "],\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"pa1\",\"disclosure_closure_digest\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"purge_ledger_revision\":0,\"created_at\":\"2026-01-01T00:00:00.000Z\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}";
    let mut material = String::from(HEAD);
    for index in 0..ref_count {
        let stem = format!("s{index:07}");
        // `ref_len + (index < bump) - stem.len()`: every id stays ASCII
        // alnum (no escaping) with an exact byte length.
        let pad = ref_len + usize::from(index < bump) - stem.len();
        if index > 0 {
            material.push(',');
        }
        material.push('"');
        material.push_str(&stem);
        material.extend(core::iter::repeat_n('z', pad));
        material.push('"');
    }
    material.push_str(TAIL);
    material.into_bytes()
}

#[test]
fn snapshot_output_exact_max_ok_and_max_plus_one_rejected() {
    assert_eq!(SNAPSHOT_OUT_MAX, 2_097_152);
    // Calibrate: the probe output grows 1:1 with ASCII padding, so the
    // deficit is distributed +1 per ref (each ref keeps headroom to 256).
    let probe = snapshot_material_with_member_refs(OUT_REF_COUNT, OUT_REF_LEN, 0);
    let probe_out = derive_snapshot_identity(&probe);
    assert!(probe_out.is_ok(), "probe material must derive");
    let probe_len = probe_out.map(|bytes| bytes.len()).unwrap_or(0);
    assert!(
        probe_len < SNAPSHOT_OUT_MAX,
        "probe {probe_len} must stay below MAX"
    );
    let deficit = SNAPSHOT_OUT_MAX - probe_len;
    assert!(
        deficit <= OUT_REF_COUNT * 6,
        "deficit {deficit} must fit ref headroom (250 -> 256)"
    );
    let per = deficit / OUT_REF_COUNT;
    let rem = deficit % OUT_REF_COUNT;
    assert!(
        OUT_REF_LEN + per + 2 <= 256,
        "refs (exact, minus-1 and plus-1) must stay valid identifiers"
    );
    // Exact-MAX material: first `rem` refs are one byte longer.
    let exact = snapshot_material_with_member_refs(OUT_REF_COUNT, OUT_REF_LEN + per, rem);
    let exact_out = derive_snapshot_identity(&exact);
    assert!(exact_out.is_ok(), "exact-MAX output must derive");
    assert_eq!(
        exact_out.map(|bytes| bytes.len()).unwrap_or(0),
        SNAPSHOT_OUT_MAX
    );

    // MAX - 1 admits (one byte less of padding).
    let minus = snapshot_material_with_member_refs(
        OUT_REF_COUNT,
        OUT_REF_LEN + (deficit - 1) / OUT_REF_COUNT,
        (deficit - 1) % OUT_REF_COUNT,
    );
    let minus_out = derive_snapshot_identity(&minus);
    assert!(minus_out.is_ok(), "MAX-1 output must derive");
    assert_eq!(
        minus_out.map(|bytes| bytes.len()).unwrap_or(0),
        SNAPSHOT_OUT_MAX - 1
    );

    // MAX + 1 rejects with the exact struct (one more padded byte on a ref
    // that stays <= 255 units, so identifiers stay valid and input <= MAX).
    // `rem + 1 <= OUT_REF_COUNT` holds because `rem` is a remainder.
    let over = snapshot_material_with_member_refs(OUT_REF_COUNT, OUT_REF_LEN + per, rem + 1);
    assert_eq!(snapshot_code(&over), Err(SNAPSHOT_OUTPUT_TOO_LARGE_CODE));
    assert_eq!(
        derive_snapshot_identity(&over),
        Err(SnapshotIdentityError::OutputTooLarge {
            max_bytes: 2_097_152
        })
    );
}

// ---------------------------------------------------------------------------
// D. Accumulator pins (canonical:210,217,255,366; frame:209,216,255,361;
// tuple:105,112,148,275). The `+=`->`*=` counter mutants are provably
// equivalent (tighter input ceilings fire first — see `.cargo/mutants.toml`),
// so no test can kill them; these absolute pins document the exact behavior
// instead: exact integer VALUES (12/100 byte-for-byte, not just ok) and
// exact error OFFSETS (hardcoded numbers, hand-counted).
// ---------------------------------------------------------------------------

#[test]
fn canonical_integer_values_are_exact_bytes() {
    // Magnitude accumulation `* 10 + digit`: 12 is not 21, 100 is not 10.
    assert_eq!(canonicalize_json(b"12"), Ok(b"12".to_vec()));
    assert_eq!(canonicalize_json(b"100"), Ok(b"100".to_vec()));
    assert_eq!(canonicalize_json(b"0"), Ok(b"0".to_vec()));
}

#[test]
fn owner_revision_values_map_to_exact_errors() {
    // Multi-digit revisions parse fully, then fail as Revision (not Syntax):
    // 12 and 100 are exact values, each observed through its error family.
    for revision in ["12", "100", "2", "10"] {
        let input = format!(
            "[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",{revision},\"ACTIVE\"]"
        );
        assert_eq!(
            owner_code(input.as_bytes()),
            Err(OWNER_TOKEN_REVISION_CODE),
            "revision {revision}"
        );
        assert_eq!(
            derive_owner_token_from_preimage(input.as_bytes()),
            Err(OwnerTokenError::Revision),
            "revision {revision}"
        );
    }
    // Revision 0 parses to 0 (then Revision, since only 1 admits).
    let zero = b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",0,\"ACTIVE\"]".to_vec();
    assert_eq!(owner_code(&zero), Err(OWNER_TOKEN_REVISION_CODE));
}

#[test]
fn syntax_offsets_are_hardcoded_exact() {
    // Hand-counted: the minimal valid tuple is 62 bytes, so trailing garbage
    // fails at offset 62 and leading whitespace is skipped (cursor pins).
    let base = b"[\"eliotr.source-owner.initial.v1\",\"n\",\"eliotr\",\"i\",1,\"ACTIVE\"]".to_vec();
    assert_eq!(base.len(), 62);
    let mut trailing = base.clone();
    trailing.push(b'!');
    assert_eq!(
        derive_owner_token_from_preimage(&trailing),
        Err(OwnerTokenError::Syntax { offset: 62 })
    );
    let mut leading = b"  ".to_vec();
    leading.extend_from_slice(&base);
    assert!(owner_code(&leading).is_ok());
    // Canonical JSON: trailing byte after `12` fails at offset 2.
    assert_eq!(
        canonicalize_json(b"12!"),
        Err(CanonicalJsonError::Syntax { offset: 2 })
    );
}

// ---------------------------------------------------------------------------
// E. Timestamp envelope pins (timestamp:54 rest<5, timestamp:67 zone<3).
// Both `<` guards are unreachable on the failing side (see
// `.cargo/mutants.toml`), so these pin the exact boundary behavior instead:
// the shortest admitted envelope (17 bytes) derives, every shorter or
// short-zoned shape fails with the absolute Timestamp code.
// ---------------------------------------------------------------------------

const TS_STEM: &str = concat!(
    "{\"revision\":1,\"resolved_scope_expression\":{\"kind\":\"GLOBAL_LIBRARY\"},",
    "\"participant_generations\":{\"p1\":\"g1\"},\"member_source_revision_refs\":[\"sr1\"],",
    "\"source_owner_generations\":{\"sr1\":\"og1\"},\"policy_authority_ref\":\"pa1\",",
    "\"disclosure_closure_digest\":",
    "\"0000000000000000000000000000000000000000000000000000000000000000\",",
    "\"purge_ledger_revision\":0,\"created_at\":\"",
);
const TS_MID: &str = "\",\"expires_at\":\"2026-01-01T00:15:00.000Z\"}";

fn with_created(created_at: &str) -> Vec<u8> {
    format!("{TS_STEM}{created_at}{TS_MID}").into_bytes()
}

#[test]
fn timestamp_shortest_envelope_derives_and_shorter_rejects() {
    // 17 bytes is the shortest admitted form (`YYYY-MM-DDTHH:MMZ`).
    assert_eq!("2026-01-01T00:00Z".len(), 17);
    assert!(derive_snapshot_identity(&with_created("2026-01-01T00:00Z")).is_ok());
    assert!(derive_snapshot_identity(&with_created("2026-01-01T00:00:00Z")).is_ok());
    for bad in [
        "2026-01-01T00:00",   // 16 bytes: rest has 4 bytes (< 5 arm)
        "2026-01-01T00:00:0", // zone ":0": 2 bytes (< 3 arm)
        "2026-01-01T00:00:00",
        "2026-01-01T00:0Z",
    ] {
        assert_eq!(
            derive_snapshot_identity(&with_created(bad)).map_err(|error| error.code()),
            Err(SNAPSHOT_TIMESTAMP_CODE),
            "short envelope {bad}"
        );
    }
}

// ---------------------------------------------------------------------------
// F. Every 31-day month admits day 31 (timestamp:111). Deleting the 31-day
// match arm is masked by the `_ => 31` fallback (see `.cargo/mutants.toml`),
// so this pins each month separately: a single-month test would miss a
// per-month regression, and April-31 (30-day rejection) cannot stand in.
// ---------------------------------------------------------------------------

#[test]
fn timestamp_every_31_day_month_admits_day_31() {
    for month_day in [
        "01-31", "03-31", "05-31", "07-31", "08-31", "10-31", "12-31",
    ] {
        let created = format!("2026-{month_day}T00:00:00Z");
        assert!(
            derive_snapshot_identity(&with_created(&created)).is_ok(),
            "31-day month {month_day}"
        );
    }
    for month_day in ["04-31", "06-31", "09-31", "11-31", "02-31"] {
        let created = format!("2026-{month_day}T00:00:00Z");
        assert_eq!(
            derive_snapshot_identity(&with_created(&created)).map_err(|error| error.code()),
            Err(SNAPSHOT_TIMESTAMP_CODE),
            "short month {month_day}"
        );
    }
}
