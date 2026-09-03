from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


execution_path = Path("packages/cloudflare-ai/src/model-gateway-execution.ts")
execution = execution_path.read_text(encoding="utf-8")
execution = replace_once(
    execution,
    '''function decodeRouteDeployment(raw: unknown): ModelRouteDeployment {
  try {
    return decodeModelRouteDeployment(raw);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "registered model route deployment is invalid",
      { cause },
    );
  }
}
''',
    '''function decodeRouteDeployment(
  raw: unknown,
  errorCode: ModelGatewayExecutionErrorCode = "MODEL_GATEWAY_REQUEST_INVALID",
  message = "registered model route deployment is invalid",
): ModelRouteDeployment {
  try {
    return decodeModelRouteDeployment(raw);
  } catch (cause) {
    modelGatewayExecutionFailure(errorCode, message, { cause });
  }
}
''',
    "deployment decoder error classification",
)
execution = replace_once(
    execution,
    '''  const deployment = decodeRouteDeployment({
    route_ref: value.route_ref,
    route_version: value.route_version,
    prompt_generation: value.prompt_generation,
    schema_generation: value.schema_generation,
    parameters_digest: value.parameters_digest,
    pricing_snapshot_ref: value.pricing_snapshot_ref,
  });
''',
    '''  const deployment = decodeRouteDeployment(
    {
      route_ref: value.route_ref,
      route_version: value.route_version,
      prompt_generation: value.prompt_generation,
      schema_generation: value.schema_generation,
      parameters_digest: value.parameters_digest,
      pricing_snapshot_ref: value.pricing_snapshot_ref,
    },
    "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    "stored route fingerprint deployment is invalid",
  );
''',
    "stored fingerprint deployment classification",
)
execution_path.write_text(execution, encoding="utf-8")


test_path = Path("infra/ai-search/model-gateway-execution.test.mjs")
test = test_path.read_text(encoding="utf-8")
test = replace_once(
    test,
    '''    await expectCode(
      createModelGatewayFetchAdapter(mismatched.dependencies).resolveFingerprint(
        "dynamic/eliotr-balanced",
      ),
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    );
  });
''',
    '''    await expectCode(
      createModelGatewayFetchAdapter(mismatched.dependencies).resolveFingerprint(
        "dynamic/eliotr-balanced",
      ),
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    );

    const malformed = await fixture({
      dependencies: {
        fingerprints: {
          putImmutable: vi.fn(),
          getLatest: vi.fn(async () => ({
            ...fingerprint(await deployment()),
            parameters_digest: "not-a-sha256-digest",
          })),
        },
      },
    });
    await expectCode(
      createModelGatewayFetchAdapter(malformed.dependencies).resolveFingerprint(
        "dynamic/eliotr-balanced",
      ),
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    );
  });
''',
    "malformed persisted fingerprint negative",
)
test_path.write_text(test, encoding="utf-8")
