import type { Database } from 'better-sqlite3';

/** An ordered schema migration. Versions must be 1, 2, 3, ... with no gaps. */
export interface Migration {
  version: number;
  up: string;
}

/** The database was written by a newer Budd than this one. */
export class SchemaTooNewError extends Error {
  override name = 'SchemaTooNewError';

  constructor(file: string, schema: number, known: number) {
    super(
      `${file} was last used by a newer version of Budd (schema ${String(schema)}, this version knows ${String(known)}). Run the newer version, or restore a backup taken before the upgrade.`,
    );
  }
}

/** Applies any migrations newer than the DB's `user_version`, each in its own transaction. */
export function migrate(db: Database, migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`migration ${i} has version ${m.version}, expected ${i + 1}`);
  });
  const current = db.pragma('user_version', { simple: true }) as number;
  // Downgrades aren't supported: an older Budd could misread a newer schema.
  if (current > migrations.length) {
    throw new SchemaTooNewError(db.name, current, migrations.length);
  }
  for (const m of migrations.slice(current)) {
    db.transaction(() => {
      db.exec(m.up);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
