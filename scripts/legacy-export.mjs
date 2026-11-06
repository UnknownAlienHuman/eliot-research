import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { legacyManifestSchema } from './lib/legacy-manifest.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const DOMAIN_FIELDS = ['scope_domain_id', 'access_domain_id', 'confidentiality_domain_id',
  'encryption_key_domain_id', 'retention_domain_id', 'erasure_domain_id'];
const MAX_MANIFEST = 512 * 1024;
const MAX_CONTENT = 25 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const keyIdentifier = (value) => typeof value === 'string' && value.length > 0 && value === value.trim()
  && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const within = (root, path) => {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
};

// The legacy wire format, not its storage/runtime packages. See DONORS, K10 preparation.
function residency(domains, digest) {
  requireValue(SHA256.test(digest), 'Invalid content checksum');
  // Domains already passed IdentifierSchema (1–256 JS code units) in legacyManifestSchema.
  // Unlike key identity fields, they have no UTF-8 byte, trim or control-character restriction.
  return hash(['object-residency-key.v1', ...DOMAIN_FIELDS.map((field) => domains[field]), 'sha256', digest]
    .map(encodeURIComponent).join('/'));
}

function bundleKey(row, digest, name) {
  const source = hash(JSON.stringify(['eliotr.normalized-source.v1', row.source_owner_system_id,
    row.source_namespace_id, row.source_owner_generation, row.source_id]));
  const revision = hash(JSON.stringify(['eliotr.normalized-revision.v1', row.source_owner_system_id,
    row.source_namespace_id, row.source_owner_generation, row.source_revision_ref]));
  return `normalized/${digest}/${source}/${revision}/${name}`;
}

function readObject(root, key, maxBytes) {
  requireValue(typeof key === 'string' && Buffer.byteLength(key) <= 1024 &&
    key.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part) && part !== '.' && part !== '..'),
  'Object key is not a safe relative path');
  const path = join(root, key);
  // Reject links in any component, including links to another file inside the snapshot.
  let current = root;
  for (const part of key.split('/')) {
    current = join(current, part);
    requireValue(!lstatSync(current).isSymbolicLink(), `Object path contains a symlink: ${key}`);
  }
  requireValue(lstatSync(path).isFile(), `Invalid object size/type: ${key}`);
  // Nonblocking open also prevents a FIFO replacement between lstat and open from hanging.
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(file);
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, `Invalid object size/type: ${key}`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const size = readSync(file, bytes, offset, bytes.length - offset, null);
      requireValue(size > 0, `Object changed during read: ${key}`);
      offset += size;
    }
    requireValue(readSync(file, Buffer.alloc(1), 0, 1, null) === 0, `Object grew during read: ${key}`);
    return bytes;
  } finally { closeSync(file); }
}

function inventory(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('BEGIN');
    const projects = db.prepare('SELECT project_id, title, created_at FROM project ORDER BY project_id').all();
    const sources = db.prepare('SELECT source_id, source_namespace_id, source_owner_system_id, source_owner_generation, '
      + 'kind, origin_uri, title, head_rev, created_at FROM source ORDER BY source_id').all();
    const memberships = db.prepare('SELECT project_id, source_id, role, valid_from, valid_to, membership_generation '
      + 'FROM project_source_membership ORDER BY project_id, source_id, valid_from').all();
    const revisions = db.prepare('SELECT source_revision_ref, source_id, source_owner_generation, content_sha256, '
      + 'object_residency_key_digest, original_r2_key, normalized_artifact_ref, captured_at, source_view_ref, '
      + 'workspace_view_revision_ref, quality_state, purge_state FROM source_revision ORDER BY source_revision_ref').all();
    db.exec('COMMIT');
    const projectIds = new Set(projects.map((row) => row.project_id));
    const sourceIds = new Set(sources.map((row) => row.source_id));
    requireValue(memberships.every((row) => projectIds.has(row.project_id) && sourceIds.has(row.source_id)),
      'Membership refers to an absent project/source');
    requireValue(revisions.every((row) => sourceIds.has(row.source_id)), 'Revision refers to an absent source');
    requireValue(sources.every((source) => source.head_rev === null || revisions.some((revision) =>
      revision.source_revision_ref === source.head_rev && revision.source_id === source.source_id)),
    'Source head refers to an absent or different source revision');
    return { projects, sources, memberships, revisions };
  } finally {
    db.close();
  }
}

