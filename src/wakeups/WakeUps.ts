import { ulid } from 'ulid';
import { AdminError } from '../admin/Admin.js';
import { SYSTEM_CONNECTION_SLUG } from '../domain/slug.js';
import type { Connection } from '../domain/types.js';
import { log } from '../log.js';
import { TokenBucketRateLimiter } from '../ratelimit/TokenBucketRateLimiter.js';
import type { AdminContext, WorkspaceGateway } from '../storage/gateway.js';
import type { DueWakeUp, WakeUpRecord, WorkspaceStore } from '../storage/Storage.js';
import { checkUrl, isHeaderSafe, type Deliver, type Outcome } from './deliver.js';
import { open, seal } from './secrets.js';
import type { WorkspaceKeys } from './workspaceKeys.js';

/** How long a human may choose to wait between retries. */
export const RETRY_INTERVALS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 } as const;
export type RetryInterval = keyof typeof RETRY_INTERVALS;
export const MAX_RETRIES = 5;
const MAX_TOKEN_LENGTH = 4096;
/** Shorter tokens show no hint: their last 4 characters would give too much away. */
const HINTED_TOKEN_LENGTH = 16;
/** Wake-ups sent at once across all workspaces, so one slow platform can't hold up the rest. */
const PARALLEL = 8;

export type WakeUpStates = Map<string, 'on' | 'failing'>;

/** What the UI shows of a wake-up: never its address or token. */
export interface WakeUpView {
  host: string;
  /** No token: null. A token too short to hint at: ''. */
  tokenHint: string | null;
  /** Whether wake-ups are signed. */
  signed: boolean;
  /** WAKE_UP_HOSTS no longer lists its host, so it isn't sent. */
  hostNotAllowed: boolean;
  retryInterval: RetryInterval;
  maxRetries: number;
  lastAt: number | null;
  lastStatus: string | null;
  lastOk: boolean | null;
  /** The workspace's key can't open what's stored: the human must enter it again. */
  unreadable: boolean;
}

/**
 * The one request every platform gets: which mailbox has mail, and what to do.
 * No message content, sender or subject: the routine's own prompt says the rest.
 * Its id and time are in the body, so a signature covers them: a receiver can
 * refuse a copy sent again later.
 */
const wakeUpBody = (slug: string, handle: string, id: string, sentAt: number) =>
  JSON.stringify({
    event: 'budd.mail',
    mailbox: `${slug}/${handle}`,
    text: `You have unread mail on Budd in ${slug}/${handle}. Call inbox with handle "${handle}".`,
    id,
    sent_at: new Date(sentAt).toISOString(),
  });

/** The secrets a wake-up keeps sealed. */
type Secret = 'url' | 'token' | 'signing';
type Where = { connectionId: string; handle: string };

/** Whose and what a sealed value is, so it opens nowhere else. */
const context = (workspaceId: string, w: Where, what: Secret) =>
  `budd wake-up ${what} ${workspaceId}/${w.connectionId}/${w.handle}`;

/** A sealed secret opened: null if there's none, undefined if it won't open. */
const unseal = (
  key: Buffer | undefined,
  workspaceId: string,
  w: Where,
  sealed: Buffer | null,
  what: Secret,
) => (sealed === null ? null : key && open(key, sealed, context(workspaceId, w, what)));

/** Whether all of a wake-up's secrets open with `key`. */
const readable = (key: Buffer | undefined, workspaceId: string, w: WakeUpRecord) =>
  (
    [
      [w.urlSealed, 'url'],
      [w.tokenSealed, 'token'],
      [w.signingSecretSealed, 'signing'],
    ] as const
  ).every(([sealed, what]) => unseal(key, workspaceId, w, sealed, what) !== undefined);

const sealAs = (key: Buffer, workspaceId: string, w: Where, value: string | null, what: Secret) =>
  value === null ? null : seal(key, value, context(workspaceId, w, what));

