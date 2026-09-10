# ADR-0004: New Durable Object uses declarative export with SQLite storage

**Status:** accepted

`ResearchSession` is declared through Wrangler `exports` with SQLite storage. No legacy migration block
is introduced for this new class. The class owns compact live coordination only; D1/R2 remain durable
authority for transcript, investigation, receipts, and artifacts.
