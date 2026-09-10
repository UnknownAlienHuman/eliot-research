# Additive work-packet fragments

The original generated `manifest.json` remains stable. New packets may be added as one-file fragments
with protocol `eliotr.agent-work.packet.v1`. `scripts/check-work-packets.mjs` merges fragments only after
validating that they do not duplicate packet IDs, overlap ownership, or introduce dependency cycles.
Fragments cannot override an existing packet.
