# contracts

Versioned wire and domain types shared by every other package, including the federation contract that
ELIOT Memory OS already owns.

- **Owns:** request and response shapes, dispositions, receipts, evidence handles, scope expressions.
- **Must not own:** platform bindings, vendor clients, policy decisions.

The federation types are implemented against the existing ELIOT contract fixtures. The cloud side does
not invent a more convenient alternative shape.
