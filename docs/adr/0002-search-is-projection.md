# ADR-0002: Search planes are rebuildable projections

**Status:** accepted

D1 Search and AI Search locate material but never own evidence. A cited result must resolve an
`EvidenceHandle` against D1 Core/R2 Evidence under the frozen scope, current owner generation, purge
state, coordinate map, byte length, and digest. Deleting either index must not destroy source, Wiki,
investigation, or artifact truth.
