# Golden Corpus bootstrap

This directory is executable evaluation input, not prose documentation. `manifest.json` pins every
fixture source by SHA-256 and lists individual cases. A case passes only when all required atoms and
exact handles are present, every forbidden collapse is absent, and the observed coverage satisfies the
named requirement.

The bootstrap set covers recommendation/decision, hypothesis/observation, active/superseded state,
number + unit + condition, scope-sensitive contradiction, complete-scope absence, source prompt
injection, and redacted evidence. It is deliberately small. ER-23 must add admitted real project
revisions before any model, prompt, parser, retrieval, or embedding generation can be promoted.
