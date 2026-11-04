import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface BackupResult {
  file: string;
  bytes: number;
}

/**
 * Copies the control DB and every workspace DB in `dataDir` to `destDir` with
 * SQLite's online backup API. Safe while Budd is running: each source is
 * opened read-only and copied as a consistent snapshot, and nothing is
 * migrated. Each copy is integrity-checked.
 */
export async function backupDataDir(dataDir: string, destDir: string): Promise<BackupResult[]> {
  const controlPath = path.join(dataDir, 'control.db');
  if (!fs.existsSync(controlPath)) {
    throw new Error(`No Budd data found: ${controlPath} does not exist. Is DATA_DIR right?`);
  }
  if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
    throw new Error(`${destDir} already exists and is not empty. Choose a new directory.`);
  }
  const control = new Database(controlPath, { readonly: true, fileMustExist: true });
  let workspaceIds: string[];
  try {
    workspaceIds = (
      control.prepare('SELECT id FROM workspaces ORDER BY id').all() as { id: string }[]
    ).map((r) => r.id);
  } finally {
    control.close();
  }
  const sources = [
    'control.db',
    ...workspaceIds
      .map((id) => path.join('workspaces', `${id}.db`))
      .filter((rel) => fs.existsSync(path.join(dataDir, rel))), // created on first use
  ];
  const results: BackupResult[] = [];
  for (const rel of sources) {
    const dest = path.join(destDir, rel);
    // New directories are private; one the user named and made stays as it is.
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const db = new Database(path.join(dataDir, rel), { readonly: true, fileMustExist: true });
    try {
      await db.backup(dest);
    } finally {
      db.close();
    }
    const copy = new Database(dest, { readonly: true });
    try {
      const check = copy.pragma('integrity_check', { simple: true });
      if (check !== 'ok') throw new Error(`integrity check failed for ${dest}: ${String(check)}`);
    } finally {
      copy.close();
    }
    // Opening the copy to check it leaves empty WAL/SHM files beside it.
    for (const ext of ['-wal', '-shm']) fs.rmSync(dest + ext, { force: true });
    results.push({ file: dest, bytes: fs.statSync(dest).size });
  }
  return results;
}
