import path from 'node:path';
import Database from 'better-sqlite3';

export class DataDirInUseError extends Error {
  override name = 'DataDirInUseError';
  constructor(readonly dataDir: string) {
    super(`another Budd process is using the data directory ${dataDir}`);
  }
}

/**
 * Claims `dataDir` for this process until the returned function is called.
 * The claim is an open exclusive SQLite transaction on `budd.lock`, so the
 * operating system drops it if the process dies, and it works across Docker
 * containers that share the volume. Throws DataDirInUseError if another
 * process (or another Storage in this one) holds it.
 */
export function lockDataDir(dataDir: string): () => void {
  const db = new Database(path.join(dataDir, 'budd.lock'), { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new DataDirInUseError(dataDir);
    throw err;
  }
  return () => {
    db.close();
  };
}
