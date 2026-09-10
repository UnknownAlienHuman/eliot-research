# ADR-0003: Google Drive Exchange is an expiring transport

**Status:** accepted, class Experiment

Drive carries append-only candidate requests and delivery copies for clients lacking the private API.
It is not a backend, evidence authority, or identity proof. Correctness comes from exact IDs/hashes,
cursor replay, immutable R2 freeze, D1 idempotency, and readback. A native transport replaces Drive;
two simultaneous ChatGPT write transports are prohibited.
