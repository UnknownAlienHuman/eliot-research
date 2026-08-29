# Security and policy checklist

## Before retrieval or model context

- [ ] Principal/service identity authenticated.
- [ ] Scope expression resolved and frozen.
- [ ] Current purge ledger applied.
- [ ] Security read, source/task, client disclosure, and inference disclosure checked separately.
- [ ] AllowedReferenceManifest bound to exact scope, provider/policy generations, tools, verifiers,
      precision ceilings, expiry, and client fence.
- [ ] Source text wrapped as typed untrusted data with instruction taint and effect ceiling.
- [ ] Side-effect-capable tools absent from research generation.

## Before publication/export

- [ ] Every material citation exactly resolves.
- [ ] Source sufficiency and supplied-excerpt sufficiency checked independently.
- [ ] Unsupported precision is typed, narrowed, or removed.
- [ ] SelectionIntegrityReceipt covers membership-changing rerank/prune/summary/export.
- [ ] No source instruction elevated to system/tool/policy authority.
- [ ] Disclosure dependency closure includes all source dependencies.
- [ ] Derived output is not considered declassified without a valid DeclassificationReceipt.

## Secrets and credentials

- Provider keys remain in AI Gateway/Secrets Store.
- Google client secret and token KEK are Worker secrets.
- Refresh tokens are AES-GCM encrypted in D1; access tokens are short-lived.
- Browser, ChatGPT, and agents receive no D1/R2/AI Search/Queue/Workflow/provider credential.
- Logs/metrics contain no prompt body, source text, private path, token, or evidence excerpt.

## Erasure

Only ErasureCoordinator may invoke `erc.privacy.erasure.v1`. Ordinary owner API, Steward, agents, Wiki,
and research code have no hard-delete capability. Completion requires exact requested-location equality
and absence verification; dependent artifacts lose support or become pending revalidation.
