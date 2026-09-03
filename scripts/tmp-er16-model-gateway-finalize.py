from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


request_path = Path("packages/cloudflare-ai/src/model-gateway-request.ts")
request = request_path.read_text(encoding="utf-8")
request = replace_once(
    request,
    '''import {
  prepareModelGatewayCall,
  type ModelGatewayCallPolicy,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  modelGatewayExecutionFailure,
  type CompiledModelGatewayPrompt,
  type ModelCallInput,
  type PreparedModelGatewayHttpRequest,
} from "./model-gateway-execution-contract.js";
''',
    '''import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { modelGatewayExecutionFailure } from "./model-gateway-execution-contract.js";
''',
    "request imports",
)
request = replace_once(
    request,
    '''const SHA256 = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
''',
    "",
    "request HTTP constants",
)
request = replace_once(
    request,
    '''const POLICY_HEADER_KEYS = new Set([
  "cf-aig-collect-log",
  "cf-aig-collect-log-payload",
  "cf-aig-metadata",
  "cf-aig-skip-cache",
]);
''',
    "",
    "request policy constants",
)
request = replace_once(
    request,
    "async function validateRequestBody(\n",
    "export async function validateModelGatewayRequestBody(\n",
    "request body validator export",
)
http_start = request.find("function reasoningEndpoint(baseUrl: string): string {")
if http_start < 0:
    raise SystemExit("request HTTP preparation section not found")
request = request[:http_start].rstrip() + "\n"
request_path.write_text(request, encoding="utf-8")


response_path = Path("packages/cloudflare-ai/src/model-gateway-response.ts")
response = response_path.read_text(encoding="utf-8")
response = replace_once(
    response,
    '''const POLICY_ERROR_CODES = new Set([2016, 2017, 2029, 2030]);
const RATE_LIMIT_ERROR_CODES = new Set([2003]);
''',
    "",
    "response HTTP failure constants",
)
for old, new, label in (
    ("function plainObject(value: unknown)", "export function plainObject(value: unknown)", "plain object export"),
    ("async function readBoundedBody(\n", "export async function readBoundedBody(\n", "bounded body export"),
    ("function validateBoundedJson(value: unknown, depth: number, state: JsonState): void {", "export function validateBoundedJson(value: unknown, depth: number, state: JsonState): void {", "bounded JSON export"),
    ("function decodeDlpAction(headers: Headers): \"FLAG\" | \"BLOCK\" | undefined {", "export function decodeDlpAction(headers: Headers): \"FLAG\" | \"BLOCK\" | undefined {", "DLP export"),
):
    response = replace_once(response, old, new, label)
failure_start = response.find("function possibleErrorCode(value: unknown): number | undefined {")
decode_start = response.find("export async function decodeModelGatewayResponse(")
if failure_start < 0 or decode_start < 0 or failure_start >= decode_start:
    raise SystemExit("response HTTP failure section not found")
response = response[:failure_start].rstrip() + "\n\n" + response[decode_start:]
response_path.write_text(response, encoding="utf-8")


execution_path = Path("packages/cloudflare-ai/src/model-gateway-execution.ts")
execution = execution_path.read_text(encoding="utf-8")
execution = replace_once(
    execution,
    '''import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  prepareModelGatewayHttpRequest,
} from "./model-gateway-request.js";
import {
  decodeModelGatewayResponse,
  rejectModelGatewayHttpFailure,
} from "./model-gateway-response.js";
''',
    '''import { prepareModelGatewayHttpRequest } from "./model-gateway-http-request.js";
import { rejectModelGatewayHttpFailure } from "./model-gateway-http-failure.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import { decodeModelGatewayResponse } from "./model-gateway-response.js";
''',
    "execution split imports",
)
execution_path.write_text(execution, encoding="utf-8")


index_path = Path("packages/cloudflare-ai/src/index.ts")
index = index_path.read_text(encoding="utf-8")
index = replace_once(
    index,
    '''export {
  canonicalModelGatewayJson,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  prepareModelGatewayHttpRequest,
} from "./model-gateway-request.js";
export {
  decodeModelGatewayResponse,
  rejectModelGatewayHttpFailure,
} from "./model-gateway-response.js";
''',
    '''export { prepareModelGatewayHttpRequest } from "./model-gateway-http-request.js";
export { rejectModelGatewayHttpFailure } from "./model-gateway-http-failure.js";
export {
  canonicalModelGatewayJson,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
} from "./model-gateway-request.js";
export { decodeModelGatewayResponse } from "./model-gateway-response.js";
''',
    "index split exports",
)
index_path.write_text(index, encoding="utf-8")


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
doc_path.write_text(doc, encoding="utf-8")
