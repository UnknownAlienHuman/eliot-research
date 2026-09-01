import type { PurgeLocation } from "@eliotr/contracts";
import type { ErasureLocationPort, ErasureLocationRegistry } from "./types.js";

export function createErasureLocationRegistry(
  entries: Readonly<Partial<Record<PurgeLocation, ErasureLocationPort>>>,
): ErasureLocationRegistry {
  return {
    forLocation(location) {
      return entries[location] ?? null;
    },
  };
}
