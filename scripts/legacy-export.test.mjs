import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { exportLegacy } from './legacy-export.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const domains = { scope_domain_id: 'scope-a', access_domain_id: 'access-a', confidentiality_domain_id: 'private',
  encryption_key_domain_id: 'key-a', retention_domain_id: 'retention-a', erasure_domain_id: 'erasure-a',
  disclosure_ceiling: 'owner-only', allowed_use: ['research'] };
// Independently construct the legacy fixture's keys, using the pinned wire format.
const residency = (sha, scope = 'scope-a') => hash(['object-residency-key.v1', scope, 'access-a', 'private', 'key-a',
  'retention-a', 'erasure-a', 'sha256', sha].map(encodeURIComponent).join('/'));
const key = (source, revision, sha, name, scope = 'scope-a') => `normalized/${residency(sha, scope)}/` +
  `${hash(JSON.stringify(['eliotr.normalized-source.v1', 'owner', 'namespace', 'generation', source]))}/` +
  `${hash(JSON.stringify(['eliotr.normalized-revision.v1', 'owner', 'namespace', 'generation', revision]))}/${name}`;
const insert = (db, table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) `
  + `VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));

function fixture(t, { content = Buffer.from('# Источник\r\n\nExact canonical 🐈 bytes.\n'), original = null, scopeDomain = 'scope-a', sourceViewRef = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'eliot-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'core.sqlite');
  const objects = join(root, 'r2');
  const output = join(root, 'export');
  mkdirSync(objects);
  const db = new DatabaseSync(database);
  db.exec(readFileSync(new URL('../infra/d1/core/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const now = '2026-11-05T00:00:00Z';
  for (let i = 0; i < 8; i++) insert(db, 'project', { project_id: `p${i}`, title: `Project ${i}`,
    default_disclosure: 'owner', retention_policy_ref: 'retention', default_source_policy_ref: 'source-policy',
    default_model_profile_ref: 'model', default_depth_profile_ref: 'depth', created_at: now });
  for (let i = 0; i < 15; i++) {
    insert(db, 'source', { source_id: `s${i}`, source_namespace_id: 'namespace', source_owner_system_id: 'owner',
      source_owner_generation: 'generation', ownership_mode: 'immutable_import', kind: 'document', origin_uri: null,
      title: `Source ${i}`, default_storage_policy: 'policy', default_residency_profile_id: 'profile',
      source_class: 'paper', license_policy_ref: 'license', default_retention_policy_id: 'retention',
      head_rev: `r${i}`, created_at: now });
    insert(db, 'project_source_membership', { project_id: `p${i % 8}`, source_id: `s${i}`, role: 'source',
      valid_from: now, valid_to: null, membership_generation: 1 });
  }
  const writeObject = (objectKey, bytes) => {
    const path = join(objects, objectKey);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  };
  const revisions = [];
  for (let i = 0; i < 17; i++) {
    const source = `s${i % 15}`;
    const revision = `r${i}`;
    const manifest = { protocol: 'eliotr.normalized.v1', origin: { owner_system_id: 'owner',
      source_namespace_id: 'namespace', source_owner_generation: 'generation', source_revision_ref: revision,
      source_view_ref: sourceViewRef ?? `view${i}`, ownership_mode: 'immutable_import' },
    source: { logical_id: source, original_name: 'source.pdf', original_sha256: hash(original ?? 'unavailable PDF'),
      origin_location_class: 'external', mime_type: 'application/pdf' }, residency_and_disclosure: { ...domains, scope_domain_id: scopeDomain },
    normalization: { analyzer: 'fixture', analyzer_version: '1', profile: 'standard', config_hash: '1'.repeat(64), created_at: now },
    content: { markdown: 'content.md', markdown_sha256: hash(content) },
    capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false },
    quality: { state: 'standard', assurance_ceiling: 'source-local', warnings: [] },
    export: { purpose: 'test', receipt_ref: 'receipt' } };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestKey = key(source, revision, hash(manifestBytes), 'manifest.json', scopeDomain);
    const contentKey = key(source, revision, hash(content), 'content.md', scopeDomain);
    const originalKey = original === null ? (i % 2 ? '' : null) : `original/r${i}.pdf`;
    insert(db, 'source_revision', { source_revision_ref: revision, source_id: source, source_owner_generation: 'generation',
      content_sha256: hash(content), object_residency_key_digest: residency(hash(content), scopeDomain), original_r2_key: originalKey,
      normalized_artifact_ref: manifestKey, captured_at: now, quality_state: 'standard', purge_state: 'LIVE',
      currentness_state: 'unknown', source_view_ref: sourceViewRef ?? `view${i}`, admitted_at: now });
    writeObject(manifestKey, manifestBytes);
    writeObject(contentKey, content);
    if (original !== null) writeObject(originalKey, original);
    revisions.push({ manifest, manifestKey, contentKey });
  }
  db.close();
  return { root, database, objects, output, revisions, content, writeObject,
    mutate(sql) { const db = new DatabaseSync(database); try { db.exec(sql); } finally { db.close(); } } };
}

function fails(f, expected) {
  assert.throws(() => exportLegacy(f), expected);
  assert.equal(existsSync(join(f.output, 'export.json')), false, 'A failed export must have no completion marker');
}

test('exports 8 projects, 15 sources and all 17 LIVE revisions without inventing original files', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.database);
  const summary = exportLegacy(f);
  assert.equal(summary.projects, 8);
  assert.equal(summary.sources, 15);
  assert.equal(summary.live_revisions, 17);
  assert.equal(summary.originals_not_recorded, 17);
  assert.equal(summary.originals_verified, 0);
  const reportBytes = readFileSync(join(f.output, 'export.json'));
  assert.equal(hash(reportBytes), summary.export_sha256);
  const report = JSON.parse(reportBytes);
  assert.equal(report.verification, 'local_snapshot_only');
  assert.equal(report.memberships.length, 15);
  for (const revision of report.exported) {
    assert.equal(revision.original_status, 'not_recorded');
    assert.equal(revision.files.length, 2);
    const content = revision.files.find((file) => file.path.endsWith('/text.md'));
    assert.deepEqual(readFileSync(join(f.output, content.path)), f.content);
    assert.equal(content.legacy_key.includes('/content.md'), true);
    assert.notEqual(content.legacy_key.replace(/content.md$/, 'manifest.json'),
      revision.files.find((file) => file.path.endsWith('/manifest.json')).legacy_key);
  }
  assert.deepEqual(readFileSync(f.database), before, 'Database bytes must remain untouched');
  assert.throws(() => exportLegacy(f), /EEXIST/, 'Existing output must never be overwritten');
});

test('original bytes are only marked verified after checksum comparison', (t) => {
  const original = Buffer.from('%PDF-1.7\nfixture\n');
  const f = fixture(t, { original });
  assert.equal(exportLegacy(f).originals_verified, 17);
  const report = JSON.parse(readFileSync(join(f.output, 'export.json')));
  assert.deepEqual(readFileSync(join(f.output, report.exported[0].files.at(-1).path)), original);
});

test('changed manifest bytes fail even when parsed JSON identity is unchanged', (t) => {
  const f = fixture(t);
  f.writeObject(f.revisions[0].manifestKey, JSON.stringify(f.revisions[0].manifest, null, 2));
  fails(f, /Manifest key does not match/);
});

test('manifest identity cannot be borrowed from a different revision', (t) => {
  const f = fixture(t);
  f.mutate(`UPDATE source_revision SET normalized_artifact_ref='${f.revisions[1].manifestKey}' WHERE source_revision_ref='r0'`);
  fails(f, /Manifest does not match/);
});

test('normalized bytes must match D1 and manifest checksums', (t) => {
  const f = fixture(t);
  f.writeObject(f.revisions[0].contentKey, 'changed');
  fails(f, /Normalized content checksum mismatch/);
});

test('revision residency digest is checked before reading the content', (t) => {
  const f = fixture(t);
  f.mutate(`UPDATE source_revision SET object_residency_key_digest='${'a'.repeat(64)}' WHERE source_revision_ref='r0'`);
  fails(f, /Content residency digest/);
});

test('well-hashed invalid UTF-8 cannot be exported as readable text', (t) => {
  const f = fixture(t, { content: Buffer.from([0xff, 0xfe]) });
  fails(f, /encoded data was not valid/);
});

test('a missing or corrupt recorded original is an explicit failure', (t) => {
  const f = fixture(t, { original: Buffer.from('%PDF fixture') });
  f.writeObject('original/r0.pdf', 'wrong original');
  fails(f, /Original checksum mismatch/);
  rmSync(join(f.objects, 'original/r0.pdf'));
  fails({ ...f, output: join(f.root, 'second') }, /ENOENT/);
});

test('non-LIVE rows are retained as metadata but never read/exported', (t) => {
  const f = fixture(t);
  f.mutate("UPDATE source_revision SET purge_state='REDACTED', normalized_artifact_ref=NULL WHERE source_revision_ref='r0'");
  assert.equal(exportLegacy(f).live_revisions, 16);
  const report = JSON.parse(readFileSync(join(f.output, 'export.json')));
  assert.equal(report.revisions.length, 17);
  assert.equal(report.exported.some((revision) => revision.source_revision_ref === 'r0'), false);
});

test('unsafe object references cannot escape the snapshot', (t) => {
  const f = fixture(t);
  f.mutate("UPDATE source_revision SET normalized_artifact_ref='../core.sqlite' WHERE source_revision_ref='r0'");
  fails(f, /safe relative path/);
});

test('symlinked object references cannot escape the snapshot', (t) => {
  const f = fixture(t);
  f.mutate(`UPDATE source_revision SET normalized_artifact_ref='${f.revisions[0].manifestKey}' WHERE source_revision_ref='r0'`);
  rmSync(join(f.objects, f.revisions[0].manifestKey));
  try {
    symlinkSync(f.database, join(f.objects, f.revisions[0].manifestKey));
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('Windows denied symlink creation with EPERM');
      return;
    }
    throw error;
  }
  fails({ ...f, output: join(f.root, 'second') }, /symlink/);
});

