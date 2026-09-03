from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


path = Path("infra/ai-search/model-gateway-execution.test.mjs")
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    '''    const invalidCalls = [
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        compiledPrompt,
        `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/other-gateway`,
        TOKEN,
      ),
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        compiledPrompt,
        BASE_URL,
        `Bearer ${TOKEN}`,
      ),
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        await compiled(requestBody({ tools: [] })),
        BASE_URL,
        TOKEN,
      ),
      prepareModelGatewayHttpRequest(
        input({ max_input_bytes: 64 }),
        deployed,
        compiledPrompt,
        BASE_URL,
        TOKEN,
      ),
      prepareModelGatewayHttpRequest(
        input(),
        await deployment(requestBody({ max_tokens: 9_000 })),
        await compiled(requestBody({ max_tokens: 9_000 })),
        BASE_URL,
        TOKEN,
      ),
    ];
    for (const call of invalidCalls) {
      await expectCode(call, "MODEL_GATEWAY_REQUEST_INVALID");
    }
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        compiledPrompt,
        BASE_URL,
        " token-with-space ",
      ),
      "MODEL_GATEWAY_CREDENTIAL_INVALID",
    );
''',
    '''    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        compiledPrompt,
        `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/other-gateway`,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    const unsafeBody = requestBody({ tools: [] });
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        await compiled(unsafeBody),
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    await expectCode(
      prepareModelGatewayHttpRequest(
        input({ max_input_bytes: 64 }),
        deployed,
        compiledPrompt,
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    const oversizedOutput = requestBody({ max_tokens: 9_000 });
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        await deployment(oversizedOutput),
        await compiled(oversizedOutput),
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    for (const invalidToken of [`Bearer ${TOKEN}`, " token-with-space "]) {
      await expectCode(
        prepareModelGatewayHttpRequest(
          input(),
          deployed,
          compiledPrompt,
          BASE_URL,
          invalidToken,
        ),
        "MODEL_GATEWAY_CREDENTIAL_INVALID",
      );
    }
''',
    "sequential request rejection corpus",
)
path.write_text(source, encoding="utf-8")
