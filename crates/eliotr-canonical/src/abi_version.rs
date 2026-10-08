//! Versioned identity for the pure-kernel TypeScript<->Rust/Wasm ABI.
//!
//! AGENTS.md fixes the boundary shape: versioned canonical UTF-8 bytes in, canonical bytes or
//! typed errors out. This module is the single source of truth for that version. It carries two
//! independent counters:
//!
//! - [`KERNEL_ABI_VERSION`] (semver `major.minor.patch`): the *operation contract* — export
//!   names, result/error shapes, and the version semantics defined here.
//! - [`KERNEL_SCHEMA_GENERATION`] (monotonic `u32`): the *data layout* generation — canonical
//!   byte layouts and vector frame formats. Must match exactly.
//!
//! Every kernel operation must call [`check_envelope`] on the caller-supplied `operation_version`
//! and `schema_generation` before touching payload bytes. Any mismatch fails closed with a typed
//! [`AbiVersionError`]; no operation may weaken this check.

#![forbid(unsafe_code)]

use core::fmt;

/// Kernel ABI operation-contract version.
///
/// `major`: incompatible contract change (removed/renamed export, changed result or error
/// shape, changed version semantics). `minor`: backwards-compatible addition (new export,
/// new error code, wider input domain). `patch`: compatible fix with no observable change.
pub const KERNEL_ABI_VERSION: &str = "1.0.0";

/// Major component of [`KERNEL_ABI_VERSION`].
pub const KERNEL_ABI_VERSION_MAJOR: u32 = 1;

/// Minor component of [`KERNEL_ABI_VERSION`].
pub const KERNEL_ABI_VERSION_MINOR: u32 = 0;

/// Patch component of [`KERNEL_ABI_VERSION`].
pub const KERNEL_ABI_VERSION_PATCH: u32 = 0;

/// Packed stamp for the Wasm boundary: `major << 16 | minor << 8 | patch`.
///
/// The stamp is the only version information that crosses the Wasm boundary as a scalar;
/// string parsing stays on the Rust side of [`AbiVersion::parse`].
pub const KERNEL_ABI_VERSION_PACKED: u32 =
    (KERNEL_ABI_VERSION_MAJOR << 16) | (KERNEL_ABI_VERSION_MINOR << 8) | KERNEL_ABI_VERSION_PATCH;

/// Schema generation for canonical data layouts and vector frame formats.
///
/// Unlike the semver contract version, the generation must match exactly: a consumer built
/// against generation 2 layouts cannot interpret generation 1 bytes and vice versa.
pub const KERNEL_SCHEMA_GENERATION: u32 = 1;

/// Stable error code for a version string that is not canonical `major.minor.patch`.
pub const ABI_VERSION_MALFORMED_CODE: &str = "ELIOTR_ABI_VERSION_MALFORMED";

/// Stable error code for a consumer whose ABI major version differs from the kernel's.
pub const ABI_VERSION_MAJOR_MISMATCH_CODE: &str = "ELIOTR_ABI_VERSION_MAJOR_MISMATCH";

/// Stable error code for a consumer newer (higher minor) than the running kernel.
pub const ABI_VERSION_CONSUMER_NEWER_CODE: &str = "ELIOTR_ABI_VERSION_CONSUMER_NEWER";

/// Stable error code for a schema generation that does not equal [`KERNEL_SCHEMA_GENERATION`].
pub const ABI_SCHEMA_GENERATION_MISMATCH_CODE: &str = "ELIOTR_ABI_SCHEMA_GENERATION_MISMATCH";

/// A parsed kernel ABI version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AbiVersion {
    /// Major component.
    pub major: u32,
    /// Minor component.
    pub minor: u32,
    /// Patch component.
    pub patch: u32,
}

/// A deterministic version-check failure. Never carries input bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbiVersionError {
    /// The version string is not canonical `major.minor.patch`.
    MalformedVersion,
    /// Consumer major differs from the kernel major: incompatible contract.
    MajorMismatch {
        /// Kernel major.
        kernel_major: u32,
        /// Consumer major.
        consumer_major: u32,
    },
    /// Consumer minor exceeds the kernel minor: the consumer speaks a newer contract.
    ConsumerNewer {
        /// Kernel minor.
        kernel_minor: u32,
        /// Consumer minor.
        consumer_minor: u32,
    },
    /// Schema generation does not equal [`KERNEL_SCHEMA_GENERATION`].
    SchemaGenerationMismatch {
        /// Expected generation.
        expected: u32,
        /// Observed generation.
        observed: u32,
    },
}

