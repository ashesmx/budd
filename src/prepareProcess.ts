import { existsSync } from 'node:fs';

/**
 * Setup shared by `npm start` and the `budd` CLI, before anything else runs:
 * files Budd creates (databases, WAL files, backups) are private to its OS
 * user, and settings come from ./.env if there is one (variables already set
 * win). Node's --env-file-if-exists would print ".env not found" when there
 * isn't one, which is normal in local mode.
 */
export function prepareProcess(): void {
  process.umask(0o077);
  if (!existsSync('.env')) return;
  try {
    process.loadEnvFile('.env');
  } catch {
    // Node reports an unreadable file as ENOENT, so the code would mislead.
    console.error(
      `Budd can't read .env in ${process.cwd()}. Check that the user running Budd owns it and can read it.`,
    );
    process.exit(1);
  }
}
