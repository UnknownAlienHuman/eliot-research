// Single public entry for the `scope-snapshot-identity.v1` independent reference.
// The family implementation lives in `./scope-snapshot-identity/` (constants,
// canonical bytes, frame parser, validation, fixture transport). No second family
// is introduced; this file only re-exports the stable entry points.
export { deriveSnapshotIdentity, verifySnapshotIdentity } from "./scope-snapshot-identity/validate.mjs";
export {
  parseScopeSnapshotIdentityCases,
  verifyScopeSnapshotIdentityReference,
} from "./scope-snapshot-identity/vectors.mjs";
