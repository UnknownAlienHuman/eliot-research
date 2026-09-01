#![no_main]

use eliotr_canonical::{
    canonicalize_json, derive_stable_id_frame, sha256, validate_canonical_utf8_transport,
    validate_generation_token, validate_stable_id,
};
use eliotr_test_vectors::{
    parse_canonical_body_vector_set, parse_stable_id_vector_set, parse_vector_set,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let max_bytes = data.first().map_or(0, |byte| usize::from(*byte));
    let _ = validate_canonical_utf8_transport(data, max_bytes);
    let _ = canonicalize_json(data);
    let _ = sha256(data);
    let _ = validate_generation_token(data);
    let _ = derive_stable_id_frame(data);
    let _ = validate_stable_id(data);

    if let Ok(frame) = core::str::from_utf8(data) {
        let _ = parse_vector_set(frame);
        let _ = parse_canonical_body_vector_set(frame);
        let _ = parse_stable_id_vector_set(frame);
    }
});
