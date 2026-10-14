import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import { canonicalProjectionJson, projectionSha256Utf8 } from "./canonical.js";

const MAX_TREE_FANOUT = 256;

export interface ManifestTreeObjectRef {
  readonly kind: "COPY" | "INDEX";
  readonly key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly first_copy_ordinal: number;
  readonly last_copy_ordinal: number;
  readonly copy_count: number;
  readonly item_count: number;
}

export type ManifestTreeFrontier = readonly (readonly ManifestTreeObjectRef[])[];

export type ManifestTreePut = (
  store: EvidenceObjectStore,
  key: string,
  value: unknown,
  metadata: Readonly<Record<string, string>>,
) => Promise<{ readonly key: string; readonly sha256: string; readonly size_bytes: number }>;

export class ManagedTargetManifestTreeWriter {
  private readonly levels: ManifestTreeObjectRef[][];
  private readonly writtenKeys: string[] = [];

  public constructor(
    private readonly store: EvidenceObjectStore,
    private readonly prefix: string,
    private readonly put: ManifestTreePut,
    frontier: ManifestTreeFrontier = [],
  ) {
    this.levels = frontier.map((items) => [...items]);
  }

  public snapshot(): ManifestTreeFrontier {
    return Object.freeze(this.levels.map((items) => Object.freeze([...items])));
  }

  public takeWrittenKeys(): readonly string[] {
    const keys = Object.freeze([...this.writtenKeys]);
    this.writtenKeys.length = 0;
    return keys;
  }

  public async add(copy: ManifestTreeObjectRef): Promise<void> {
    if (copy.kind !== "COPY") throw new Error("manifest tree accepts only copy leaves");
    await this.push(0, copy);
  }

  public async finish(): Promise<ManifestTreeObjectRef | null> {
    while (true) {
      const occupied = this.levels.flatMap((items, level) => items.length === 0 ? [] : [level]);
      if (occupied.length === 0) return null;
      const lowest = occupied[0];
      const highest = occupied.at(-1);
      if (lowest === undefined || highest === undefined) return null;
      const current = this.levels[lowest];
      if (current === undefined) return null;
      if (lowest === highest && current.length === 1) return current[0] ?? null;
      this.levels[lowest] = [];
      const node = await this.writeNode(lowest, current);
      await this.push(lowest + 1, node);
    }
  }

  private async push(level: number, child: ManifestTreeObjectRef): Promise<void> {
    const current = this.levels[level] ?? [];
    current.push(child);
    this.levels[level] = current;
    if (current.length === MAX_TREE_FANOUT) {
      this.levels[level] = [];
      await this.push(level + 1, await this.writeNode(level, current));
    }
  }

  private async writeNode(
    level: number,
    children: readonly ManifestTreeObjectRef[],
  ): Promise<ManifestTreeObjectRef> {
    if (children.length === 0 || children.length > MAX_TREE_FANOUT) {
      throw new Error("managed target manifest tree node has an invalid fanout");
    }
    for (let index = 1; index < children.length; index += 1) {
      const previous = children[index - 1];
      const current = children[index];
      if (previous === undefined || current === undefined || previous.last_copy_ordinal + 1 !== current.first_copy_ordinal) {
        throw new Error("managed target manifest tree children are not contiguous");
      }
    }
    const first = children[0];
    const last = children.at(-1);
    if (first === undefined || last === undefined) throw new Error("managed target manifest tree node has no range");
    const copyCount = children.reduce((sum, child) => sum + child.copy_count, 0);
    const itemCount = children.reduce((sum, child) => sum + child.item_count, 0);
    const payload = {
      protocol: "eliotr.managed-target-manifest-index.v1",
      level,
      first_copy_ordinal: first.first_copy_ordinal,
      last_copy_ordinal: last.last_copy_ordinal,
      copy_count: copyCount,
      item_count: itemCount,
      children,
    } as const;
    const digest = await projectionSha256Utf8(canonicalProjectionJson(payload));
    const stored = await this.put(
      this.store,
      `${this.prefix}/tree/${level}/${digest}.json`,
      payload,
      { manifest_kind: "managed-target-manifest-index", tree_level: String(level) },
    );
    this.writtenKeys.push(stored.key);
    return Object.freeze({
      kind: "INDEX",
      ...stored,
      first_copy_ordinal: first.first_copy_ordinal,
      last_copy_ordinal: last.last_copy_ordinal,
      copy_count: copyCount,
      item_count: itemCount,
    });
  }
}
