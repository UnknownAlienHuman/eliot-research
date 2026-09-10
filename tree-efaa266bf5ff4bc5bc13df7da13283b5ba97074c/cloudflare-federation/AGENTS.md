# Cloudflare federation package

This package is the sole Cloudflare persistence adapter for the generic federation boundary. It may
store only strict contract bytes bound to exact peer credential generations, bridge generation, client
fence, manifest revision and idempotency identity. Every mutation requires authoritative D1 readback;
an unknown write effect is never retried blindly. Provider transport completion never upgrades research
completion, and no D1/R2 row is evidence until the ER-22 service revalidates its signed manifest and
scope authority.
