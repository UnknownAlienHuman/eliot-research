//! Typed representation and architecture-independent limits for the shared M1 vectors.

#![forbid(unsafe_code)]

/// The only fixture protocol admitted by migration phase M1.
pub const VECTOR_PROTOCOL: &str = "eliotr.test-vectors.canonical-utf8.v1";

/// Exact protocol header required at the start of every fixture frame.
pub const VECTOR_PROTOCOL_HEADER: &str = "# protocol=eliotr.test-vectors.canonical-utf8.v1";

/// The schema generation admitted by migration phase M1.
pub const VECTOR_SCHEMA_GENERATION: u32 = 1;

/// Maximum UTF-8 byte length of one complete vector frame.
pub const MAX_VECTOR_FRAME_BYTES: usize = 1024 * 1024;

/// Maximum number of cases admitted by one vector frame.
pub const MAX_VECTOR_CASES: usize = 4096;

/// Maximum byte length of one ASCII case identity.
pub const MAX_VECTOR_CASE_ID_BYTES: usize = 128;

/// Maximum decoded byte length of an input or successful output field.
pub const MAX_VECTOR_PAYLOAD_BYTES: usize = 256 * 1024;

/// Maximum transport budget representable identically by native Rust, Rust/Wasm, and TypeScript.
pub const MAX_VECTOR_MAX_BYTES: u32 = u32::MAX;

/// A parsed set of strict conformance cases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VectorSet {
    schema_generation: u32,
    cases: Vec<CanonicalUtf8Vector>,
}

impl VectorSet {
    pub(crate) fn new(schema_generation: u32, cases: Vec<CanonicalUtf8Vector>) -> Self {
        Self {
            schema_generation,
            cases,
        }
    }

    /// Returns the admitted fixture schema generation.
    #[must_use]
    pub const fn schema_generation(&self) -> u32 {
        self.schema_generation
    }

    /// Returns all cases in declared order.
    #[must_use]
    pub fn cases(&self) -> &[CanonicalUtf8Vector] {
        &self.cases
    }
}

/// One bounded UTF-8 transport conformance case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalUtf8Vector {
    case_id: String,
    max_bytes: u32,
    input: Vec<u8>,
    expected: ExpectedOutcome,
}

impl CanonicalUtf8Vector {
    pub(crate) fn new(
        case_id: String,
        max_bytes: u32,
        input: Vec<u8>,
        expected: ExpectedOutcome,
    ) -> Self {
        Self {
            case_id,
            max_bytes,
            input,
            expected,
        }
    }

    /// Returns the stable fixture-local case identity.
    #[must_use]
    pub fn case_id(&self) -> &str {
        &self.case_id
    }

    /// Returns the fixed-width input byte budget.
    #[must_use]
    pub const fn max_bytes(&self) -> u32 {
        self.max_bytes
    }

    /// Returns the exact input bytes.
    #[must_use]
    pub fn input(&self) -> &[u8] {
        &self.input
    }

    /// Returns the expected deterministic outcome.
    #[must_use]
    pub const fn expected(&self) -> &ExpectedOutcome {
        &self.expected
    }
}

/// Expected result of a bounded UTF-8 transport case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpectedOutcome {
    /// Validation succeeds and preserves these exact bytes.
    Success {
        /// Exact output bytes.
        output: Vec<u8>,
    },
    /// Validation fails with this stable code.
    Error(ExpectedError),
}

/// Expected typed error without source bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedError {
    /// Input exceeded its explicit byte limit.
    TooLarge,
    /// Input was not valid UTF-8.
    InvalidUtf8,
}

impl ExpectedError {
    /// Returns the stable kernel error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TooLarge => eliotr_canonical::UTF8_TOO_LARGE_CODE,
            Self::InvalidUtf8 => eliotr_canonical::UTF8_INVALID_CODE,
        }
    }
}
