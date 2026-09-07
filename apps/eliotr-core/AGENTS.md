# Agent ER-24 — Worker composition and live coordination

`eliotr-core` is the only deployable Worker/composition root: parse/authenticate, call an application
service, map a typed response, emit telemetry. Business rules belong in packages. Unimplemented routes
fail closed with 503/501; never pretend a job/mutation succeeded.
