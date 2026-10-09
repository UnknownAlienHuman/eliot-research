import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  readRequestBodyWithinBytes,
  readStreamWithinBytes,
} from "../packages/platform-cloudflare/src/runtime-limits.js";
import { readProviderConfigRestEnvelope } from "../packages/cloudflare-ai/src/provider-config-rest-response.js";
import { readCustomProviderRestEnvelope } from "../packages/cloudflare-ai/src/custom-provider-rest-response.js";
import { readDynamicRouteRestJson } from "../packages/cloudflare-ai/src/dynamic-route-rest-response-codec.js";
import { DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES } from "../packages/cloudflare-ai/src/dynamic-route-rest-contract.js";

type EffectField = "effect" | "ambiguous_effect";
type BoundedReaderConsumer = Readonly<{
  name: string;
  maxBytes: number;
  tooLargeCode: string;
  invalidCode: string;
  effectField: EffectField;
  effectValue: string;
  read(response: Response): Promise<unknown>;
}>;

const consumers: readonly BoundedReaderConsumer[] = [
  {
    name: "provider-config",
    maxBytes: 2 * 1024 * 1024,
    tooLargeCode: "PROVIDER_CONFIG_RESPONSE_TOO_LARGE",
    invalidCode: "PROVIDER_CONFIG_RESPONSE_INVALID",
    effectField: "effect",
    effectValue: "CREATE",
    read: (response) => readProviderConfigRestEnvelope(response, "CREATE"),
  },
  {
    name: "custom-provider",
    maxBytes: 2 * 1024 * 1024,
    tooLargeCode: "CUSTOM_PROVIDER_RESPONSE_TOO_LARGE",
    invalidCode: "CUSTOM_PROVIDER_RESPONSE_INVALID",
    effectField: "effect",
    effectValue: "CREATE",
    read: (response) => readCustomProviderRestEnvelope(response, "CREATE"),
  },
  {
    name: "dynamic-route",
    maxBytes: DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES,
    tooLargeCode: "DYNAMIC_ROUTE_REST_RESPONSE_TOO_LARGE",
    invalidCode: "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    effectField: "ambiguous_effect",
    effectValue: "ROUTE_CREATE",
    read: (response) => readDynamicRouteRestJson(response, "ROUTE_CREATE"),
  },
];

type Deferred<T> = Readonly<{ promise: Promise<T>; resolve(value: T): void }>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type ObservedBody = Readonly<{
  response: Response;
  stream: ReadableStream<Uint8Array>;
  state: { pulls: number; cancellations: number };
}>;

function observedBody(
  pull: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  headers: HeadersInit = {},
  cancel: () => void | Promise<void> = () => undefined,
): ObservedBody {
  const state = { pulls: 0, cancellations: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      pull(controller);
    },
    cancel() {
      state.cancellations += 1;
      return cancel();
    },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers }), stream, state };
}

type Settled = Readonly<
  | { state: "resolved"; value: unknown }
  | { state: "rejected"; error: unknown }
>;

function settle(operation: Promise<unknown>): Promise<Settled> {
  return operation.then(
    (value) => ({ state: "resolved", value }),
    (error: unknown) => ({ state: "rejected", error }),
  );
}

const TIMED_OUT = Symbol("reader waited for cancellation");

async function beforeNextTask<T>(
  operation: Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), 0);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function mappedError(consumer: BoundedReaderConsumer, code: string) {
  return { code, [consumer.effectField]: consumer.effectValue };
}

async function expectPromptFailure(
  operation: Promise<unknown>,
  expected: Readonly<Record<string, unknown>>,
  cleanup: Deferred<void>,
  verifyBeforeCleanup: () => void,
): Promise<void> {
  const settled = settle(operation);
  try {
    const first = await beforeNextTask(settled);
    if (first === TIMED_OUT) {
      throw new Error("bounded reader waited for source cancellation to settle");
    }
    expect(first).toMatchObject({ state: "rejected", error: expected });
    verifyBeforeCleanup();
  } finally {
    cleanup.resolve(undefined);
  }
  expect(await settled).toMatchObject({ state: "rejected", error: expected });
}

