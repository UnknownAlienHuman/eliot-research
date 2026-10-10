import { z } from "zod";

/** Call before importing contract schemas in a runtime that forbids dynamic code. */
export function configureContractsForStrictCsp(): void {
  z.config({ jitless: true });
}
