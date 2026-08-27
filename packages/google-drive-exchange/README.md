# google-drive-exchange

**Class: Experiment.** Bounded transport for clients that cannot reach the private API directly.

Contains the protocol schema, the exchange asset provisioner, the append serializer, the change cursor
and reconciler, the token vault, the freeze-and-readback path and the tamper audit.

This contour is a transport workaround, not architecture. It carries an explicit expiry and a
kill condition, and it is replaced rather than extended when a first-party client integration becomes
available. Two simultaneous external client transports are not permitted.

Boundary rules:

```text
transport proves an account write, not cryptographic client authorship;
every inbound row is untrusted and candidate-only;
frozen bytes in object storage are the authority, not the transport copy;
rows are identified by identifier and hash, never by a row number;
cursor replay is the correctness path; push notification is a latency hint only.
```
