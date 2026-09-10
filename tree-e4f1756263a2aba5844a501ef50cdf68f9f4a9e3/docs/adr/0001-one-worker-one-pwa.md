# ADR-0001: One Worker application plus static PWA

**Status:** accepted

All server packages compile into `eliotr-core`; `eliotr-pwa` is served through Static Assets. Packages
are capability libraries, not deployable services. This avoids distributed authority, cross-service
transactions, duplicated credentials, and unnecessary operational surfaces while workload remains
within the bounded Workers profile.