impl AbiVersionError {
    /// Returns the stable machine-readable error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::MalformedVersion => ABI_VERSION_MALFORMED_CODE,
            Self::MajorMismatch { .. } => ABI_VERSION_MAJOR_MISMATCH_CODE,
            Self::ConsumerNewer { .. } => ABI_VERSION_CONSUMER_NEWER_CODE,
            Self::SchemaGenerationMismatch { .. } => ABI_SCHEMA_GENERATION_MISMATCH_CODE,
        }
    }
}

impl fmt::Display for AbiVersionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedVersion => {
                write!(
                    formatter,
                    "kernel ABI version is not canonical major.minor.patch"
                )
            }
            Self::MajorMismatch {
                kernel_major,
                consumer_major,
            } => write!(
                formatter,
                "kernel ABI major mismatch: kernel is {kernel_major}, consumer requires {consumer_major}"
            ),
            Self::ConsumerNewer {
                kernel_minor,
                consumer_minor,
            } => write!(
                formatter,
                "consumer ABI minor {consumer_minor} is newer than kernel minor {kernel_minor}"
            ),
            Self::SchemaGenerationMismatch { expected, observed } => write!(
                formatter,
                "kernel schema generation mismatch: expected {expected}, observed {observed}"
            ),
        }
    }
}

impl std::error::Error for AbiVersionError {}

impl AbiVersion {
    /// The version of the running kernel.
    #[must_use]
    pub const fn kernel() -> Self {
        Self {
            major: KERNEL_ABI_VERSION_MAJOR,
            minor: KERNEL_ABI_VERSION_MINOR,
            patch: KERNEL_ABI_VERSION_PATCH,
        }
    }

    /// Parses a canonical `major.minor.patch` version string.
    ///
    /// Strict and fail-closed: exactly three dot-separated ASCII-digit parts, no leading zeros
    /// (except a lone `0`), no whitespace, no `v` prefix, no pre-release or build metadata,
    /// and each part must fit in a `u32`.
    ///
    /// # Errors
    ///
    /// Returns [`AbiVersionError::MalformedVersion`] for any deviation.
    pub fn parse(text: &str) -> Result<Self, AbiVersionError> {
        let mut parts = text.split('.');
        let major = parse_part(parts.next())?;
        let minor = parse_part(parts.next())?;
        let patch = parse_part(parts.next())?;
        if parts.next().is_some() {
            return Err(AbiVersionError::MalformedVersion);
        }
        Ok(Self {
            major,
            minor,
            patch,
        })
    }
}

/// Parses one canonical numeric version part.
fn parse_part(part: Option<&str>) -> Result<u32, AbiVersionError> {
    let text = part.ok_or(AbiVersionError::MalformedVersion)?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AbiVersionError::MalformedVersion);
    }
    if text.len() > 1 && text.starts_with('0') {
        return Err(AbiVersionError::MalformedVersion);
    }
    let mut value: u32 = 0;
    for byte in text.bytes() {
        value = value
            .checked_mul(10)
            .and_then(|scaled| scaled.checked_add(u32::from(byte - b'0')))
            .ok_or(AbiVersionError::MalformedVersion)?;
    }
    Ok(value)
}

/// Checks that a consumer version is compatible with the running kernel.
///
/// Compatibility rules:
/// - major must equal the kernel major, otherwise [`AbiVersionError::MajorMismatch`];
/// - consumer minor must not exceed the kernel minor, otherwise
///   [`AbiVersionError::ConsumerNewer`] (the consumer speaks a newer contract than the kernel
///   implements);
/// - patch is ignored: patch bumps are compatible fixes with no observable change.
pub fn check_consumer_compatible(consumer: &AbiVersion) -> Result<(), AbiVersionError> {
    let kernel = AbiVersion::kernel();
    if consumer.major != kernel.major {
        return Err(AbiVersionError::MajorMismatch {
            kernel_major: kernel.major,
            consumer_major: consumer.major,
        });
    }
    if consumer.minor > kernel.minor {
        return Err(AbiVersionError::ConsumerNewer {
            kernel_minor: kernel.minor,
            consumer_minor: consumer.minor,
        });
    }
    Ok(())
}

