# S69 — Verify actual disclosure and prompt-injection boundaries

Baseline: `a2aca127`; ER-03/17/24. Integrate existing evaluator/firewall behavior, not a new security framework. Test each path when its caller exists; unit tests alone cannot establish absence of vulnerabilities.

## 1. Problem

Permission to read a document does not authorize disclosure to every model or agent. Source/model text cannot select tools, verifiers, grants, callback destinations, or publication authority.

## 2. Required change

Trace policy order and taint from admitted bytes through retrieval/EvidencePack/AllowedReferenceManifest to model dispatch, artifacts, and API/MCP/Google/federation output. Repair demonstrated missing checks and retain negative fixtures through actual callers.

## 3. Documentation and exact search anchors

[ER-03: Required implementation and Mandatory negative boundary](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md).

```sh
git grep -n -F 'Permission to view never implies model/client disclosure.' -- docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md
```

## 4. Implementation approach

Use packages/policy, verified HTTP/MCP actors, and existing context/output compilers. Cover viewer-allowed/model-denied, model-allowed/client-denied, mid-read revocation, injected erase/publish/exfiltration, fabricated handles/tools/URLs, forged audience/principal/Origin/cookies, and S39 unsafe redirects/private targets. Check before and after external work, not just UI visibility.

Keep side-effect tools outside the generation surface while preserving separately authorized owner actions. Render body/HTML/Markdown without executing scripts or unsafe links. Tokens/cookies/source/model bodies must not leak into logs, nested causes, or metrics. Use existing dependency/secret/license checks and classify findings accurately instead of excluding directories to hide them.

## 5. Acceptance criteria

- [ ] Every specified denial case prevents forbidden network/provider/D1 effects and disclosure; legitimate owner/agent paths continue to work.
- [ ] Source instructions cannot change manifests/tools/verifiers/policy; fabricated citations are not accepted and PWA XSS does not execute.
- [ ] Revocation during stream/output remains enforced; read permission does not become declassification.
- [ ] Negative tests exercise real application services and D1/R2 with controlled external boundaries.
- [ ] Record exact SHA, threat matrix, and results. Native T5 qualification is separate; no universal vulnerability-free claim follows from this fixture set.
