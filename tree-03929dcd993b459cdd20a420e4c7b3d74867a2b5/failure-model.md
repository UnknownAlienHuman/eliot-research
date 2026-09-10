# Failure model

Every mutation follows `Intent → Attempt → Receipt → Readback → Reconciliation`. A timeout or lost
response is unknown outcome, not proof of failure.

| Failure | Required behavior |
|---|---|
| duplicate HTTP/Drive/Queue delivery | return existing idempotent receipt; never duplicate authority |
| response lost after write | read/reconcile by immutable ID and digest |
| D1 CAS conflict | reload head, return typed conflict or retry boundedly |
| Queue unavailable | outbox remains pending and sweeper retries |
| Queue message without intent | reject/dead-letter; never synthesize work from payload |
| R2 promotion timeout | read canonical/staging keys and hashes before retry |
| AI Search unavailable/stale | exact/lexical fallback where valid; declare degraded coverage |
| missing evidence revision/map/digest | typed gap; never substitute current convenient bytes |
| owner generation changed | reject stale write/reference and refresh scope |
| post-freeze evidence discovered | reopen Investigation, create new freeze revision, rerun affected checks |
| model/provider timeout | settle attempt honestly; keep partial objects and next probe |
| budget exhausted | stop premium calls; preserve evidence access and less-assertive disposition |
| Drive cursor poll failure | do not advance cursor; bounded backoff |
| Drive historical edit/reorder/delete | identify by ID/hash; mark `TRANSPORT_TAMPERED`; frozen R2 copy remains |
| partial Drive payload | no job starts |
| OAuth revoked | `REAUTH_REQUIRED`; ERC core remains available |
| erasure location blocked | `BLOCKED` with review date; never emit complete receipt |
| restore contains purged bytes | quarantine/delete before reads or projection rebuild |

Retries must have an explicit maximum, idempotency identity, and observable reason code. Catch-all retries
around policy denial, schema mismatch, integrity failure, or stale generation are prohibited.
