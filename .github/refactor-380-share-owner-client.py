from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text.rstrip() + "\n", encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new))


client_path = "packages/owner-api-client/src/transport/client.ts"
client_text = read(client_path)
if "export type OwnerApiClient = ReturnType<typeof createOwnerApiClient>;" in client_text:
    raise SystemExit("OwnerApiClient type already exists")
write(client_path, client_text.rstrip() + "\n\nexport type OwnerApiClient = ReturnType<typeof createOwnerApiClient>;\n")

legacy_path = "packages/owner-api-client/src/legacy/http.ts"
replace_once(
    legacy_path,
    '''/** Legacy-compatible request seam over the accepted side-effect-free transport.
 *
 * C1.4 owns no product code: the legacy package keeps its own transport until U6 retires it. This
 * adapter only lets existing callers keep their request shapes while the injected owner client
 * provides path policy, protected headers, deadlines and authorization observation. The module
 * never imports the legacy package, so `instanceof` for legacy errors stays with the caller's
 * factory and applies to every typed failure, including body-parser errors.
 */

import { createOwnerApiClient, OwnerClientError } from '../transport/client';
import { OwnerBodyError } from '../transport/body';
import type { OwnerClientPorts, RequestOptions } from '../transport/client';
import type { SessionEpoch } from '../transport/session/epoch';

export interface LegacyHttpPorts extends OwnerClientPorts {
  readonly epoch: SessionEpoch;
}
''',
    '''/** Legacy request-shape seam over one injected side-effect-free owner client.
 *
 * The adapter owns no transport, epoch, active request set or disposal lifecycle. Existing callers
 * keep their request signatures while the shared owner client provides path policy, protected
 * headers, deadlines and authorization observation. Legacy error identity stays with the caller's
 * factory and applies to every typed failure, including body-parser errors.
 */

import { OwnerClientError } from '../transport/client';
import { OwnerBodyError } from '../transport/body';
import type { OwnerApiClient, RequestOptions } from '../transport/client';
''',
)
replace_once(
    legacy_path,
    '''  requestApiText(path: string, signal?: AbortSignal, maximumBytes?: number): Promise<LegacyTextResponse>;
  dispose(): void;
}

export function createLegacyHttpAdapter(ports: LegacyHttpPorts, errorFactory: LegacyErrorFactory): LegacyHttpAdapter {
  const client = createOwnerApiClient(ports);
''',
    '''  requestApiText(path: string, signal?: AbortSignal, maximumBytes?: number): Promise<LegacyTextResponse>;
}

export function createLegacyHttpAdapter(client: OwnerApiClient, errorFactory: LegacyErrorFactory): LegacyHttpAdapter {
''',
)
replace_once(
    legacy_path,
    '''    },
    dispose() {
      client.dispose();
    },
  };
}
''',
    '''    },
  };
}
''',
)

replace_once(
    "packages/owner-api-client/src/index.ts",
    "export type { OwnerClientPorts, RequestOptions, BinaryUploadOptions, EpochPort, AuthorizationLoss, TimerPort } from './transport/client';",
    "export type { OwnerApiClient, OwnerClientPorts, RequestOptions, BinaryUploadOptions, EpochPort, AuthorizationLoss, TimerPort } from './transport/client';",
)
replace_once(
    "packages/owner-api-client/src/index.ts",
    "export type { LegacyHttpAdapter, LegacyHttpPorts, LegacyErrorFactory, LegacyErrorDetails, LegacyBytesResponse, LegacyTextResponse } from './legacy/http';",
    "export type { LegacyHttpAdapter, LegacyErrorFactory, LegacyErrorDetails, LegacyBytesResponse, LegacyTextResponse } from './legacy/http';",
)

runtime_path = "apps/eliotr-web/src/app/runtime.ts"
replace_once(
    runtime_path,
    '''  const http = createLegacyHttpAdapter(clientPorts, errorFactory);
  const binary = createOwnerApiClient(clientPorts);
''',
    '''  const binary = createOwnerApiClient(clientPorts);
  const http = createLegacyHttpAdapter(binary, errorFactory);
''',
)
replace_once(
    runtime_path,
    '''    dispose() { projection.dispose(); http.dispose(); binary.dispose(); },
''',
    '''    dispose() { projection.dispose(); binary.dispose(); },
''',
)
replace_once(
    runtime_path,
    '''      const probeEpoch = createSessionEpoch();
      const probeHttp = createLegacyHttpAdapter({ fetch: ports.fetch, baseUrl: ports.baseUrl, timers: ports.timers, epoch: probeEpoch }, errorFactory);
      try {
''',
    '''      const probeEpoch = createSessionEpoch();
      const probeClient = createOwnerApiClient({ fetch: ports.fetch, baseUrl: ports.baseUrl, timers: ports.timers, epoch: probeEpoch });
      const probeHttp = createLegacyHttpAdapter(probeClient, errorFactory);
      try {
''',
)
replace_once(
    runtime_path,
    '''      finally { probeEpoch.dispose(); probeHttp.dispose(); }
''',
    '''      finally { probeClient.dispose(); probeEpoch.dispose(); }
''',
)