describe("Cloudflare bounded response reader integration", () => {
  it.each([
    {
      name: "byte overflow",
      maxBytes: 1,
      maxChunks: 8,
      code: "LIMIT_EXCEEDED",
      pull: (controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new Uint8Array(2)),
    },
    {
      name: "small-chunk flood",
      maxBytes: 10,
      maxChunks: 1,
      code: "STREAM_CHUNK_LIMIT_EXCEEDED",
      pull: (controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new Uint8Array(1)),
    },
    {
      name: "empty-chunk flood",
      maxBytes: 1,
      maxChunks: 2,
      code: "STREAM_CHUNK_LIMIT_EXCEEDED",
      pull: (controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new Uint8Array()),
    },
    {
      name: "non-byte input",
      maxBytes: 1,
      maxChunks: 8,
      code: "STREAM_CHUNK_INVALID",
      pull: (controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue("not bytes" as unknown as Uint8Array),
    },
  ])("the shared primitive rejects $name without awaiting hostile cancellation", async (scenario) => {
    const cleanup = deferred<void>();
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: scenario.pull,
      cancel() {
        cancellations += 1;
        return cleanup.promise;
      },
    }, { highWaterMark: 0 });

    await expectPromptFailure(
      readStreamWithinBytes(stream, {
        label: "integration.body",
        max_bytes: scenario.maxBytes,
        max_chunks: scenario.maxChunks,
      }),
      { code: scenario.code },
      cleanup,
      () => {
        expect(cancellations).toBe(1);
        expect(stream.locked).toBe(false);
      },
    );
  });

  it.each(consumers)("$name maps byte overflow to its domain error and effect", async (consumer) => {
    const cleanup = deferred<void>();
    const body = observedBody(
      (controller) => controller.enqueue(new Uint8Array(consumer.maxBytes + 1)),
      {},
      () => cleanup.promise,
    );

    await expectPromptFailure(
      consumer.read(body.response),
      mappedError(consumer, consumer.tooLargeCode),
      cleanup,
      () => {
        expect(body.state.cancellations).toBe(1);
        expect(body.stream.locked).toBe(false);
      },
    );
  });

  it.each(consumers)("$name maps a chunk flood to its domain error and effect", async (consumer) => {
    const cleanup = deferred<void>();
    const body = observedBody(
      (controller) => controller.enqueue(new Uint8Array()),
      {},
      () => cleanup.promise,
    );

    await expectPromptFailure(
      consumer.read(body.response),
      mappedError(consumer, consumer.tooLargeCode),
      cleanup,
      () => {
        expect(body.state.pulls).toBeGreaterThan(0);
        expect(body.state.cancellations).toBe(1);
        expect(body.stream.locked).toBe(false);
      },
    );
  });

  it.each(consumers)("$name maps non-byte chunks to its invalid-response error", async (consumer) => {
    const cleanup = deferred<void>();
    const body = observedBody(
      (controller) => controller.enqueue("not bytes" as unknown as Uint8Array),
      {},
      () => cleanup.promise,
    );

    await expectPromptFailure(
      consumer.read(body.response),
      mappedError(consumer, consumer.invalidCode),
      cleanup,
      () => {
        expect(body.state.cancellations).toBe(1);
        expect(body.stream.locked).toBe(false);
      },
    );
  });

  it.each(consumers)("$name rejects an oversized Content-Length before pulling the body", async (consumer) => {
    const cleanup = deferred<void>();
    const body = observedBody(() => undefined, {
      "content-length": String(consumer.maxBytes + 1),
    }, () => cleanup.promise);

    await expectPromptFailure(
      consumer.read(body.response),
      mappedError(consumer, consumer.tooLargeCode),
      cleanup,
      () => {
        expect(body.state.pulls).toBe(0);
        expect(body.state.cancellations).toBe(1);
        expect(body.stream.locked).toBe(false);
      },
    );
  });

  it.each(consumers)("$name maps malformed Content-Length before pulling the body", async (consumer) => {
    const cleanup = deferred<void>();
    const body = observedBody(() => undefined, { "content-length": "1e2" }, () => cleanup.promise);

    await expectPromptFailure(
      consumer.read(body.response),
      mappedError(consumer, consumer.invalidCode),
      cleanup,
      () => {
        expect(body.state.pulls).toBe(0);
        expect(body.state.cancellations).toBe(1);
        expect(body.stream.locked).toBe(false);
      },
    );
  });

  it.each(consumers)("$name rejects unsafe Content-Length before pulling the body", async (consumer) => {
    const cleanup = deferred<void>();
    const body = observedBody(() => undefined, {
      "content-length": "9007199254740992",
    }, () => cleanup.promise);

    await expectPromptFailure(
      consumer.read(body.response),
      mappedError(consumer, consumer.invalidCode),
      cleanup,
      () => {
        expect(body.state.pulls).toBe(0);
        expect(body.state.cancellations).toBe(1);
        expect(body.stream.locked).toBe(false);
      },
    );
  });

  it("cancels a request body rejected by its declared byte limit", async () => {
    const request = new Request("https://research.example/", {
      method: "POST",
      headers: { "content-length": "11" },
      body: "small",
    });

    await expect(readRequestBodyWithinBytes(request, {
      label: "integration.request",
      max_bytes: 10,
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(request.bodyUsed).toBe(true);
    expect(request.body?.locked).toBe(false);
  });

  it.each(["throws", "rejects"] as const)(
    "keeps the original byte-limit error when source cancellation %s",
    async (mode) => {
      const original = new Error("synthetic cancellation failure");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(2)); },
        cancel() {
          if (mode === "throws") throw original;
          return Promise.reject(original);
        },
      }, { highWaterMark: 0 });

      await expect(readStreamWithinBytes(stream, { label: "integration.body", max_bytes: 1 }))
        .rejects.toMatchObject({ code: "LIMIT_EXCEEDED", actual: 2, limit: 1 });
      expect(stream.locked).toBe(false);
    },
  );

  it("preserves upstream read errors and releases the reader lock", async () => {
    const original = new Error("synthetic read failure");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(original); },
    });

    await expect(readStreamWithinBytes(stream, { label: "integration.body", max_bytes: 1 }))
      .rejects.toBe(original);
    expect(stream.locked).toBe(false);
  });

  it.each([false, true])(
    "copies bytes from a reused mutable chunk even when slice aliases: %s",
    async (sliceAliases) => {
      const reused = new Uint8Array(2);
      if (sliceAliases) Object.defineProperty(reused, "slice", { value: () => reused });
      let pull = 0;
      let cancellations = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          reused.set(pull === 0 ? [1, 2] : [3, 4]);
          controller.enqueue(reused);
          pull += 1;
          if (pull === 2) controller.close();
        },
        cancel() { cancellations += 1; },
      }, { highWaterMark: 0 });

      const bytes = await readStreamWithinBytes(stream, {
        label: "integration.body",
        max_bytes: 4,
        max_chunks: 2,
      });

      expect([...bytes]).toEqual([1, 2, 3, 4]);
      expect(cancellations).toBe(0);
      expect(stream.locked).toBe(false);
    },
  );

  it("keeps migrated consumers on the shared response reader", async () => {
    const paths = [
      "../packages/cloudflare-ai/src/provider-config-rest-response.ts",
      "../packages/cloudflare-ai/src/custom-provider-rest-response.ts",
      "../packages/cloudflare-ai/src/dynamic-route-rest-response-codec.ts",
    ];
    const sources = await Promise.all(
      paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );

    for (const source of sources) {
      expect(source).toContain("readResponseBodyWithinBytes");
      expect(source).not.toMatch(/\.getReader\s*\(/);
      expect(source).not.toMatch(/\breader\.read\s*\(/);
      expect(source).not.toMatch(/\bresponse\.(?:text|arrayBuffer)\s*\(/);
    }
  });
});
