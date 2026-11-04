#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prepareProcess } from './prepareProcess.js';
import { durationInWords, loadConfig, localBaseUrl } from './config.js';
import { listAccounts } from './storage/sqlite/accounts.js';
import {
  blockConnectionOffline,
  listConnectionsOffline,
} from './storage/sqlite/connectionsOffline.js';
import { LOGIN_LINK_TTL_MS, OPERATOR_LINK_TTL_MS } from './domain/auth.js';
import { createLoginLink } from './storage/sqlite/loginLink.js';
import {
  createOperatorLink,
  listOperatorsOffline,
  removeOperatorOffline,
} from './storage/sqlite/operators.js';
import { backupDataDir } from './storage/sqlite/backup.js';
import { DataDirInUseError } from './storage/sqlite/dataDirLock.js';
import { eraseWorkspaceOffline } from './storage/sqlite/erase.js';
import { forgetWakeUpKeys } from './storage/sqlite/forgetKeys.js';
import { resetLocalLogin } from './storage/sqlite/resetLogin.js';
import { BUDD_VERSION } from './version.js';

const USAGE = `Usage: budd <command>

Commands:
  serve            Start the Budd server (default)
  backup [dir]     Copy every database to dir (default ./backups/budd-<time>).
                   Safe while Budd is running. Reads DATA_DIR (default ./data).
  reset-login      Local mode: forget the UI username and password. The next
                   start prints a link to create a new login.
  login            Local mode: print a one-time link that signs you in to the
                   UI, for when too many wrong passwords have locked it.
                   Works while Budd is running. The link uses HOST and PORT
                   from .env: if you started Budd with others, set them here
                   too (PORT=9000 npm run budd -- login).
  connections [workspace]
                   List a workspace's connections (default: local), with
                   their status, handles and when each was last active.
  block <connection> [workspace]
                   Block a connection (default workspace: local), as the UI
                   does: its MCP calls fail and its sign-ins and API key are
                   revoked. Works while Budd is running.
  accounts         List who has an account, their workspace, how many apps
                   they've connected and how many API keys they've made.
                   Use it to find the workspace to erase when someone
                   leaves (docs/operating.md).
  operator <email> Hosted mode: print a one-time link that makes the account
                   signed in with that email an operator, who can open the
                   console at /console. Works while Budd is running.
  operators        List the operators: account ID, email, and since when.
  remove-operator <account id>
                   Take the console away from an operator, at once. Their
                   workspace stays as it is.
  erase-workspace <name>
                   Delete a workspace: its messages, audit log, connections
                   and app sign-ins, and its account. Stop Budd first. Older
                   backups still contain it.
  forget-wake-up-keys
                   Only if BUDD_SECRET_KEY is lost: forget every workspace's
                   wake-up key, so wake-ups can be entered again (they must
                   be). Messages are untouched. Works while Budd is running.
  version          Print Budd's version (also --version).
`;

const [command = 'serve', ...args] = process.argv.slice(2);
prepareProcess();

const dataDir = () => {
  const dir = process.env.DATA_DIR ?? './data';
  if (dir === '') {
    // As the server does: an empty value would quietly mean the current directory.
    console.error("DATA_DIR is empty: set it to Budd's data directory, or remove it for ./data.");
    process.exit(1);
  }
  return path.resolve(dir);
};

