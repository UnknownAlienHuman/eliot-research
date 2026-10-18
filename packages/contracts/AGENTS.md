# Contracts

Follow the [current architecture](../../docs/architecture/ELIOT_RESEARCH.md) and root working rules.
Keep actual external/persisted shapes here without platform imports. Validate untrusted values at their
boundary, including bounded data and security-relevant fields; do not repeat decoding inside typed code.
Change internal types and all callers together. Version only a real incompatible external/persisted boundary
with an observed consumer or stored data; no version/compatibility note for every field edit.
Remove replaced codecs, exports and obsolete fixtures in that integration. Preserve needed saved data with
one-time conversion rather than a permanent collection of prototype versions. Compile/lint while implementing;
product tests follow assembly. Old ER-01 requirements do not create a separate schema-generation programme.
