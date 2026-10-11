import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_SCHEMA_REPRESENTATION as representation, deploymentPlatformSchemaObject,
  projectSupportedDeploymentSchema, matchSupportedDeploymentSchema, validateSupportedSchemaRepresentation } from "./lib/deployment-native-platform-schema.mjs";
import { deploymentSchemaCatalogueSha256 } from "./lib/deployment-schema-attestation.mjs";

const source = () => deploymentPlatformSchemaObject(representation.source_platform_profile);
const target = () => deploymentPlatformSchemaObject(representation.target_platform_profile);
const app = () => ({ type: "table", name: "app", tbl_name: "app",
  sql: "CREATE TABLE app (x TEXT /* commentary */ CHECK(x <> '/* literal */'))" });
test("source-defined platform shapes remain distinct and preserve raw source catalogue", () => {
  const objects = [source(), app()], before = structuredClone(objects);
  const result = projectSupportedDeploymentSchema(objects, representation);
  assert.deepEqual(objects, before);
  assert.deepEqual(result[0], target());
  assert.equal(result[1].sql, "CREATE TABLE app (x TEXT  CHECK(x <> '/* literal */'))");
  assert.deepEqual(projectSupportedDeploymentSchema(result, representation, { observed: true }), result);
  assert.notEqual(deploymentSchemaCatalogueSha256(objects), deploymentSchemaCatalogueSha256(result));
  assert.equal(validateSupportedSchemaRepresentation(structuredClone(representation)), true);
  assert.deepEqual(matchSupportedDeploymentSchema(objects, result, representation), result);
  assert.deepEqual(matchSupportedDeploymentSchema(objects, [target(), app()], representation), result);
  assert.throws(() => matchSupportedDeploymentSchema(objects,
    [target(), { ...app(), sql: app().sql.replace("commentary", "different") }], representation));
  assert.throws(() => matchSupportedDeploymentSchema(objects,
    [target(), { ...app(), sql: app().sql.replace("CREATE TABLE", "CREATE /* added */ TABLE") }], representation));
});
test("unknown changed missing duplicate and cross-type platform objects fail closed", () => {
  for (const object of [
    { ...source(), name: "_cf_EXTRA" }, { ...source(), name: "_CF_METADATA" },
    { ...source(), type: "view" }, { ...source(), tbl_name: "other" },
    { ...source(), sql: source().sql + " " }, target(),
  ]) assert.throws(() => projectSupportedDeploymentSchema([object, app()], representation));
  assert.throws(() => projectSupportedDeploymentSchema([app()], representation));
  assert.throws(() => projectSupportedDeploymentSchema([source(), source(), app()], representation));
  assert.throws(() => projectSupportedDeploymentSchema([source(), target(), app()], representation));
  assert.throws(() => projectSupportedDeploymentSchema([source(), app()], representation, { observed: true }));
  assert.throws(() => projectSupportedDeploymentSchema([source(), app(), { ...app(), name: "APP" }], representation));
});
test("source authority pins and exact descriptor fields cannot be substituted", () => {
  for (const field of ["protocol", "sql_protocol", "source_platform_profile", "target_platform_profile", "vendor_sources"]) {
    const changed = structuredClone(representation);
    changed[field] = field === "vendor_sources" ? [] : "unknown";
    assert.throws(() => validateSupportedSchemaRepresentation(changed));
  }
  assert.throws(() => validateSupportedSchemaRepresentation({ ...representation, extra: true }));
  const changed = structuredClone(representation); changed.vendor_sources[0].source_sha256 = "0".repeat(64);
  assert.throws(() => validateSupportedSchemaRepresentation(changed));
  assert.throws(() => deploymentPlatformSchemaObject("unknown"));
});
