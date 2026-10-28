-- Provider configuration contains no credentials. Catalogues refresh explicitly.
ALTER TABLE settings ADD COLUMN model_providers_json TEXT NOT NULL DEFAULT
'[{"id":"workers-ai","type":"workers-ai","gatewaySlug":null,"gatewayPath":"","baseUrl":null,"enabled":true},{"id":"openrouter","type":"openai-compatible","gatewaySlug":"openrouter","gatewayPath":"v1","baseUrl":"https://openrouter.ai/api/v1","enabled":true},{"id":"command-code","type":"openai-compatible","gatewaySlug":"custom-command-code","gatewayPath":"v1","baseUrl":"https://api.commandcode.ai/provider/v1","enabled":true}]';
