import { ModelAttemptError } from "./model-attempt-types.js";

/** Called only after admission readback found no row, before any W3 reservation or model dispatch. */
export function researchSpendWriteDenial(cause: unknown): ModelAttemptError | undefined {
  let current = cause;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    const message = Object.getOwnPropertyDescriptor(current, "message")?.value;
    if (typeof message === "string" &&
        /(?:^|[\s:])MODEL_SPEND_ADMISSION_AUTHORITY_STALE(?:$|[\s:])/u.test(message)) {
      const denied = new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE",
        "spend admission was rejected before model dispatch", false, cause);
      Object.defineProperties(denied, {
        dispatch_state: { value: "NOT_STARTED", enumerable: true },
        recovery_action: { value: "NONE", enumerable: true },
      });
      return denied;
    }
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return undefined;
}
