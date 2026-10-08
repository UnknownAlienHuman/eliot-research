//! Cross-crate consistency: the test-vector schema generation must equal the kernel
//! schema generation defined in `eliotr-canonical`. The generation is a single global
//! counter for canonical data layouts; two crates disagreeing on it would silently
//! interpret the same fixture bytes differently.

use eliotr_canonical::KERNEL_SCHEMA_GENERATION;
use eliotr_test_vectors::VECTOR_SCHEMA_GENERATION;

#[test]
fn vector_schema_generation_matches_kernel_schema_generation() {
    assert_eq!(
        VECTOR_SCHEMA_GENERATION, KERNEL_SCHEMA_GENERATION,
        "test-vector fixtures and the kernel ABI must share one schema generation"
    );
}
