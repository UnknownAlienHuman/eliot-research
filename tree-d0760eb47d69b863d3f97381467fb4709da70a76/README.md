# eliotr-core

The single deployable Worker application. One deployment, not a service mesh.

Contains the owner API, the Memory OS federation endpoint, the private agent surface, the exchange
adapter, the queue consumer, the live session coordination class and the research workflow class.

Workers execute bounded orchestration only: authorize and validate, resolve scope, read and write
compact metadata, stream bytes to and from object storage, call retrieval and model gateways, start or
resume a workflow, return handles and receipts.

They do not execute native binaries, child processes, document or OCR engines, embedded search
databases, repository clones, whole-corpus loads or long synchronous CPU loops. If a feature needs any
of those, it does not belong in the Worker.
