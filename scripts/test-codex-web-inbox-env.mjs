import assert from "node:assert/strict";
import { codexEnvironment } from "./codex-web-inbox.mjs";

const childEnvironment = codexEnvironment({
  PATH: "fixture-path",
  OPENAI_API_KEY: "private-provider-value",
  ANTHROPIC_API_KEY: "private-provider-value",
  ELIOTR_WEB_INBOX_CLIENT_SECRET: "access-secret",
  eliotr_web_inbox_challenge_token: "challenge-secret",
  CF_ACCESS_CLIENT_ID: "access-client-id",
  cf_access_client_secret: "access-client-secret",
  MCP_ACCESS_SERVICE_TOKENS: "mcp-access-secret",
  cloudflare_access_token: "cloudflare-access-secret",
  cloudflare_api_token: "cloudflare-api-secret",
});

assert.deepEqual(childEnvironment, {
  PATH: "fixture-path",
  OPENAI_API_KEY: "private-provider-value",
  ANTHROPIC_API_KEY: "private-provider-value",
});
process.stdout.write("PASS Codex child env strips case-insensitive Access credentials and preserves provider env\n");
