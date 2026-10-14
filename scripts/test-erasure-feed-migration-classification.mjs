import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { classifyDeploymentMigrationSql } from './lib/deployment-migration-operation.mjs';
import { projectDeploymentNativeCommentlessSql } from './lib/deployment-native-sql-representation.mjs';

const raw = await readFile(new URL('../infra/d1/core/migrations/0138_erasure_completion_feed_readiness.sql', import.meta.url), 'utf8');
for (const sql of [raw, projectDeploymentNativeCommentlessSql(raw).sql]) {
  const classified = classifyDeploymentMigrationSql(sql);
  assert.equal(classified.classification, 'schema_metadata_only');
  assert.equal(classified.bounded_metadata_writes, 1);
  assert.deepEqual(classified.metadata_markers, [{ key: 'erasure_completion_feed_generation', value: 'erasure-completion-feed-v1' }]);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE schema_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT); CREATE TABLE erasure_execution(id TEXT);');
    db.exec(sql);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_state').get().n, 0);
    db.exec('CREATE TRIGGER erasure_execution_completion_change_feed AFTER INSERT ON erasure_execution BEGIN SELECT 1; END;');
    db.exec(sql);
    assert.equal(db.prepare('SELECT value FROM schema_state').get().value, 'erasure-completion-feed-v1');
  } finally { db.close(); }
}
for (const changed of [
  raw.replace("type='trigger'", "type='table'"),
  raw.replace("name='erasure_execution_completion_change_feed'", "name='unrelated_trigger'"),
  raw.replace("tbl_name='erasure_execution'", "tbl_name='unrelated_table'"),
  raw.replace('erasure-completion-feed-v1', 'erasure-completion-feed-v2'),
  raw.slice(0, raw.indexOf('WHERE EXISTS')),
  raw + '\nDELETE FROM erasure_execution;',
]) assert.throws(() => classifyDeploymentMigrationSql(changed));
console.log('Erasure marker classification: 2 causal forms and 6 strict negatives PASS');
