import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, type Config } from './config.js';
import { log } from './log.js';
import { prepareProcess } from './prepareProcess.js';
import { startServer } from './server.js';
import { DataDirInUseError } from './storage/sqlite/dataDirLock.js';
import { SchemaTooNewError } from './storage/sqlite/migrate.js';

export async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  let server;
  try {
    server = await startServer(config);
  } catch (err) {
    const hint = startupHint(err, config);
    if (hint) {
      console.error(hint);
      process.exit(1);
    }
    throw err;
  }
  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    // A second Ctrl-C stops immediately instead of waiting.
    process.once('SIGINT', () => {
      log.info('forced exit', { signal: 'SIGINT' });
      process.exit(130);
    });
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('shutdown failed', { error: String(err) });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** One line for the startup failures an operator can fix, instead of a stack trace. */
export function startupHint(err: unknown, config: Config): string | undefined {
  if (err instanceof SchemaTooNewError) return `Budd can't start: ${err.message}`;
  if (err instanceof DataDirInUseError) {
    return `Budd can't start: another Budd, or a budd command such as erase-workspace, is using its data directory ${config.dataDir}. Stop it, or set DATA_DIR to another directory.`;
  }
  const { code, syscall } = (err ?? {}) as NodeJS.ErrnoException;
  if (code === 'EADDRINUSE') {
    return `Budd can't start: port ${String(config.port)} on ${config.host} is already in use. Stop whatever is using it, or set PORT to another port.`;
  }
  if (syscall === 'listen' && code === 'EACCES') {
    return `Budd can't start: it isn't allowed to listen on port ${String(config.port)} (ports below 1024 need extra privileges). Set PORT to 1024 or above, and put a reverse proxy in front if you need 80 or 443.`;
  }
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'SQLITE_CANTOPEN' ||
    code?.startsWith('SQLITE_READONLY')
  ) {
    return `Budd can't start: it can't write to its data directory ${config.dataDir} (${code}). Check that DATA_DIR exists and is owned by the user running Budd.`;
  }
  return undefined;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  prepareProcess();
  await main();
}