/// Checks that a schema generation equals [`KERNEL_SCHEMA_GENERATION`] exactly.
///
/// # Errors
///
/// Returns [`AbiVersionError::SchemaGenerationMismatch`] on any deviation.
pub fn check_schema_generation(generation: u32) -> Result<(), AbiVersionError> {
    if generation != KERNEL_SCHEMA_GENERATION {
        return Err(AbiVersionError::SchemaGenerationMismatch {
            expected: KERNEL_SCHEMA_GENERATION,
            observed: generation,
        });
    }
    Ok(())
}

/// Runtime gate for the operation envelope's version fields.
///
/// Parses `operation_version` as canonical semver, checks consumer compatibility, then checks
/// the schema generation. Every kernel operation must call this before touching payload
/// bytes; the first failure wins and fails closed.
pub fn check_envelope(
    operation_version: &str,
    schema_generation: u32,
) -> Result<(), AbiVersionError> {
    let consumer = AbiVersion::parse(operation_version)?;
    check_consumer_compatible(&consumer)?;
    check_schema_generation(schema_generation)
}

#[cfg(test)]
mod tests {
    use super::{
        ABI_SCHEMA_GENERATION_MISMATCH_CODE, ABI_VERSION_CONSUMER_NEWER_CODE,
        ABI_VERSION_MAJOR_MISMATCH_CODE, ABI_VERSION_MALFORMED_CODE, AbiVersion, AbiVersionError,
        KERNEL_ABI_VERSION, KERNEL_ABI_VERSION_MAJOR, KERNEL_ABI_VERSION_MINOR,
        KERNEL_ABI_VERSION_PACKED, KERNEL_ABI_VERSION_PATCH, KERNEL_SCHEMA_GENERATION,
        check_consumer_compatible, check_envelope, check_schema_generation,
    };

    #[test]
    fn version_constants_agree() {
        assert_eq!(
            AbiVersion::parse(KERNEL_ABI_VERSION),
            Ok(AbiVersion {
                major: KERNEL_ABI_VERSION_MAJOR,
                minor: KERNEL_ABI_VERSION_MINOR,
                patch: KERNEL_ABI_VERSION_PATCH,
            })
        );
        assert_eq!(
            KERNEL_ABI_VERSION_PACKED,
            (KERNEL_ABI_VERSION_MAJOR << 16)
                | (KERNEL_ABI_VERSION_MINOR << 8)
                | KERNEL_ABI_VERSION_PATCH
        );
    }

    #[test]
    fn parses_canonical_versions() {
        assert_eq!(
            AbiVersion::parse("1.0.0"),
            Ok(AbiVersion {
                major: 1,
                minor: 0,
                patch: 0
            })
        );
        assert_eq!(
            AbiVersion::parse("12.34.56"),
            Ok(AbiVersion {
                major: 12,
                minor: 34,
                patch: 56
            })
        );
    }

