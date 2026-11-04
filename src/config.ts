import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { describeSettings, type SettingView } from './settings.js';

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  y: 365 * 86_400_000,
} as const;

/** Parses durations like `90s`, `15m`, `1d`, `1y` into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)$/.exec(input.trim());
  if (!match) {
    throw new Error(`invalid duration "${input}" (expected e.g. 30s, 15m, 1d, 1y)`);
  }
  const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_MS];
  return Number(amount) * UNIT_MS[unit];
}

/** The largest unit `ms` is a whole number of (weeks excepted: "7d" reads better than "1w"). */
function exactUnit(ms: number): [keyof typeof UNIT_MS, number] {
  const units = (Object.entries(UNIT_MS) as [keyof typeof UNIT_MS, number][])
    .filter(([unit]) => unit !== 'w')
    .reverse();
  const [unit, size] = units.find(([, size]) => ms % size === 0) ?? ['ms', 1];
  return [unit, ms / size];
}

/** Formats milliseconds in the largest exact unit, e.g. 86400000 → `1d`. Inverse of parseDuration. */
export function formatDuration(ms: number): string {
  const [unit, amount] = exactUnit(ms);
  return `${String(amount)}${unit}`;
}

const UNIT_WORDS: Record<keyof typeof UNIT_MS, string> = {
  ms: 'millisecond',
  s: 'second',
  m: 'minute',
  h: 'hour',
  d: 'day',
  w: 'week',
  y: 'year',
};

/** formatDuration for people: 2592000000 → `30 days`. */
export function durationInWords(ms: number): string {
  const [unit, amount] = exactUnit(ms);
  return `${amount.toLocaleString('en')} ${UNIT_WORDS[unit]}${amount === 1 ? '' : 's'}`;
}

/** True for 127.0.0.0/8, ::1 and `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}

const duration = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      try {
        const ms = parseDuration(value);
        if (ms <= 0) throw new Error(`duration "${value}" must be positive`);
        return ms;
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    });

const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * Only Google vouches for `hd`. A provider on plain http can only be on this
 * machine (see OIDC_ISSUER), as a test stand-in for Google.
 */
const isGoogle = (issuer: string) => issuer === GOOGLE_ISSUER || issuer.startsWith('http:');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const flag = z
  .enum(['true', 'false'], { message: 'must be true or false' })
  .default('false')
  .transform((v) => v === 'true');

/** The platforms the wake-up guide covers: Claude Code routines, Grok Bot and Multica's cloud. */
const DEFAULT_WAKE_UP_HOSTS = ['api.anthropic.com', 'api2.cursor.sh', 'grok.com', 'multica.ai'];

const secretKey = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (openssl rand -hex 32)')
  .optional();
const hexKey = (hex: string | undefined) =>
  hex === undefined ? undefined : Buffer.from(hex, 'hex');

/** Host names as URL.host gives them (lower case, punycode); empty means the default. */
const wakeUpHosts = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const hosts = (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== '');
    for (const h of hosts) {
      const host = URL.canParse(`https://${h}`) ? new URL(`https://${h}`).host : undefined;
      if (h !== '*' && (host !== h || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h))) {
        ctx.addIssue({
          code: 'custom',
          message: `"${h}" isn't a host name: list names only, like multica.ai (or * for any)`,
        });
      }
    }
    return hosts.length > 0 ? hosts : DEFAULT_WAKE_UP_HOSTS;
  });

const commaList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