function verifyRevision(objects, source, revision) {
  const row = { ...source, ...revision };
  requireValue(['source_owner_system_id', 'source_namespace_id', 'source_owner_generation', 'source_id',
    'source_revision_ref'].every((field) => keyIdentifier(row[field])), 'Invalid source/revision identity');
  requireValue(SHA256.test(row.content_sha256) && SHA256.test(row.object_residency_key_digest), 'Invalid revision checksum');
  const manifestBytes = readObject(objects, row.normalized_artifact_ref, MAX_MANIFEST);
  const parsed = legacyManifestSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
  requireValue(parsed.success, 'Manifest does not match the complete legacy normalized-bundle schema');
  const manifest = parsed.data;
  const origin = manifest?.origin;
  requireValue(manifest?.protocol === 'eliotr.normalized.v1' &&
    origin?.owner_system_id === row.source_owner_system_id && origin.source_namespace_id === row.source_namespace_id &&
    origin.source_owner_generation === row.source_owner_generation && origin.source_revision_ref === row.source_revision_ref &&
    origin.source_view_ref === row.source_view_ref &&
    (origin.workspace_view_revision_ref ?? null) === row.workspace_view_revision_ref &&
    manifest.source?.logical_id === row.source_id && manifest.content?.markdown === 'content.md' &&
    manifest.content.markdown_sha256 === row.content_sha256 && manifest.capabilities?.text_ranges === true,
  'Manifest does not match the recorded source/revision identity or readable content');
  const manifestSha = hash(manifestBytes);
  requireValue(bundleKey(row, residency(manifest.residency_and_disclosure, manifestSha), 'manifest.json') ===
    row.normalized_artifact_ref, 'Manifest key does not match its exact bytes and identity');
  requireValue(residency(manifest.residency_and_disclosure, row.content_sha256) === row.object_residency_key_digest,
    'Content residency digest does not match the revision');
  const contentKey = bundleKey(row, row.object_residency_key_digest, 'content.md');
  const content = readObject(objects, contentKey, MAX_CONTENT);
  requireValue(hash(content) === row.content_sha256, 'Normalized content checksum mismatch');
  new TextDecoder('utf-8', { fatal: true }).decode(content);
  const originalKey = row.original_r2_key;
  requireValue(originalKey === null || typeof originalKey === 'string', 'Invalid original object reference');
  const original = originalKey === null || originalKey === '' ? null : readObject(objects, originalKey, MAX_CONTENT);
  if (original !== null) {
    requireValue(SHA256.test(manifest.source.original_sha256) && hash(original) === manifest.source.original_sha256,
      'Original checksum mismatch');
  }
  return { manifestBytes, content, original, manifestSha, contentKey };
}

/** Prepare private local migration material; never contacts an API or opens the DB writable. */
export function exportLegacy({ database, objects, output }) {
  const databasePath = realpathSync(database);
  const objectsPath = realpathSync(objects);
  const outputPath = join(realpathSync(dirname(resolve(output))), resolve(output).split(sep).at(-1));
  requireValue(!within(objectsPath, outputPath) && !within(outputPath, objectsPath) && !within(outputPath, databasePath),
    'Output must be separate from the input database and object snapshot');
  const snapshot = inventory(databasePath);
  const sourceById = new Map(snapshot.sources.map((row) => [row.source_id, row]));
  // A fresh directory is required. A failed export has no export.json completion marker.
  mkdirSync(outputPath, { mode: 0o700 });
  const exported = [];
  for (const revision of snapshot.revisions) {
    if (revision.purge_state !== 'LIVE') continue;
    let verified;
    try {
      verified = verifyRevision(objectsPath, sourceById.get(revision.source_id), revision);
    } catch (error) {
      throw new Error(`Revision ${revision.source_revision_ref}: ${error.message}`, { cause: error });
    }
    const directory = `revisions/${hash(revision.source_revision_ref)}`;
    mkdirSync(join(outputPath, directory), { recursive: true, mode: 0o700 });
    const files = [
      ['manifest.json', verified.manifestBytes, revision.normalized_artifact_ref],
      ['text.md', verified.content, verified.contentKey],
      ...(verified.original === null ? [] : [['original', verified.original, revision.original_r2_key]]),
    ].map(([name, bytes, key]) => {
      const path = `${directory}/${name}`;
      writeFileSync(join(outputPath, path), bytes, { flag: 'wx', mode: 0o600 });
      return { path, legacy_key: key, sha256: hash(bytes), bytes: bytes.length };
    });
    exported.push({ source_revision_ref: revision.source_revision_ref, source_id: revision.source_id,
      original_status: verified.original === null ? 'not_recorded' : 'verified', files });
  }
  const counts = { projects: snapshot.projects.length, sources: snapshot.sources.length,
    memberships: snapshot.memberships.length, active_memberships: snapshot.memberships.filter((row) => row.valid_to === null).length,
    revisions: snapshot.revisions.length, live_revisions: exported.length,
    originals_verified: exported.filter((row) => row.original_status === 'verified').length,
    originals_not_recorded: exported.filter((row) => row.original_status === 'not_recorded').length };
  const report = { format: 'eliot.legacy-local-export.v1', verification: 'local_snapshot_only', counts,
    ...snapshot, exported };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  const reportTemp = join(outputPath, '.export.json.tmp');
  writeFileSync(reportTemp, reportBytes, { flag: 'wx', mode: 0o600 });
  renameSync(reportTemp, join(outputPath, 'export.json'));
  return { ...counts, export_sha256: hash(reportBytes) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 6 && args[0] === '--database' && args[2] === '--objects' && args[4] === '--output',
      'Usage: node scripts/legacy-export.mjs --database /private/core.sqlite --objects /private/r2 --output /private/export');
    console.log(JSON.stringify(exportLegacy({ database: args[1], objects: args[3], output: args[5] }), null, 2));
  } catch (error) {
    console.error(`Legacy export failed: ${error.message}`);
    process.exitCode = 1;
  }
}
