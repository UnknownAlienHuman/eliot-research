export async function reset() {}

// The prepared emitted Worker applies its exact pinned migrations before the
// fixture is loaded. The fixture then seeds through the supplied D1/R2 handles.
export async function applyD1Migrations() {}

export async function runInDurableObject() {
  throw new Error("runInDurableObject is unavailable in the emitted Worker qualification harness");
}
