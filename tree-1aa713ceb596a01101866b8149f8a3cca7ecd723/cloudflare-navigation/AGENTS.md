# Cloudflare navigation application library

This is a library inside the one `eliotr-core` Worker, not a second service. ER-24 owns orientation
I/O orchestration; ER-30 owns the scope application service; ER-31 owns navigation. The old core files
are compatibility exports, not duplicate implementations. Pure algorithms remain in domain/retrieval
and follow the normative Rust promotion plan. No model/provider call, authentication bypass or implicit
source read policy belongs here. See `docs/implementation/local-launch.md` for the active owner profile.
