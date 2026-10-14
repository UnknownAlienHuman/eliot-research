import type { readObject } from "@eliotr/cloudflare-wiki/wiki-publication-store-support";

/**
 * R2 object doubles for the Wiki bounded reader. Each double declares one size
 * and each spec separately decides what that object actually delivers, so the
 * reader must prove currentness instead of trusting the declaration.
 */
export interface WikiReaderObjectSpec {
  readonly key: string;
  /** The size R2 declares for this object. */
  readonly size: number;
  /** What the body actually delivers, as byte-array chunks. */
  readonly chunks: readonly Uint8Array[];
  /** Chunks are delivered by pull-driven backpressure instead of all at once. */
  readonly pullDriven?: boolean;
}

export type WikiReaderBucket = Parameters<typeof readObject>[0] & {
  /** How many times a body stream was handed to the reader. */
  bodyOpens(): number;
  /** How many of those bodies the reader cancelled. */
  cancels(): number;
};

function cancelableStream(
  chunks: readonly Uint8Array[],
  pullDriven: boolean,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (pullDriven || chunks.length === 0) return;
      // One chunk is already queued before the reader asks for another, which is
      // enough to overrun the byte envelope on the reader's first read.
      const first = chunks[index];
      if (first === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(first);
      index += 1;
    },
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() { onCancel(); },
  });
}

export function createWikiReaderBucket(specs: readonly WikiReaderObjectSpec[]): WikiReaderBucket {
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  let bodyOpens = 0;
  let cancels = 0;
  const bucket = {
    bodyOpens: () => bodyOpens,
    cancels: () => cancels,
    async get(key: string) {
      const spec = byKey.get(key);
      if (spec === undefined) return null;
      const stream = cancelableStream(
        spec.chunks,
        spec.pullDriven === true,
        () => { cancels += 1; },
      );
      return {
        key: spec.key,
        size: spec.size,
        get body(): ReadableStream<Uint8Array> {
          bodyOpens += 1;
          return stream;
        },
      };
    },
  };
  return bucket as unknown as WikiReaderBucket;
}