/** A `whsec_` secret's key is the base64 after the prefix: at least 16 bytes of it, so it can't be guessed. */
const isWhsec = (secret: string) =>
  Buffer.from(secret.slice('whsec_'.length), 'base64').length >= 16;

function checkHeaderValue(value: string, what: string): void {
  if (value && (value.length > MAX_TOKEN_LENGTH || !isHeaderSafe(value))) {
    throw new AdminError(
      'invalid_input',
      `That ${what} has spaces, "…" or other characters it can’t have. Copy it again from your platform, exactly.`,
    );
  }
}

/**
 * Wake-ups (ADR 0019): set by a human, sent when mail arrives and by their own
 * sweeper (retries, and mail to a mailbox woken since the last sweep). Their
 * addresses, tokens and signing secrets are sealed with the workspace's key
 * (WorkspaceKeys).
 */
export class WakeUps {
  /** A test is a human's click, but one that reaches outside: a few, not a stream. */
  private readonly testsPerMailbox = new TokenBucketRateLimiter(1, 30_000, 10_000);
  private readonly testsPerWorkspace = new TokenBucketRateLimiter(20, 3_600_000, 10_000);
  /**
   * The sweep and new mail can find the same wake-up due at once. A wake-up
   * found due is stale if its mailbox has a send in flight, or one that
   * finished after it was found: what it read is out of date.
   */
  private finished = 0;
  private readonly lastSend = new Map<string, { finished?: number }>();
  /** Workspaces being checked for new mail: true if more mail arrived meanwhile. */
  private readonly checking = new Map<string, boolean>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  /** Sweeps and checks for new mail under way; at none, nothing in lastSend is needed. */
  private passes = 0;

  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly keys: WorkspaceKeys,
    private readonly deliver: Deliver,
    private readonly opts: {
      /** WAKE_UP_HOSTS: the only hosts wake-ups may go to; '*' for any public host. */
      hosts: string[];
      /** WAKE_UPS_PER_HOUR. */
      perHour: number;
      /**
       * SWEEP_INTERVAL. New mail wakes a mailbox at once unless it was woken
       * this recently; then the next sweep sends it, so a burst is one wake-up.
       */
      sweepIntervalMs: number;
    },
    private readonly clock: () => number = Date.now,
  ) {}

  /** At startup: says which saved wake-ups WAKE_UP_HOSTS now stops. */
  async init(): Promise<void> {
    const stopped = new Set<string>();
    await this.gateway.forEachWorkspace(async (workspace, store) => {
      try {
        for (const w of await store.listWakeUps()) if (!this.allowed(w.host)) stopped.add(w.host);
      } catch (err) {
        log.error('wake-ups not checked', { workspace: workspace.slug, error: String(err) });
      }
    });
    if (stopped.size > 0) {
      log.warn("wake-ups not sent: their hosts aren't in WAKE_UP_HOSTS", { hosts: [...stopped] });
    }
  }

  /** WAKE_UP_HOSTS: ['*'] for any public host. */
  get hosts(): readonly string[] {
    return this.opts.hosts;
  }

  /** Whether WAKE_UP_HOSTS lets wake-ups go to `host` (as URL.host gives it: lower case). */
  private allowed(host: string): boolean {
    return this.opts.hosts.includes('*') || this.opts.hosts.includes(host);
  }

  /** The connection a wake-up is for: not Budd's own, and (unless turning one off) not archived. */
  private async connection(
    store: WorkspaceStore,
    slug: string,
    opts: { archivedToo?: boolean } = {},
  ): Promise<Connection> {
    const c = slug === SYSTEM_CONNECTION_SLUG ? undefined : await store.getConnectionBySlug(slug);
    if (!c) throw new AdminError('unknown_connection', `No connection named "${slug}".`);
    if (c.archivedAt !== null && !opts.archivedToo) {
      throw new AdminError('archived', `"${slug}" is archived.`);
    }
    return c;
  }

  async view(ctx: AdminContext, slug: string, handle: string): Promise<WakeUpView | undefined> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await store.getConnectionBySlug(slug);
    const w = c && (await store.getWakeUp(c.id, handle));
    if (!w) return undefined;
    const key = await this.keys.get(ctx.workspace.id);
    const unreadable = !readable(key, ctx.workspace.id, w);
    const interval = (Object.keys(RETRY_INTERVALS) as RetryInterval[]).find(
      (k) => RETRY_INTERVALS[k] === w.retryIntervalMs,
    );
    return {
      host: w.host,
      tokenHint: w.tokenHint,
      signed: w.signingSecretSealed !== null,
      hostNotAllowed: !this.allowed(w.host),
      retryInterval: interval ?? '15m',
      maxRetries: w.maxRetries,
      lastAt: w.lastAt,
      lastStatus: w.lastStatus,
      lastOk: w.lastOk,
      unreadable,
    };
  }

  /**
   * Each mailbox with a wake-up, by `connectionId/handle`: failing if its latest
   * one didn't get through, WAKE_UP_HOSTS no longer lets it, or its address
   * won't open (so a lost key shows before mail arrives).
   */
  async states(ctx: AdminContext): Promise<WakeUpStates> {
    const store = await this.gateway.forAdmin(ctx);
    const wakeUps = await store.listWakeUps();
    const key = wakeUps.length > 0 ? await this.keys.get(ctx.workspace.id) : undefined;
    return new Map(
      wakeUps.map((w) => [
        `${w.connectionId}/${w.handle}`,
        w.lastOk === false || !this.allowed(w.host) || !readable(key, ctx.workspace.id, w)
          ? 'failing'
          : 'on',
      ]),
    );
  }

  /**
   * Saves a mailbox's wake-up. A blank address keeps the current one; a blank
   * token keeps the current one if the address is kept, and `noToken` clears it.
   * The signing secret works the same way (`noSigning` clears it). A new address
   * never inherits the old token or secret: whoever changes where it goes must
   * have the ones for there.
   */
  async set(
    ctx: AdminContext,
    slug: string,
    handle: string,
    input: {
      url: string;
      token: string;
      noToken: boolean;
      signingSecret: string;
      noSigning: boolean;
      retryInterval: RetryInterval;
      maxRetries: number;
    },
  ): Promise<void> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    const where = { connectionId: c.id, handle };
    const ws = ctx.workspace.id;
    const key = await this.keys.forSaving(ws);
    const current = await store.getWakeUp(c.id, handle);
    const currentUrl = current && unseal(key, ws, where, current.urlSealed, 'url');
    const currentToken = current && unseal(key, ws, where, current.tokenSealed, 'token');
    const currentSecret = current && unseal(key, ws, where, current.signingSecretSealed, 'signing');

    const typedUrl = input.url.trim();
    if (!typedUrl && !currentUrl) {
      throw new AdminError('invalid_input', 'Paste the https:// address your platform gave you.');
    }
    const checked = checkUrl(typedUrl || (currentUrl ?? ''));
    if ('error' in checked) throw new AdminError('invalid_input', checked.error);
    if (!this.allowed(checked.url.host)) {
      throw new AdminError(
        'invalid_input',
        `Budd only sends wake-ups to ${this.opts.hosts.join(', ')}. To use ${checked.url.host}, ask whoever runs Budd to add it to WAKE_UP_HOSTS.`,
      );
    }
    const token = input.token.trim();
    const secret = input.signingSecret.trim();
    checkHeaderValue(token, 'token');
    checkHeaderValue(secret, 'signing secret');
    // A half-pasted `whsec_` secret would decode to a short or empty key that anyone could sign with.
    if (secret.startsWith('whsec_') && !isWhsec(secret)) {
      throw new AdminError(
        'invalid_input',
        'That signing secret is cut short: after "whsec_" it needs at least 22 more letters and digits. Copy it again from your platform, exactly.',
      );
    }
    if (
      !Number.isInteger(input.maxRetries) ||
      input.maxRetries < 0 ||
      input.maxRetries > MAX_RETRIES
    ) {
      throw new AdminError(
        'invalid_input',
        `Retries must be between 0 and ${String(MAX_RETRIES)}.`,
      );
    }
    // The same address however it was typed (case, a trailing slash) keeps its token.
    const sameAddress = checked.url.href === currentUrl;
    const keptToken = sameAddress ? (currentToken ?? null) : null;
    const finalToken = input.noToken ? null : token || keptToken;
    const finalSecret = input.noSigning
      ? null
      : secret || (sameAddress ? (currentSecret ?? null) : null);
    const saved = await store.setWakeUp({
      ...where,
      urlSealed: seal(key, checked.url.href, context(ws, where, 'url')),
      tokenSealed: sealAs(key, ws, where, finalToken, 'token'),
      signingSecretSealed: sealAs(key, ws, where, finalSecret, 'signing'),
      host: checked.url.host,
      tokenHint:
        finalToken === null
          ? null
          : finalToken.length >= HINTED_TOKEN_LENGTH
            ? finalToken.slice(-4)
            : '',
      retryIntervalMs: RETRY_INTERVALS[input.retryInterval],
      maxRetries: input.maxRetries,
      newAddress: !sameAddress,
      now: this.clock(),
    });
    if (!saved) throw new AdminError('unknown_mailbox', `No mailbox "${slug}/${handle}" in use.`);
    log.info('wake-up set', {
      workspace: ctx.workspace.slug,
      mailbox: `${slug}/${handle}`,
      host: checked.url.host,
    });
  }

  async remove(ctx: AdminContext, slug: string, handle: string): Promise<boolean> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug, { archivedToo: true });
    return store.removeWakeUp({ connectionId: c.id, handle, actor: 'human', now: this.clock() });
  }

  /** Sends one now, whatever the mail, and records the result. Not audited, like every wake-up. */
  async test(ctx: AdminContext, slug: string, handle: string): Promise<Outcome> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    const w = await store.getWakeUp(c.id, handle);
    if (!w) throw new AdminError('unknown_mailbox', `"${slug}/${handle}" has no wake-up.`);
    const now = this.clock();
    if (
      !this.testsPerMailbox.tryConsume(`${ctx.workspace.id}/${c.id}/${handle}`, now) ||
      !this.testsPerWorkspace.tryConsume(ctx.workspace.id, now)
    ) {
      throw new AdminError('test_too_soon', 'Wait a moment before sending another test.');
    }
    const key = await this.keys.get(ctx.workspace.id);
    const outcome = await this.send(
      key,
      ctx.workspace.id,
      store,
      { ...w, connectionSlug: slug },
      'test',
    );
    // Logged, unlike other wake-ups: a test is the one a person can repeat at will.
    log.info('wake-up tested', {
      workspace: ctx.workspace.slug,
      mailbox: `${slug}/${handle}`,
      host: w.host,
      status: outcome.status,
    });
    return outcome;
  }

  private async send(
    key: Buffer | undefined,
    workspaceId: string,
    store: WorkspaceStore,
    w: WakeUpRecord & { connectionSlug: string },
    kind: 'first' | 'retry' | 'test',
  ): Promise<Outcome> {
    const url = unseal(key, workspaceId, w, w.urlSealed, 'url');
    const token = unseal(key, workspaceId, w, w.tokenSealed, 'token');
    const signingSecret = unseal(key, workspaceId, w, w.signingSecretSealed, 'signing');
    const now = this.clock();
    const id = ulid(now);
    const outcome =
      !url || token === undefined || signingSecret === undefined
        ? { ok: false, status: 'not sent: enter the wake-up again' }
        : !this.allowed(w.host) || !this.allowed(new URL(url).host)
          ? { ok: false, status: `not sent: ${w.host} isn't in WAKE_UP_HOSTS` }
          : await this.deliver({
              url,
              token,
              signingSecret,
              id,
              body: wakeUpBody(w.connectionSlug, w.handle, id, now),
            });
    await store.recordWakeUp({
      connectionId: w.connectionId,
      handle: w.handle,
      kind,
      ok: outcome.ok,
      status: outcome.status,
      now: this.clock(),
    });
    return outcome;
  }

  /** Every wake-up due in every workspace, a few at a time; one that fails never stops the rest. */
  async sweep(): Promise<void> {
    await this.pass(async () => {
      const due: Due[] = [];
      await this.gateway.forEachWorkspace(async (workspace, store) => {
        due.push(...(await this.dueIn(workspace, store)));
      });
      await this.dispatch(due);
    });
  }

  /**
   * New mail in a workspace: wake its mailboxes now, so the first message isn't
   * held for the sweep. One woken in the last minute waits for the sweep, so a
   * burst of mail is still one wake-up.
   */
  mailArrived(workspaceId: string): void {
    if (this.stopped) return; // the next start's sweep sends it
    if (this.checking.has(workspaceId)) {
      this.checking.set(workspaceId, true);
      return;
    }
    const check = (async () => {
      do {
        this.checking.set(workspaceId, false);
        try {
          await this.pass(() =>
            this.gateway.forWorkspace(workspaceId, async (workspace, store) => {
              const recent = this.clock() - this.opts.sweepIntervalMs;
              const due = await this.dueIn(workspace, store);
              await this.dispatch(
                due.filter(({ w }) => w.kind === 'first' && (w.attemptAt ?? 0) <= recent),
              );
            }),
          );
        } catch (err) {
          log.error('wake-ups skipped', { workspace_id: workspaceId, error: String(err) });
        }
      } while (this.checking.get(workspaceId) === true);
      this.checking.delete(workspaceId);
    })();
    this.inFlight.add(check);
    void check.finally(() => this.inFlight.delete(check));
  }

  /** Waits for wake-ups started by new mail (tests use it too). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }

  private async pass(run: () => Promise<void>): Promise<void> {
    this.passes++;
    try {
      await run();
    } finally {
      if (--this.passes === 0) this.lastSend.clear();
    }
  }

  private async dueIn(
    workspace: { id: string; slug: string },
    store: WorkspaceStore,
  ): Promise<Due[]> {
    // A workspace that can't be read is skipped, not the whole sweep.
    try {
      const seen = this.finished;
      // A host WAKE_UP_HOSTS stops isn't tried: its mail and retries wait for it to be allowed again.
      const found = (await store.dueWakeUps(this.clock(), this.opts.perHour)).filter((w) =>
        this.allowed(w.host),
      );
      const key = found.length > 0 ? await this.keys.get(workspace.id) : undefined;
      return found.map((w) => ({
        workspace: workspace.slug,
        workspaceId: workspace.id,
        key,
        store,
        w,
        seen,
      }));
    } catch (err) {
      log.error('wake-ups skipped', { workspace: workspace.slug, error: String(err) });
      return [];
    }
  }

  private async dispatch(due: Due[]): Promise<void> {
    const next = due.values();
    const worker = async () => {
      for (const { workspace, workspaceId, key, store, w, seen } of next) {
        const mailbox = `${workspaceId}/${w.connectionId}/${w.handle}`;
        const last = this.lastSend.get(mailbox);
        if (last && (last.finished === undefined || last.finished > seen)) continue;
        const sending: { finished?: number } = {};
        this.lastSend.set(mailbox, sending);
        const fields = { workspace, mailbox: `${w.connectionSlug}/${w.handle}`, host: w.host };
        try {
          const outcome = await this.send(key, workspaceId, store, w, w.kind);
          if (!outcome.ok) log.warn('wake-up failed', { ...fields, status: outcome.status });
        } catch (err) {
          log.error('wake-up failed', { ...fields, error: String(err) });
        } finally {
          sending.finished = ++this.finished;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }
}

interface Due {
  workspace: string;
  workspaceId: string;
  key: Buffer | undefined;
  store: WorkspaceStore;
  w: DueWakeUp;
  /** How many sends had finished when it was found due. */
  seen: number;
}
