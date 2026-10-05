import { createHash } from "node:crypto";

const HASH = /^[0-9a-f]{64}$/u;
const MIGRATION = /^\d{4}_[A-Za-z0-9_-]+\.sql$/u;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const PROBE_KEYS = ["object_type", "name", "before_sql_sha256", "create_sql_sha256", "migration_names"];
const MAX_GROUPS = 4;
const MAX_GROUP_SIZE = 64;
const MAX_PROBES = MAX_GROUPS * MAX_GROUP_SIZE;

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function validMigrationNames(names) {
  return Array.isArray(names) && names.length > 0 && names.length <= 2048 &&
    names.every((name, index) => typeof name === "string" && MIGRATION.test(name) &&
      (index === 0 || names[index - 1] < name));
}

function validProbe(probe, migrationNames) {
  return exactKeys(probe, PROBE_KEYS) && ["table", "index", "trigger", "view"].includes(probe.object_type) &&
    typeof probe.name === "string" && SCHEMA_NAME.test(probe.name) && !probe.name.toLowerCase().startsWith("sqlite_") &&
    (probe.before_sql_sha256 === null || HASH.test(probe.before_sql_sha256)) && HASH.test(probe.create_sql_sha256) &&
    validMigrationNames(probe.migration_names) && probe.migration_names.every((name) => migrationNames.includes(name));
}

function compareProbe(left, right) {
  const leftType = left.object_type;
  const rightType = right.object_type;
  if (leftType !== rightType) return leftType < rightType ? -1 : 1;
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return 0;
}

export function deploymentMigrationSchemaProbeGroupSha256(probes) {
  return createHash("sha256").update(canonicalJson(probes), "utf8").digest("hex");
}

export function createDeploymentMigrationSchemaProbeGroups(probes) {
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > MAX_PROBES) {
    throw new Error(`Version 2 D1 schema probes must contain between 1 and ${MAX_PROBES} objects`);
  }
  const ordered = [...probes].sort(compareProbe);
  const groups = [];
  for (let offset = 0; offset < ordered.length; offset += MAX_GROUP_SIZE) {
    const groupProbes = ordered.slice(offset, offset + MAX_GROUP_SIZE);
    groups.push({ group_index: groups.length + 1, group_sha256: deploymentMigrationSchemaProbeGroupSha256(groupProbes),
      probes: groupProbes });
  }
  return groups;
}

export function flattenDeploymentMigrationSchemaProbes(intent) {
  if (intent?.protocol === "eliotr.cloudflare-d1-migration-intent.v1") return intent.schema_probes;
  if (intent?.protocol === "eliotr.cloudflare-d1-migration-intent.v2" && Array.isArray(intent.schema_probe_groups)) {
    return intent.schema_probe_groups.flatMap((group) => Array.isArray(group?.probes) ? group.probes : []);
  }
  return [];
}

export function validateDeploymentMigrationSchemaProbeGroups(groups, migrationNames) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_GROUPS) return false;
  let total = 0;
  const covered = new Set();
  const unique = new Set();
  let previous = null;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!exactKeys(group, ["group_index", "group_sha256", "probes"]) || group.group_index !== index + 1 ||
        !Array.isArray(group.probes) || group.probes.length < 1 || group.probes.length > MAX_GROUP_SIZE ||
        (index < groups.length - 1 && group.probes.length !== MAX_GROUP_SIZE) ||
        !HASH.test(group.group_sha256 ?? "") || deploymentMigrationSchemaProbeGroupSha256(group.probes) !== group.group_sha256) return false;
    total += group.probes.length;
    if (total > MAX_PROBES) return false;
    for (const probe of group.probes) {
      if (!validProbe(probe, migrationNames) || (previous !== null && compareProbe(previous, probe) >= 0)) return false;
      const identity = `${probe.object_type}\u0000${probe.name.toLowerCase()}`;
      if (unique.has(identity)) return false;
      unique.add(identity);
      previous = probe;
      for (const name of probe.migration_names) covered.add(name);
    }
  }
  return groups.length === Math.ceil(total / MAX_GROUP_SIZE) &&
    migrationNames.every((name) => covered.has(name));
}

export function groupDeploymentMigrationSchemaProbeObservations(groups, observations) {
  let offset = 0;
  return groups.map((group) => {
    const selected = observations.slice(offset, offset + group.probes.length);
    offset += selected.length;
    return { group_index: group.group_index, group_sha256: group.group_sha256, observations: selected };
  });
}