http_test = "packages/owner-api-client/src/legacy/http.test.ts"
replace_once(
    http_test,
    "import { createLegacyHttpAdapter, type LegacyErrorFactory, type LegacyHttpPorts } from './http';\nimport { OwnerClientError, type AuthorizationLoss } from '../transport/client';",
    "import { createLegacyHttpAdapter, type LegacyErrorFactory } from './http';\nimport { createOwnerApiClient, OwnerClientError, type AuthorizationLoss } from '../transport/client';",
)
replace_once(
    http_test,
    '''const build = (fetchImpl: typeof fetch, epoch: Epoch, sink: AuthorizationLoss[] = []) => {
  const ports: LegacyHttpPorts = {
    fetch: fetchImpl,
    baseUrl: 'https://owner.test/',
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    epoch,
    onAuthorizationLoss: (observation) => sink.push(observation),
  };
  return { adapter: createLegacyHttpAdapter(ports, legacyError), sink };
};
''',
    '''const build = (fetchImpl: typeof fetch, epoch: Epoch, sink: AuthorizationLoss[] = []) => {
  const client = createOwnerApiClient({
    fetch: fetchImpl,
    baseUrl: 'https://owner.test/',
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    epoch,
    onAuthorizationLoss: (observation) => sink.push(observation),
  });
  return { adapter: createLegacyHttpAdapter(client, legacyError), client, sink };
};
''',
)
replace_once(
    http_test,
    '''  it('disposes only the client and leaves the external epoch untouched', async () => {
    const epoch = createSessionEpoch();
    const { adapter } = build((async () => json(200, { ok: true })) as typeof fetch, epoch);
    expect(epoch.capture()).toBeDefined();
    adapter.dispose();
    expect(epoch.capture()).toBeDefined();
    expect(epoch.isCurrent(epoch.capture())).toBe(true);
    const error = await adapter.requestApi('/api/v1/after').catch((caught: unknown) => caught);
    expect((error as OwnerClientError).code).toBe('API_SESSION_CLOSED');
  });
''',
    '''  it('shares client disposal while leaving the external epoch untouched', async () => {
    const epoch = createSessionEpoch();
    const { adapter, client } = build((async () => json(200, { ok: true })) as typeof fetch, epoch);
    expect(epoch.capture()).toBeDefined();
    client.dispose();
    expect(epoch.capture()).toBeDefined();
    expect(epoch.isCurrent(epoch.capture())).toBe(true);
    const error = await adapter.requestApi('/api/v1/after').catch((caught: unknown) => caught);
    expect((error as OwnerClientError).code).toBe('API_SESSION_CLOSED');
  });
''',
)
replace_once(
    http_test,
    '''    const ports: LegacyHttpPorts = { fetch: async () => new Response(new Uint8Array([42]), { status: 206, headers: { "content-type": "application/octet-stream" } }), baseUrl: "https://owner.test", epoch, timers: { setTimeout: () => 0, clearTimeout() {} } };
    const api = createLegacyHttpAdapter(ports, legacyError);
    await expect(api.requestReauthorizedSectionBytes("/api/v1/research/artifact/artifact-1%3A1/sections/section-1%3A1/reauthorize")).rejects.toBeInstanceOf(LegacyError);
    api.dispose();
''',
    '''    const client = createOwnerApiClient({ fetch: async () => new Response(new Uint8Array([42]), { status: 206, headers: { "content-type": "application/octet-stream" } }), baseUrl: "https://owner.test", epoch, timers: { setTimeout: () => 0, clearTimeout() {} } });
    const api = createLegacyHttpAdapter(client, legacyError);
    await expect(api.requestReauthorizedSectionBytes("/api/v1/research/artifact/artifact-1%3A1/sections/section-1%3A1/reauthorize")).rejects.toBeInstanceOf(LegacyError);
    client.dispose();
''',
)

reauth_test = "packages/owner-api-client/src/evidence/citations/reauthorization.test.ts"
replace_once(
    reauth_test,
    "import type { EpochPort } from '../../transport/client.js';",
    "import { createOwnerApiClient, type EpochPort } from '../../transport/client.js';",
)
replace_once(
    reauth_test,
    '''    const sharedEpoch: SessionEpoch = createSessionEpoch();
    const legacy = createLegacyHttpAdapter(
      { fetch: fetchImpl, baseUrl: 'https://owner.example', timers, epoch: sharedEpoch },
      errors,
    );
''',
    '''    const sharedEpoch: SessionEpoch = createSessionEpoch();
    const client = createOwnerApiClient({ fetch: fetchImpl, baseUrl: 'https://owner.example', timers, epoch: sharedEpoch });
    const legacy = createLegacyHttpAdapter(client, errors);
''',
)
replace_once(
    reauth_test,
    '''    expect(view.cited_evidence).toHaveLength(1);
    expect(view.protocol).toBe('eliotr.artifact-draft-citations-reauthorization.v1');
  });
});
''',
    '''    expect(view.cited_evidence).toHaveLength(1);
    expect(view.protocol).toBe('eliotr.artifact-draft-citations-reauthorization.v1');
    client.dispose();
  });
});
''',
)

replace_once(
    "packages/owner-api-client/src/sources/import/raw.test.ts",
    "  const http = createLegacyHttpAdapter(ports, errors);",
    "  const http = createLegacyHttpAdapter(binary, errors);",
)

replace_once(
    "docs/implementation/backend-entrypoints.md",
    '''Make all React callers share one client, session epoch, cancellation and error model. Finish React/Vite + Worker
assets, standalone Inbox/recovery and service-worker retirement. Delete Astro, old PWA controllers/styles and unused
`pwa-*` packages after cutover. Keep a rollback artifact, not two maintained UIs.
''',
    '''The React root now injects one `OwnerApiClient` into both the binary APIs and the legacy request-shape adapter;
the adapter owns no second transport, epoch or disposal lifecycle. Continue migrating legacy method modules onto the
same client, then finish React/Vite + Worker assets, standalone Inbox/recovery and service-worker retirement. Delete
Astro, old PWA controllers/styles and unused `pwa-*` packages after cutover. Keep a rollback artifact, not two UIs.
''',
)