export const envSchema = z
  .object({
    BUDD_MODE: z.enum(['local', 'hosted']).default('local'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8787), // 0 = ephemeral (tests)
    DATA_DIR: z.string().min(1).default('./data'),

    DELIVERY_TTL: duration('1d'),
    MAX_DELIVERY_TTL: duration('7d'),
    RETENTION_TTL: duration('30d'),
    AUDIT_TTL: duration('1y'),
    SWEEP_INTERVAL: duration('1m'),

    SEND_RATE_PER_MIN: positiveInt(5),
    SENDER_MAX_OUTSTANDING: positiveInt(100),
    RECIPIENT_MAX_UNREAD: positiveInt(100),
    INBOX_MAX_LIMIT: positiveInt(50),
    MAX_HANDLES_PER_CONNECTION: positiveInt(25),
    MAX_MESSAGE_BYTES: positiveInt(32 * 1024),
    MAX_CONNECTIONS_PER_WORKSPACE: positiveInt(50),
    MAX_WORKSPACE_MB: positiveInt(100),
    MAX_AUDIT_MB: positiveInt(500),
    AUDIT_ROTATE: flag,
    // Wake-ups (ADR 0019): off stops all of them and hides their setup.
    WAKE_UPS: z
      .enum(['on', 'off', 'true', 'false'], { message: 'must be on or off' })
      .default('on'),
    WAKE_UPS_PER_HOUR: positiveInt(30),
    // The only hosts wake-ups may go to; * for any public host.
    WAKE_UP_HOSTS: wakeUpHosts,
    // Locks each workspace's key, so the data directory or a backup alone reveals no wake-up secrets.
    BUDD_SECRET_KEY: secretKey,
    // Opens keys locked with the old BUDD_SECRET_KEY while rotating to a new one.
    BUDD_SECRET_KEY_PREVIOUS: secretKey,
    IP_RATE_PER_MIN: positiveInt(120),
    MCP_RATE_PER_MIN: positiveInt(120),
    UI_RATE_PER_MIN: positiveInt(300),
    // A key's use is recorded at most hourly, so a key in use must outlast an
    // hour unrecorded: at 1h it could expire while an agent polls every minute.
    KEY_IDLE_EXPIRY: duration('30d').refine(
      (ms) => ms >= 2 * 60 * 60 * 1000,
      'must be at least 2h',
    ),

    // Hosted mode only.
    PUBLIC_URL: z.url().optional(),
    // Sign-in for humans: Google by default; any OpenID Connect provider via
    // OIDC_ISSUER plus OIDC_CLIENT_ID / OIDC_CLIENT_SECRET (ADR 0009).
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_ISSUER: z.url().default(GOOGLE_ISSUER),
    // Who may sign in (ADR 0021): hosted mode refuses to start until this is decided.
    ALLOWED_HD: commaList,
    ALLOWED_EMAILS: commaList.refine(
      (list) => list.every((e) => /^[^@\s*]*@[^@\s*]+\.[^@\s*]+$/.test(e)),
      'must be email addresses or @domains, e.g. bob@example.com,@example.org',
    ),
    OPEN_SIGNUP: flag,
    // Behind a proxy or tunnel: the header holding the real client address.
    CLIENT_IP_HEADER: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        (v) => v === '' || /^[a-z0-9-]+$/.test(v),
        'must be a header name, e.g. cf-connecting-ip or x-forwarded-for',
      )
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.BUDD_SECRET_KEY_PREVIOUS !== undefined && env.BUDD_SECRET_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['BUDD_SECRET_KEY_PREVIOUS'],
        message: 'is only for changing BUDD_SECRET_KEY: set the new one as BUDD_SECRET_KEY too',
      });
    }
    if (env.DELIVERY_TTL > env.MAX_DELIVERY_TTL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DELIVERY_TTL'],
        message: 'must not exceed MAX_DELIVERY_TTL',
      });
    }
    if (env.MAX_DELIVERY_TTL > env.RETENTION_TTL) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_DELIVERY_TTL'],
        message: 'must not exceed RETENTION_TTL (messages would be purged before they expire)',
      });
    }
    if (env.BUDD_MODE === 'local' && !isLoopbackHost(env.HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['HOST'],
        message: `local mode must bind to a loopback address (127.0.0.1, ::1 or localhost), got "${env.HOST}"`,
      });
    }
    if (env.BUDD_MODE === 'hosted') {
      if (!env.PUBLIC_URL) {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'required in hosted mode' });
      } else {
        const url = new URL(env.PUBLIC_URL);
        if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
          ctx.addIssue({
            code: 'custom',
            path: ['PUBLIC_URL'],
            message: 'must be https (http is only allowed for localhost testing)',
          });
        }
        // example.com/.org/.net are reserved (RFC 2606): never a real deployment.
        if (/(^|\.)example\.(com|org|net)$/.test(url.hostname)) {
          ctx.addIssue({
            code: 'custom',
            path: ['PUBLIC_URL'],
            message: `is still the placeholder (${url.hostname}): set it to the URL people will use to reach Budd (https, or http://localhost for testing)`,
          });
        }
        if (url.pathname !== '/' || url.search || url.hash) {
          ctx.addIssue({
            code: 'custom',
            path: ['PUBLIC_URL'],
            message: 'must be just scheme, host and port, e.g. https://budd.example.com',
          });
        }
      }
      const issuer = URL.parse(env.OIDC_ISSUER);
      if (
        !issuer ||
        !(
          issuer.protocol === 'https:' ||
          (issuer.protocol === 'http:' && isLoopbackHost(issuer.hostname))
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['OIDC_ISSUER'],
          message: 'must be an https URL (http is only allowed for localhost testing)',
        });
      }
      for (const key of [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'OIDC_CLIENT_ID',
        'OIDC_CLIENT_SECRET',
      ] as const) {
        if (env[key]?.includes('replace-me')) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'is still the placeholder from .env.example: set it to your OAuth client’s value',
          });
        }
      }
      const restricted = env.ALLOWED_HD.length > 0 || env.ALLOWED_EMAILS.length > 0;
      if (!restricted && !env.OPEN_SIGNUP) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOWED_EMAILS'],
          message:
            'not set: hosted mode needs to know who may sign in. Set ALLOWED_EMAILS (addresses or @domains, any provider), ALLOWED_HD (Google Workspace domains), or OPEN_SIGNUP=true to give everyone your provider accepts a workspace',
        });
      }
      if (env.ALLOWED_HD.length > 0 && !isGoogle(env.OIDC_ISSUER)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOWED_HD'],
          message:
            'works only with Google, which vouches for the hd claim: use ALLOWED_EMAILS with other providers',
        });
      }
      if (restricted && env.OPEN_SIGNUP) {
        ctx.addIssue({
          code: 'custom',
          path: ['OPEN_SIGNUP'],
          message:
            'is true, so ALLOWED_HD and ALLOWED_EMAILS would do nothing: remove one or the other',
        });
      }
      for (const [key, alt] of [
        ['GOOGLE_CLIENT_ID', 'OIDC_CLIENT_ID'],
        ['GOOGLE_CLIENT_SECRET', 'OIDC_CLIENT_SECRET'],
      ] as const) {
        if (!env[key] && !env[alt]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `required in hosted mode (or set ${alt} for a non-Google identity provider)`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
/** Every variable the configuration reads. */
export type EnvKey = keyof z.input<typeof envSchema>;

export interface Config {
  mode: 'local' | 'hosted';
  host: string;
  port: number;
  dataDir: string;
  ttl: {
    deliveryMs: number;
    maxDeliveryMs: number;
    retentionMs: number;
    auditMs: number;
    sweepIntervalMs: number;
  };
  limits: {
    sendRatePerMin: number;
    senderMaxOutstanding: number;
    recipientMaxUnread: number;
    inboxMaxLimit: number;
    maxHandlesPerConnection: number;
    maxMessageBytes: number;
    /** Connections a workspace may have, not counting archived ones. */
    maxConnectionsPerWorkspace: number;
    /** Bytes of messages a workspace may store before sends are refused. */
    maxWorkspaceBytes: number;
    /** Bytes of audit entries a workspace may keep. */
    maxAuditBytes: number;
    /** At maxAuditBytes, delete the oldest entries instead of refusing agents. */
    rotateAudit: boolean;
    /** Hosted mode: requests per minute from one address to the public endpoints. */
    ipRatePerMin: number;
    /** MCP requests per minute per connection, shared by its handles. */
    mcpRatePerMin: number;
    /** UI requests per minute per browser session. */
    uiRatePerMin: number;
  };
  /** Hosted mode: an API key stops working after this long unused. */
  keyIdleExpiryMs: number;
  /** Whether Budd sends wake-ups (WAKE_UPS). Saved ones are kept either way. */
  wakeUps: boolean;
  /** The most wake-ups one mailbox gets in an hour (WAKE_UPS_PER_HOUR), tests aside. */
  wakeUpsPerHour: number;
  /** The hosts wake-ups may go to (WAKE_UP_HOSTS); ['*'] for any public host. */
  wakeUpHosts: string[];
  /** BUDD_SECRET_KEY (current) and BUDD_SECRET_KEY_PREVIOUS: lock workspace keys. */
  secretKey: { current: Buffer | undefined; previous: Buffer | undefined };
  /** Every setting and its value, secrets reduced to set or not set, for the operator console. */
  settings: SettingView[];
  hosted?: {
    /** Origin only, no trailing slash, e.g. https://budd.example.com */
    publicUrl: string;
    oidcClientId: string;
    oidcClientSecret: string;
    oidcIssuer: string;
    /** Google Workspace domains that may sign in (the `hd` claim). */
    allowedHd: string[];
    /** Verified emails or @domains that may sign in, with any provider. */
    allowedEmails: string[];
    /** Signing in with Google, which vouches for the `hd` claim. */
    google: boolean;
    clientIpHeader: string | undefined;
  };
}

/** Where Budd listens, as a URL: an IPv6 host goes in brackets. */
export function localBaseUrl(config: Config, port = config.port): string {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `http://${host}:${String(port)}`;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new ConfigError(`Invalid Budd configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  const config: Omit<Config, 'settings'> = {
    mode: env.BUDD_MODE,
    host: env.HOST,
    port: env.PORT,
    dataDir: path.resolve(env.DATA_DIR),
    ttl: {
      deliveryMs: env.DELIVERY_TTL,
      maxDeliveryMs: env.MAX_DELIVERY_TTL,
      retentionMs: env.RETENTION_TTL,
      auditMs: env.AUDIT_TTL,
      sweepIntervalMs: env.SWEEP_INTERVAL,
    },
    limits: {
      sendRatePerMin: env.SEND_RATE_PER_MIN,
      senderMaxOutstanding: env.SENDER_MAX_OUTSTANDING,
      recipientMaxUnread: env.RECIPIENT_MAX_UNREAD,
      inboxMaxLimit: env.INBOX_MAX_LIMIT,
      maxHandlesPerConnection: env.MAX_HANDLES_PER_CONNECTION,
      maxMessageBytes: env.MAX_MESSAGE_BYTES,
      maxConnectionsPerWorkspace: env.MAX_CONNECTIONS_PER_WORKSPACE,
      maxWorkspaceBytes: env.MAX_WORKSPACE_MB * 1024 * 1024,
      maxAuditBytes: env.MAX_AUDIT_MB * 1024 * 1024,
      rotateAudit: env.AUDIT_ROTATE,
      ipRatePerMin: env.IP_RATE_PER_MIN,
      mcpRatePerMin: env.MCP_RATE_PER_MIN,
      uiRatePerMin: env.UI_RATE_PER_MIN,
    },
    keyIdleExpiryMs: env.KEY_IDLE_EXPIRY,
    wakeUps: env.WAKE_UPS === 'on' || env.WAKE_UPS === 'true',
    wakeUpsPerHour: env.WAKE_UPS_PER_HOUR,
    wakeUpHosts: env.WAKE_UP_HOSTS,
    secretKey: {
      current: hexKey(env.BUDD_SECRET_KEY),
      previous: hexKey(env.BUDD_SECRET_KEY_PREVIOUS),
    },
    ...(env.BUDD_MODE === 'hosted' && {
      hosted: {
        publicUrl: new URL(env.PUBLIC_URL ?? 'http://localhost').origin,
        oidcClientId: env.OIDC_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? '',
        oidcClientSecret: env.OIDC_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? '',
        oidcIssuer: env.OIDC_ISSUER,
        allowedHd: env.ALLOWED_HD,
        allowedEmails: env.ALLOWED_EMAILS,
        google: isGoogle(env.OIDC_ISSUER),
        clientIpHeader: env.CLIENT_IP_HEADER || undefined,
      },
    }),
  };
  return { ...config, settings: describeSettings(source, config) };
}
