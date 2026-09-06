import { createGoogleOAuthAdmission, type GoogleOAuthAdmissionOptions } from "@eliotr/google-drive-exchange";
import { createD1GoogleOAuthIntentStore } from "./google-oauth-store.js";

/** Initial credential admission only. Caller supplies current authenticated owner and trusted operator configuration. */
export function createD1GoogleOAuthAdmission(options: Omit<GoogleOAuthAdmissionOptions, "store"> & { readonly database: D1Database }) {
  return createGoogleOAuthAdmission({ ...options,
    store: createD1GoogleOAuthIntentStore(options.database, options.configuration, options.owner, options.now) });
}