    #[test]
    fn rejects_malformed_versions() {
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "v1.2.3",
            " 1.2.3",
            "1.2.3 ",
            "1.02.3",
            "01.2.3",
            "1.2.3-alpha",
            "1.2.3+build",
            "a.b.c",
            "1.b.3",
            "1.2.",
            ".1.2.3",
            "4294967296.0.0",
            "١.٢.٣",
        ] {
            assert_eq!(
                AbiVersion::parse(bad),
                Err(AbiVersionError::MalformedVersion),
                "must reject {bad:?}"
            );
        }
    }

    #[test]
    fn accepts_matching_and_older_minor_consumers() {
        assert_eq!(
            check_consumer_compatible(&AbiVersion {
                major: KERNEL_ABI_VERSION_MAJOR,
                minor: KERNEL_ABI_VERSION_MINOR,
                patch: KERNEL_ABI_VERSION_PATCH,
            }),
            Ok(())
        );
        assert_eq!(
            check_consumer_compatible(&AbiVersion {
                major: KERNEL_ABI_VERSION_MAJOR,
                minor: 0,
                patch: 99,
            }),
            Ok(())
        );
    }

    #[test]
    fn rejects_major_mismatch() {
        let error = check_consumer_compatible(&AbiVersion {
            major: KERNEL_ABI_VERSION_MAJOR + 1,
            minor: 0,
            patch: 0,
        });
        assert_eq!(
            error,
            Err(AbiVersionError::MajorMismatch {
                kernel_major: KERNEL_ABI_VERSION_MAJOR,
                consumer_major: KERNEL_ABI_VERSION_MAJOR + 1,
            })
        );
        let code = match error {
            Err(failure) => failure.code(),
            Ok(()) => "unexpected-ok",
        };
        assert_eq!(code, ABI_VERSION_MAJOR_MISMATCH_CODE);
    }

    #[test]
    fn rejects_newer_consumer_minor() {
        let error = check_consumer_compatible(&AbiVersion {
            major: KERNEL_ABI_VERSION_MAJOR,
            minor: KERNEL_ABI_VERSION_MINOR + 1,
            patch: 0,
        });
        assert_eq!(
            error,
            Err(AbiVersionError::ConsumerNewer {
                kernel_minor: KERNEL_ABI_VERSION_MINOR,
                consumer_minor: KERNEL_ABI_VERSION_MINOR + 1,
            })
        );
        let code = match error {
            Err(failure) => failure.code(),
            Ok(()) => "unexpected-ok",
        };
        assert_eq!(code, ABI_VERSION_CONSUMER_NEWER_CODE);
    }

    #[test]
    fn schema_generation_must_match_exactly() {
        assert_eq!(check_schema_generation(KERNEL_SCHEMA_GENERATION), Ok(()));
        let error = check_schema_generation(KERNEL_SCHEMA_GENERATION + 1);
        assert_eq!(
            error,
            Err(AbiVersionError::SchemaGenerationMismatch {
                expected: KERNEL_SCHEMA_GENERATION,
                observed: KERNEL_SCHEMA_GENERATION + 1,
            })
        );
        let code = match error {
            Err(failure) => failure.code(),
            Ok(()) => "unexpected-ok",
        };
        assert_eq!(code, ABI_SCHEMA_GENERATION_MISMATCH_CODE);
    }

    #[test]
    fn envelope_gate_combines_both_checks() {
        assert_eq!(
            check_envelope(KERNEL_ABI_VERSION, KERNEL_SCHEMA_GENERATION),
            Ok(())
        );
        assert_eq!(
            check_envelope("not-a-version", KERNEL_SCHEMA_GENERATION),
            Err(AbiVersionError::MalformedVersion)
        );
        let malformed = check_envelope("not-a-version", KERNEL_SCHEMA_GENERATION);
        assert_eq!(malformed, Err(AbiVersionError::MalformedVersion));
        let malformed_code = match malformed {
            Err(failure) => failure.code(),
            Ok(()) => "unexpected-ok",
        };
        assert_eq!(malformed_code, ABI_VERSION_MALFORMED_CODE);
        assert_eq!(
            check_envelope(KERNEL_ABI_VERSION, KERNEL_SCHEMA_GENERATION + 1),
            Err(AbiVersionError::SchemaGenerationMismatch {
                expected: KERNEL_SCHEMA_GENERATION,
                observed: KERNEL_SCHEMA_GENERATION + 1,
            })
        );
        assert!(check_envelope("9.9.9", KERNEL_SCHEMA_GENERATION).is_err());
    }

    #[test]
    fn exposes_stable_error_codes() {
        assert_eq!(
            AbiVersionError::MalformedVersion.code(),
            ABI_VERSION_MALFORMED_CODE
        );
    }

    #[test]
    fn formats_errors_without_input_bytes() {
        assert_eq!(
            AbiVersionError::MalformedVersion.to_string(),
            "kernel ABI version is not canonical major.minor.patch"
        );
        assert_eq!(
            AbiVersionError::SchemaGenerationMismatch {
                expected: 1,
                observed: 2,
            }
            .to_string(),
            "kernel schema generation mismatch: expected 1, observed 2"
        );
    }
}
