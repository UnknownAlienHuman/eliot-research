from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


test_path = Path("infra/ai-search/model-gateway-execution.test.mjs")
test = test_path.read_text(encoding="utf-8")
response_count = test.count("new Response(")
if response_count != 3:
    raise SystemExit(f"global Response references: expected 3, found {response_count}")
test = test.replace("new Response(", "new globalThis.Response(")
test = replace_once(
    test,
    "new TextDecoder()",
    "new globalThis.TextDecoder()",
    "global TextDecoder reference",
)
test = replace_once(
    test,
    "new TextEncoder()",
    "new globalThis.TextEncoder()",
    "global TextEncoder reference",
)
test = replace_once(
    test,
    '''      prepareModelGatewayHttpRequest(
        input(),
        await deployment(requestBody({ tools: [] })),
        await compiled(requestBody({ tools: [] })),
        BASE_URL,
        TOKEN,
      ),
''',
    '''      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        await compiled(requestBody({ tools: [] })),
        BASE_URL,
        TOKEN,
      ),
''',
    "unsafe body negative setup",
)
test_path.write_text(test, encoding="utf-8")


doc_path = Path("docs/agent-work/ER-16-ai-search-and-model-gateway-adapters.md")
doc = doc_path.read_text(encoding="utf-8")
heading = "## Active implementation slice — reasoning-gateway fetch execution boundary"
if heading in doc:
    raise SystemExit("reasoning-gateway fetch documentation already exists")
doc = doc.rstrip() + """

## Active implementation slice — reasoning-gateway fetch execution boundary

The transport-neutral policy compiler is now connected to a bounded fetch execution adapter in the
`@eliotr/cloudflare-ai` package. The provider contract was rechecked against the official Cloudflare
Authenticated Gateway, Dynamic Route, request-handling, caching, DLP and Guardrail documentation on
2026-09-03.

The execution boundary:

- resolves an exact registered Dynamic Route deployment and validates route, prompt, schema and evidence
  generations before compiling or sending a prompt;
- admits only a trusted compiler result whose canonical request bytes and invocation-parameter projection
  match independent SHA-256 bindings, including the deployment's immutable parameter digest;
- sends one non-streaming request only to the exact
  `eliotr-reasoning/compat/chat/completions` endpoint;
- authenticates the `gateway.ai.cloudflare.com` endpoint with `cf-aig-authorization`; it never places the
  Cloudflare token in the provider `Authorization` header;
- overrides generic AI Gateway retries to one attempt, while any provider fallback remains an explicit
  node inside the versioned Dynamic Route;
- requires payload logging disabled, metadata logging enabled and cache bypassed;
- strictly decodes one complete assistant choice, reconciled usage, actual provider/model headers, the
  gateway log ID and optional successful Dynamic Route step;
- rejects output truncation, provider refusal, content filtering, cache hits, DLP flags/blocks and
  Guardrail blocks before immutable output publication;
- persists the exact provider response and selected route fingerprint only through digest-verified
  immutable ports, then prices observed tokens against the deployment's pinned pricing snapshot;
- emits a compact `ModelCallReceipt` only after output, fingerprint and pricing parity all hold.

A transport exception is treated as an unknown upstream execution outcome and is not retried by this
adapter. Durable call idempotency, lost-acknowledgement reconciliation and prevention of duplicate paid
execution across Workflow retries remain owned by ER-09. The executable corpus is fixture-only. No live
model call, provider fallback, spend-limit, DLP, Guardrail, billing, output-store or fingerprint-store
operation was executed; all such receipts remain `NOT EXECUTED`.
"""
doc_path.write_text(doc + "\n", encoding="utf-8")
