import { env as generatedEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { HttpRequestError } from "../src/http-errors.js";
import { handleResearchProviderKeyConfiguration } from "../src/research-provider-key-configuration-http.js";
import type { ResearchProviderKeyConfigurationService } from "../src/research-provider-key-configuration-service.js";
import { handleResearchProviderKeyModelUseHttp } from "../src/research-provider-key-model-use-http.js";
import type { ResearchProviderKeyModelUseService } from "../src/research-provider-key-model-use-service.js";

const ORIGIN = "https://core.example";
const testEnv = generatedEnv as unknown as Env;
const context: AuthenticatedRequestContext = {
  request: new Request(`${ORIGIN}/api/v1/projects/project/model-provider-key`),
  principal_ref: "owner",
  client_class: "owner_pwa",
  credential_generation: "credential-1",
  trace_id: "trace-1",
};

const unusedServiceMethod = async (): Promise<never> => {
  throw new Error("A denied provider-key mutation reached its service");
};
const configurationService = {
  read: unusedServiceMethod,
  readConfiguredOperation: unusedServiceMethod,
  create: unusedServiceMethod,
} satisfies ResearchProviderKeyConfigurationService;
const modelUseService = {
  start: unusedServiceMethod,
  read: unusedServiceMethod,
} satisfies ResearchProviderKeyModelUseService;

type ExpectedError = Readonly<{ code: string; status: number; message: string }>;
type Endpoint = Readonly<{
  name: string;
  url: string;
  invoke: (request: Request) => Promise<Response>;
  csrfError: ExpectedError;
  contentTypeError: ExpectedError;
}>;

const endpoints: readonly Endpoint[] = [
  {
    name: "provider-key configuration",
    url: `${ORIGIN}/api/v1/projects/project/model-provider-key`,
    invoke: (request) => handleResearchProviderKeyConfiguration(
      request, testEnv, context, "project", 8_192, configurationService,
    ),
    csrfError: {
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_CSRF_DENIED",
      status: 403,
      message: "Provider key changes require a same-origin owner request",
    },
    contentTypeError: {
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID",
      status: 415,
      message: "Provider key changes require application/json",
    },
  },
  {
    name: "provider-key model use",
    url: `${ORIGIN}/api/v1/projects/project/model-provider-key/key-operation/check-and-use`,
    invoke: (request) => handleResearchProviderKeyModelUseHttp(
      request, testEnv, context, "project", "key-operation", "operation", 2_048, modelUseService,
    ),
    csrfError: {
      code: "PROVIDER_KEY_MODEL_USE_CSRF_DENIED",
      status: 403,
      message: "Model-key activation requires a same-origin owner request",
    },
    contentTypeError: {
      code: "PROVIDER_KEY_MODEL_USE_INPUT_INVALID",
      status: 415,
      message: "Model-key activation requires application/json",
    },
  },
];

type DenialCase = Readonly<{
  name: string;
  headers: Readonly<Record<string, string>>;
  errorKind: "csrfError" | "contentTypeError";
}>;

const denialCases: readonly DenialCase[] = [
  {
    name: "missing Origin",
    headers: { "x-eliotr-csrf": "1", "Content-Type": "application/json" },
    errorKind: "csrfError",
  },
  {
    name: "cross-origin Origin",
    headers: { Origin: "https://attacker.example", "x-eliotr-csrf": "1", "Content-Type": "application/json" },
    errorKind: "csrfError",
  },
  {
    name: "missing CSRF token",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    errorKind: "csrfError",
  },
  {
    name: "invalid CSRF token",
    headers: { Origin: ORIGIN, "x-eliotr-csrf": "0", "Content-Type": "application/json" },
    errorKind: "csrfError",
  },
  {
    name: "disallowed Fetch-Site",
    headers: {
      Origin: ORIGIN,
      "x-eliotr-csrf": "1",
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "application/json",
    },
    errorKind: "csrfError",
  },
  {
    name: "missing Content-Type",
    headers: { Origin: ORIGIN, "x-eliotr-csrf": "1" },
    errorKind: "contentTypeError",
  },
  {
    name: "non-JSON Content-Type",
    headers: { Origin: ORIGIN, "x-eliotr-csrf": "1", "Content-Type": "text/plain" },
    errorKind: "contentTypeError",
  },
];

describe.each(endpoints)("$name mutation security", (endpoint) => {
  it.each(denialCases)("rejects $name with its endpoint-specific error", async ({ headers, errorKind }) => {
    const request = new Request(endpoint.url, { method: "POST", headers, body: "{}" });
    const result = endpoint.invoke(request);
    const expected = endpoint[errorKind];

    await expect(result).rejects.toBeInstanceOf(HttpRequestError);
    await expect(result).rejects.toMatchObject(expected);
  });
});
