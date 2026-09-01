#![no_main]

use eliotr_canonical::validate_canonical_utf8_transport;
use eliotr_test_vectors::parse_vector_set;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let max_bytes = data.first().map_or(0, |byte| usize::from(*byte));
    let _result = validate_canonical_utf8_transport(data, max_bytes);

    if let Ok(frame) = core::str::from_utf8(data) {
        let _result = parse_vector_set(frame);
    }
});