/** Says why a command that needs Budd stopped failed, and what to do, then exits. */
function failed(what: string, dir: string, err: unknown): never {
  const code = (err as { code?: string }).code ?? '';
  console.error(
    err instanceof DataDirInUseError
      ? `Budd is running with ${dir}. Stop it first${existsSync('/.dockerenv') ? ' (docker compose stop budd)' : ''}, then run this again.`
      : code === 'EACCES' || code === 'EPERM' || code.startsWith('SQLITE_READONLY')
        ? `${what} failed: ${dir} isn't writable by this user (${code}). Run it as the user that runs Budd.`
        : `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

/** Hosted mode has no workspace called local: say to name one. */
const unknownWorkspace = (workspace: string, dir: string) =>
  `No workspace named ${workspace} in ${dir}. ${
    workspace === 'local' ? 'In hosted mode, name the workspace: ' : ''
  }\`budd accounts\` lists them.`;

/** YYYY-MM-DD HH:MM in this machine's time zone. */
function localTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printTable(table: string[][]): void {
  const widths = table[0]?.map((_, i) => Math.max(...table.map((row) => row[i]?.length ?? 0)));
  for (const row of table) {
    console.log(
      row
        .map((cell, i) => cell.padEnd(widths?.[i] ?? 0))
        .join('  ')
        .trimEnd(),
    );
  }
}

async function backup(dest: string | undefined): Promise<void> {
  const dir = dataDir();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const destDir = path.resolve(dest ?? path.join('backups', `budd-${stamp}`));
  const results = await backupDataDir(dir, destDir);
  const kb = Math.ceil(results.reduce((n, r) => n + r.bytes, 0) / 1024);
  console.log(
    `Backed up ${String(results.length)} database(s), ${String(kb)} KB, from ${dir} to ${destDir}`,
  );
  console.log('To restore it, see "Backups" in docs/operating.md.');
}

/** The settings, or a message naming what's wrong with them and exit 1. */
function configOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

switch (command) {
  case 'serve': {
    // Loaded only here, so the other commands start without the server's dependencies.
    const { main } = await import('./main.js');
    await main();
    break;
  }
  case 'backup':
    try {
      await backup(args[0]);
    } catch (err) {
      console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    break;
  case 'reset-login': {
    const dir = dataDir();
    try {
      const removed = resetLocalLogin(dir);
      console.log(
        removed
          ? 'The UI login was removed. Start Budd: it will print a link to create a new one.'
          : `No UI login found in ${dir}. Start Budd: it prints a link to create one.`,
      );
    } catch (err) {
      failed('Resetting the login', dir, err);
    }
    break;
  }
  case 'login': {
    const hosted = () => {
      console.error(
        'budd login is for local mode. In hosted mode, sign in with your identity provider.',
      );
      process.exit(1);
    };
    // Before the rest of the configuration, which hosted mode needs much more of.
    if (process.env.BUDD_MODE === 'hosted') hosted();
    const config = configOrExit();
    if (config.mode !== 'local') hosted();
    try {
      const code = await createLoginLink(config.dataDir);
      if (code === undefined) {
        console.error('Budd has no UI login yet: open the setup link printed when Budd starts.');
        process.exit(1);
      }
      console.log(`Sign in within ${durationInWords(LOGIN_LINK_TTL_MS)} (the link works once):`);
      console.log(`  ${localBaseUrl(config)}/login/link?code=${code}`);
    } catch (err) {
      failed('Making a sign-in link', config.dataDir, err);
    }
    break;
  }
  case 'connections': {
    const dir = dataDir();
    const workspace = args[0] ?? 'local';
    try {
      const rows = await listConnectionsOffline(dir, workspace);
      if (rows === 'unknown_workspace') {
        console.error(unknownWorkspace(workspace, dir));
        process.exit(1);
      }
      if (rows.length === 0) console.log('No connections yet.');
      else {
        printTable([
          ['CONNECTION', 'KIND', 'STATUS', 'LAST ACTIVE (LOCAL TIME)', 'HANDLES'],
          ...rows.map((r) => [
            r.slug,
            r.kind,
            r.archivedAt === null ? r.status : 'archived',
            r.lastSeenAt === null ? 'never' : localTime(r.lastSeenAt),
            r.handles.join(', '),
          ]),
        ]);
      }
    } catch (err) {
      failed('Listing connections', dir, err);
    }
    break;
  }
  case 'block': {
    const [connection, workspace = 'local'] = args;
    if (connection === undefined || args.length > 2) {
      console.error(`Name the connection to block, e.g. budd block grok-build.\n\n${USAGE}`);
      process.exit(2);
    }
    const dir = dataDir();
    try {
      const outcome = await blockConnectionOffline(dir, workspace, connection);
      if (outcome === 'unknown_workspace' || outcome === 'unknown_connection') {
        console.error(
          outcome === 'unknown_workspace'
            ? unknownWorkspace(workspace, dir)
            : `No connection named ${connection} in ${workspace}. \`budd connections ${workspace}\` lists them.`,
        );
        process.exit(1);
      }
      console.log(
        outcome === 'blocked'
          ? `Blocked ${connection}: its tool calls now fail and nobody can message it. Unblock it in the UI.`
          : `${connection} was already blocked.`,
      );
    } catch (err) {
      failed('Blocking', dir, err);
    }
    break;
  }
  case 'accounts':
    try {
      const rows = listAccounts(dataDir());
      if (rows.length === 0) console.log('No accounts yet.');
      else {
        printTable([
          ['EMAIL', 'WORKSPACE', 'CREATED', 'APPS (LIVE)', 'API KEYS'],
          ...rows.map((r) => [
            r.email ?? '(no email)',
            r.workspace,
            new Date(r.createdAt).toISOString().slice(0, 10),
            `${String(r.apps)} (${String(r.liveApps)})`,
            String(r.keys),
          ]),
        ]);
      }
    } catch (err) {
      console.error(`Listing accounts failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    break;
  case 'operator': {
    const config = configOrExit();
    if (!config.hosted) {
      console.log(
        `In local mode, your UI login is the operator: open ${localBaseUrl(config)}/console`,
      );
      break;
    }
    const email = args[0];
    if (email === undefined || args.length > 1 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      console.error(`Name the email address the new operator signs in with.\n\n${USAGE}`);
      process.exit(2);
    }
    try {
      const code = await createOperatorLink(config.dataDir, email);
      console.log(
        `Send this to ${email}, to open within ${durationInWords(OPERATOR_LINK_TTL_MS)}: signed in with that email, they become an operator. It works once, and only for them.`,
      );
      console.log(`  ${config.hosted.publicUrl}/console/enrol?code=${code}`);
    } catch (err) {
      failed('Making an operator link', config.dataDir, err);
    }
    break;
  }
  case 'operators': {
    const dir = dataDir();
    try {
      const rows = listOperatorsOffline(dir);
      if (rows.length === 0) {
        console.log(
          'No operators yet. In hosted mode, `budd operator` prints a link to add one; in local mode, your UI login is the operator.',
        );
      } else {
        printTable([
          ['ACCOUNT', 'EMAIL', 'OPERATOR SINCE (LOCAL TIME)'],
          ...rows.map((r) => [r.accountId, r.email ?? '(no email)', localTime(r.addedAt)]),
        ]);
      }
    } catch (err) {
      failed('Listing operators', dir, err);
    }
    break;
  }
  case 'remove-operator': {
    const accountId = args[0];
    if (accountId === undefined || args.length > 1) {
      console.error(`Name one account ID, from budd operators.\n\n${USAGE}`);
      process.exit(2);
    }
    const dir = dataDir();
    try {
      if (await removeOperatorOffline(dir, accountId)) {
        console.log(
          `${accountId} is no longer an operator, as of ${localTime(Date.now())}: the console refuses it from now on.`,
        );
      } else {
        console.error(`${accountId} isn't an operator. \`budd operators\` lists them.`);
        process.exitCode = 1;
      }
    } catch (err) {
      failed('Removing an operator', dir, err);
    }
    break;
  }
  case 'erase-workspace': {
    const slug = args[0];
    if (slug === undefined || args.length > 1) {
      console.error(`Name one workspace to erase, e.g. budd erase-workspace alice.\n\n${USAGE}`);
      process.exit(2);
    }
    const dir = dataDir();
    try {
      const erased = eraseWorkspaceOffline(dir, slug);
      if (!erased) {
        console.error(`No workspace named ${slug} in ${dir}. \`budd accounts\` lists them.`);
        process.exit(1);
      }
      const emails = erased.accounts.map((a) => a.email ?? '(local login)');
      console.log(
        `Erased workspace ${slug} (${erased.id})${emails.length > 0 ? ` and its account ${emails.join(', ')}` : ''}.`,
      );
      console.log('Backups taken before now still contain it.');
    } catch (err) {
      failed('Erasing', dir, err);
    }
    break;
  }
  case 'forget-wake-up-keys': {
    const dir = dataDir();
    try {
      const n = forgetWakeUpKeys(dir);
      console.log(
        `Forgot the wake-up keys of ${String(n)} workspace${n === 1 ? '' : 's'}. Their wake-ups must be entered again; each mailbox page asks.`,
      );
    } catch (err) {
      failed('Forgetting keys', dir, err);
    }
    break;
  }
  case 'version':
  case '--version':
  case '-v':
    console.log(BUDD_VERSION);
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exit(2);
}
