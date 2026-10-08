/// <reference types="vite/client" />

interface SqliteMigrationDatabase {
  exec(source: string): unknown;
  prepare(query: string): unknown;
}

const coreMigrationSources = import.meta.glob<string>("../../../infra/d1/core/migrations/*.sql", {
  eager: true,
  query: "?raw",
  import: "default",
});
const migrations = Object.freeze(Object.entries(coreMigrationSources)
  .map(([path, source]) => ({ name: path.slice(path.lastIndexOf("/") + 1), source }))
  .filter((migration) => /^\d{4}_.+\.sql$/u.test(migration.name))
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

if (migrations.length <= 90) {
  throw new Error("canonical Core migration fixture found an incomplete migration set");
}

export function applyCanonicalCoreMigrations(database: SqliteMigrationDatabase): void {
  for (const migration of migrations) database.exec(migration.source);
}

export function recordCanonicalCoreMigrationLedger(database: SqliteMigrationDatabase, appliedAt: string): void {
  const baseTime = Date.parse(appliedAt);
  if (!Number.isFinite(baseTime)) throw new TypeError("canonical Core migration fixture needs a valid ledger timestamp");
  const insert = database.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1, ?2)") as {
    run(name: string, timestamp: string): unknown;
  };
  for (const [index, migration] of migrations.entries()) {
    insert.run(migration.name, new Date(baseTime + index * 1_000).toISOString());
  }
}