test('input/output overlap and broken source heads fail closed', (t) => {
  const f = fixture(t);
  assert.throws(() => exportLegacy({ ...f, output: join(f.objects, 'export') }), /separate from/);
  assert.equal(existsSync(join(f.objects, 'export')), false);
  f.mutate("UPDATE source SET head_rev='r1' WHERE source_id='s0'");
  fails(f, /Source head refers/);
});

test('CLI returns a nonzero failure without contacting a service', () => {
  const result = spawnSync(process.execPath, ['scripts/legacy-export.mjs', '--remote'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

function replaceFirstManifest(f, edit) {
  const manifest = structuredClone(f.revisions[0].manifest);
  edit(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestKey = key('s0', 'r0', hash(bytes), 'manifest.json');
  f.writeObject(manifestKey, bytes);
  f.mutate(`UPDATE source_revision SET normalized_artifact_ref='${manifestKey}' WHERE source_revision_ref='r0'`);
}

for (const path of ['origin.ownership_mode', 'source.original_sha256', 'normalization', 'quality', 'export',
  'residency_and_disclosure.allowed_use', 'capabilities.figures']) {
  test(`a correctly rebound manifest missing ${path} fails full legacy validation`, (t) => {
    const f = fixture(t);
    replaceFirstManifest(f, (manifest) => {
      const parts = path.split('.');
      const property = parts.pop();
      const parent = parts.reduce((value, part) => value[part], manifest);
      delete parent[property];
    });
    fails(f, /complete legacy normalized-bundle schema/);
  });
}

for (const [name, edit] of [
  ['invalid date', (m) => { m.normalization.created_at = '2026-02-31T00:00:00Z'; }],
  ['invalid original checksum', (m) => { m.source.original_sha256 = 'not-a-sha256'; }],
  ['unknown nested property', (m) => { m.quality.unexpected = true; }],
  ['unknown root property', (m) => { m.unexpected = true; }],
  ['erc_owned ownership', (m) => { m.origin.ownership_mode = 'erc_owned'; }],
  ['cutover without receipt', (m) => { m.origin.ownership_mode = 'ownership_cutover'; }],
  ['receipt without cutover', (m) => { m.origin.ownership_cutover_receipt_ref = 'cutover'; }],
]) {
  test(`a correctly rebound manifest with ${name} fails full legacy validation`, (t) => {
    const f = fixture(t);
    replaceFirstManifest(f, edit);
    fails(f, /complete legacy normalized-bundle schema/);
  });
}

test('valid cutover and optional legacy fields remain compatible', (t) => {
  const f = fixture(t);
  replaceFirstManifest(f, (manifest) => {
    manifest.origin.ownership_mode = 'ownership_cutover';
    manifest.origin.ownership_cutover_receipt_ref = 'cutover';
    manifest.residency_and_disclosure.expiry = '2026-11-05T09:30:00+03:00';
    Object.assign(manifest.content, { structure: 'structure.json', mappings: 'mappings.json', tables: 'tables.json',
      coordinate_map_digest: 'a'.repeat(64), loss_map_digest: 'b'.repeat(64) });
  });
  assert.equal(exportLegacy(f).live_revisions, 17);
});

test('FIFO objects fail promptly rather than blocking on open', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const path = join(f.objects, f.revisions[0].manifestKey);
  rmSync(path);
  const create = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const result = spawnSync(process.execPath, ['scripts/legacy-export.mjs', '--database', f.database,
    '--objects', f.objects, '--output', f.output], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.error, undefined, 'Exporter must finish before the bounded subprocess timeout');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid object size\/type/);
  assert.equal(existsSync(join(f.output, 'export.json')), false);
});

for (const [label, value] of [
  ['200 Cyrillic characters', 'я'.repeat(200)],
  ['256 JS code units', '🐈'.repeat(128)],
  ['allowed whitespace, slash and control character', ' scope/я\n'],
]) {
  test(`residency domains and source_view_ref accept donor-valid ${label}`, (t) => {
    const f = fixture(t, { scopeDomain: value, sourceViewRef: value });
    assert.equal(exportLegacy(f).live_revisions, 17);
    const report = JSON.parse(readFileSync(join(f.output, 'export.json')));
    assert.equal(report.revisions[0].source_view_ref, value);
    assert.equal(report.exported[0].files[0].legacy_key, f.revisions[0].manifestKey);
  });
}

test('residency domains still reject more than 256 JS code units', (t) => {
  const f = fixture(t, { scopeDomain: 'я'.repeat(257) });
  fails(f, /complete legacy normalized-bundle schema/);
});