export function validateGroupedSchemaProbeObservations({ groups, observedGroups, kind, schemaState,
  metadataMarkers, expectedMetadataMarkers }) {
  if (!Array.isArray(groups) || !Array.isArray(observedGroups) || observedGroups.length !== groups.length ||
      !["BEFORE_APPLY", "AFTER_APPLY", "RETRY_RECONCILIATION"].includes(kind) ||
      !["NOT_RUN", "PASS", "MISMATCH", "UNAVAILABLE"].includes(schemaState) ||
      !Array.isArray(metadataMarkers) || !Array.isArray(expectedMetadataMarkers)) return false;
  const before = kind === "BEFORE_APPLY";
  let seenProbeCount = 0;
  let terminalProbeState = null;
  let prefixClosed = false;
  for (let index = 0; index < groups.length; index += 1) {
    const expectedGroup = groups[index];
    const observedGroup = observedGroups[index];
    if (!exactKeys(observedGroup, ["group_index", "group_sha256", "observations"]) ||
        observedGroup.group_index !== expectedGroup.group_index || observedGroup.group_sha256 !== expectedGroup.group_sha256 ||
        !Array.isArray(observedGroup.observations) || observedGroup.observations.length > expectedGroup.probes.length ||
        (prefixClosed && observedGroup.observations.length !== 0)) return false;
    for (let probeIndex = 0; probeIndex < observedGroup.observations.length; probeIndex += 1) {
      const observation = observedGroup.observations[probeIndex];
      const probe = expectedGroup.probes[probeIndex];
      const expectedSql = before ? probe.before_sql_sha256 : probe.create_sql_sha256;
      if (!exactKeys(observation, ["object_type", "name", "expected_sql_sha256", "observed_sql_sha256", "migration_names", "state"]) ||
          observation.object_type !== probe.object_type || observation.name !== probe.name ||
          observation.expected_sql_sha256 !== expectedSql ||
          JSON.stringify(observation.migration_names) !== JSON.stringify(probe.migration_names) ||
          !(observation.observed_sql_sha256 === null || HASH.test(observation.observed_sql_sha256)) ||
          (observation.state === "PASS" && observation.observed_sql_sha256 !== expectedSql) ||
          !["PASS", "MISMATCH", "UNAVAILABLE"].includes(observation.state) ||
          (observation.state === "UNAVAILABLE" && observation.observed_sql_sha256 !== null)) return false;
      seenProbeCount += 1;
      if (observation.state !== "PASS") {
        terminalProbeState = observation.state;
        prefixClosed = true;
        if (probeIndex !== observedGroup.observations.length - 1) return false;
      }
    }
    if (observedGroup.observations.length < expectedGroup.probes.length) prefixClosed = true;
  }
  if (!Array.isArray(expectedMetadataMarkers) || expectedMetadataMarkers.length > 64 || metadataMarkers.length > expectedMetadataMarkers.length) return false;
  const expectedProbeCount = groups.reduce((sum, group) => sum + group.probes.length, 0);
  if ((before || seenProbeCount !== expectedProbeCount) && metadataMarkers.length !== 0) return false;
  let terminalMarkerState = null;
  for (let index = 0; index < metadataMarkers.length; index += 1) {
    const marker = metadataMarkers[index];
    const expected = expectedMetadataMarkers[index];
    if (!exactKeys(marker, ["key", "expected_value", "observed_value", "state"]) ||
        marker.key !== expected.key || marker.expected_value !== expected.value ||
        !(marker.observed_value === null || (typeof marker.observed_value === "string" && marker.observed_value.length <= 512)) ||
        !["PASS", "MISMATCH", "UNAVAILABLE"].includes(marker.state) ||
        (marker.state === "PASS" && marker.observed_value !== expected.value) ||
        (marker.state === "UNAVAILABLE" && marker.observed_value !== null)) return false;
    if (marker.state !== "PASS") {
      terminalMarkerState = marker.state;
      if (index !== metadataMarkers.length - 1) return false;
    }
  }
  if (terminalProbeState !== null && metadataMarkers.length !== 0) return false;
  const expectedMarkerCount = before ? 0 : expectedMetadataMarkers.length;
  if (schemaState === "NOT_RUN") return seenProbeCount === 0 && metadataMarkers.length === 0;
  if (schemaState === "PASS") {
    return seenProbeCount === expectedProbeCount && terminalProbeState === null &&
      metadataMarkers.length === expectedMarkerCount && terminalMarkerState === null;
  }
  if (schemaState === "MISMATCH") return terminalProbeState === "MISMATCH" || terminalMarkerState === "MISMATCH";
  if (terminalProbeState === "MISMATCH" || terminalMarkerState === "MISMATCH") return false;
  return terminalProbeState === "UNAVAILABLE" || terminalMarkerState === "UNAVAILABLE" ||
    seenProbeCount < expectedProbeCount || metadataMarkers.length < expectedMarkerCount;
}
