//! Typed representation of the shared M1 conformance vectors.

#![forbid(unsafe_code)]

/// The only fixture protocol admitted by migration phase M1.
pub const VECTOR_PROTOCOL: &str = "eliotr.test-vectors.canonical-utf8.v1";

/// The schema generation admitted by migration phase M1.
pub const VECTOR_SCHEMA_GENERATION: u32 = 1;

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
    max_bytes: usize,
    input: Vec<u8>,
    expected: ExpectedOutcome,
}

impl CanonicalUtf8Vector {
    pub(crate) fn new(
        case_id: String,
        max_bytes: usize,
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

    /// Returns the explicit input byte budget.
    #[must_use]
    pub const fn max_bytes(&self) -> usize {
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
