# Agent ER-24 — Worker composition and live coordination

`eliotr-core` is the only deployable Worker. Keep it a composition root: parse/authenticate, call an
application service, map a typed response, and emit telemetry. Business rules belong in packages.
Unimplemented routes fail closed with 503/501; they must never pretend a job or mutation succeeded.
