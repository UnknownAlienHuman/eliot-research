import type { readAiUsageObservation } from "@eliotr/owner-api-client";

export type AiUsageObservation = Awaited<ReturnType<typeof readAiUsageObservation>>;

/** Keep server policy separate from measured usage; a failed or unavailable read never becomes zero. */
export function aiUsagePresentation(value: AiUsageObservation | undefined, requestFailed: boolean) {
  const measured = !requestFailed && value?.status === "available" ? value : undefined;
  return {
    freeAllocation: value?.free_allocation_neurons,
    used: measured?.usage_neurons ?? null,
    remaining: measured?.remaining_neurons ?? null,
    observedAt: value?.observed_at,
  } as const;
}
