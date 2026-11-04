import type { Config, EnvKey } from './config.js';

export const SETTING_GROUPS = [
  'Instance',
  'Sign-in',
  'Secrets',
  'Wake-ups',
  'Limits',
  'Rate limits',
  'Keeping data',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export interface SettingInfo {
  group: SettingGroup;
  description: string;
  /** As written in .env, as operating.md's table gives it. */
  default?: string;
  /** Shown only as set or not set. */
  secret?: true;
  /** Decides who can get in, or what can leave the server: check it first after editing .env. */
  security?: true;
  /** Hosted mode only: the console hides it in local mode. */
  hosted?: true;
  /** Shown in place of the value, which would say too much. */
  summarise?: (value: string) => string;
  /** Advice where it's more than keeping the default, and when the value goes against it. */
  recommended?: { advice: string; differs?: (config: Omit<Config, 'settings'>) => boolean };
}

/**
 * What each setting does, for the operator console. Keyed by every variable
 * the configuration reads, so a new one can't be added without saying what
 * it is. A test checks the defaults against the schema and operating.md.
 */
export const SETTINGS: Record<EnvKey, SettingInfo> = {
  BUDD_MODE: {
    group: 'Instance',
    default: 'local',
    description:
      'Hosted: people sign in with an identity provider and each gets a workspace. Local: one login, on this machine.',
  },
  HOST: {
    group: 'Instance',
    security: true,
    default: '127.0.0.1',
    description: 'The address Budd listens on.',
  },
  PORT: { group: 'Instance', default: '8787', description: 'The port Budd listens on.' },
  DATA_DIR: { group: 'Instance', default: './data', description: 'Where the databases live.' },
  PUBLIC_URL: {
    group: 'Instance',
    security: true,
    hosted: true,
    description: 'The address people and AI apps use to reach Budd.',
  },
  CLIENT_IP_HEADER: {
    group: 'Instance',
    security: true,
    hosted: true,
    description:
      'The header your proxy or tunnel puts the client’s address in, so rate limits apply per client.',
    recommended: { advice: 'set it whenever Budd is behind a proxy or tunnel' },
  },

  GOOGLE_CLIENT_ID: {
    group: 'Sign-in',
    hosted: true,
    description: 'The Google OAuth client people sign in with.',
  },
  GOOGLE_CLIENT_SECRET: {
    group: 'Sign-in',
    hosted: true,
    secret: true,
    description: 'That client’s secret.',
  },
  OIDC_ISSUER: {
    group: 'Sign-in',
    security: true,
    hosted: true,
    default: 'https://accounts.google.com',
    description: 'The sign-in provider.',
  },
  OIDC_CLIENT_ID: {
    group: 'Sign-in',
    hosted: true,
    description: 'The OAuth client, with a provider other than Google.',
  },
  OIDC_CLIENT_SECRET: {
    group: 'Sign-in',
    hosted: true,
    secret: true,
    description: 'That client’s secret.',
  },
  ALLOWED_EMAILS: {
    group: 'Sign-in',
    security: true,
    hosted: true,
    description: 'Who may sign in: email addresses, or @domains.',
    summarise: (value) => {
      const entries = value.split(',').filter((e) => e.trim() !== '');
      const domains = entries.filter((e) => e.trim().startsWith('@')).length;
      const count = (n: number, one: string, many: string) =>
        `${String(n)} ${n === 1 ? one : many}`;
      return `${count(entries.length - domains, 'address', 'addresses')} and ${count(domains, 'domain', 'domains')}`;
    },
  },
  ALLOWED_HD: {
    group: 'Sign-in',
    security: true,
    hosted: true,
    description: 'Who may sign in: Google Workspace domains.',
  },
  OPEN_SIGNUP: {
    group: 'Sign-in',
    security: true,
    hosted: true,
    default: 'false',
    description: 'Anyone the provider accepts may sign in, and gets a workspace.',
    recommended: { advice: 'false, unless the instance is meant for the public' },
  },

  BUDD_SECRET_KEY: {
    group: 'Secrets',
    security: true,
    secret: true,
    description:
      'Locks wake-up addresses, tokens and signing secrets, so the data directory or a backup alone can’t open them.',
    recommended: {
      advice: 'set, with a copy kept off the server',
      differs: (config) => config.secretKey.current === undefined,
    },
  },
  BUDD_SECRET_KEY_PREVIOUS: {
    group: 'Secrets',
    secret: true,
    description: 'The old key, set for one restart after changing it.',
  },

  WAKE_UPS: {
    group: 'Wake-ups',
    security: true,
    default: 'on',
    description: 'Budd tells an agent’s platform when its mailbox has mail.',
  },
  WAKE_UP_HOSTS: {
    group: 'Wake-ups',
    security: true,
    default: 'api.anthropic.com,api2.cursor.sh,grok.com,multica.ai',
    description: 'The only hosts wake-ups may go to.',
    recommended: {
      advice: 'only the platforms your people use; * lets wake-ups go to any public host',
      differs: (config) => config.wakeUpHosts.includes('*'),
    },
  },
  WAKE_UPS_PER_HOUR: {
    group: 'Wake-ups',
    default: '30',
    description: 'The most wake-ups one mailbox gets in an hour.',
  },

  MAX_WORKSPACE_MB: {
    group: 'Limits',
    default: '100',
    description:
      'Messages one workspace may store, in MB. Beyond it, sends are refused until old ones expire.',
  },
  MAX_AUDIT_MB: {
    group: 'Limits',
    default: '500',
    description:
      'Audit entries one workspace may keep, in MB. Beyond it, its agents are refused, or the oldest go (AUDIT_ROTATE).',
  },
  MAX_CONNECTIONS_PER_WORKSPACE: {
    group: 'Limits',
    default: '50',
    description: 'Connections one workspace may have. Archived ones don’t count.',
  },
  MAX_HANDLES_PER_CONNECTION: {
    group: 'Limits',
    default: '25',
    description: 'Handles one connection may have.',
  },
  MAX_MESSAGE_BYTES: {
    group: 'Limits',
    default: '32768',
    description: 'The largest message, in bytes.',
  },
  SENDER_MAX_OUTSTANDING: {
    group: 'Limits',
    default: '100',
    description: 'Unread deliveries one connection may have waiting with recipients.',
  },
  RECIPIENT_MAX_UNREAD: {
    group: 'Limits',
    default: '100',
    description: 'Unread messages one mailbox may hold.',
  },
  INBOX_MAX_LIMIT: {
    group: 'Limits',
    default: '50',
    description: 'The most messages one inbox call returns.',
  },

  SEND_RATE_PER_MIN: {
    group: 'Rate limits',
    default: '5',
    description: 'Messages one connection may send a minute.',
  },
  MCP_RATE_PER_MIN: {
    group: 'Rate limits',
    default: '120',
    description: 'MCP requests a minute per connection, shared by its handles.',
  },
  UI_RATE_PER_MIN: {
    group: 'Rate limits',
    default: '300',
    description: 'UI requests a minute per browser session.',
  },
  IP_RATE_PER_MIN: {
    group: 'Rate limits',
    hosted: true,
    default: '120',
    description: 'Requests a minute from one address to the sign-in and OAuth endpoints.',
  },

  DELIVERY_TTL: {
    group: 'Keeping data',
    default: '1d',
    description: 'How long an unread message waits before it expires.',
  },
  MAX_DELIVERY_TTL: {
    group: 'Keeping data',
    default: '7d',
    description: 'The longest a sender may ask a message to wait.',
  },
  RETENTION_TTL: {
    group: 'Keeping data',
    default: '30d',
    description: 'How long message history is kept.',
  },
  AUDIT_TTL: {
    group: 'Keeping data',
    default: '1y',
    description: 'How long audit entries are kept.',
  },
  AUDIT_ROTATE: {
    group: 'Keeping data',
    default: 'false',
    description: 'At MAX_AUDIT_MB, delete the oldest audit entries instead of refusing agents.',
    recommended: {
      advice:
        'true on an instance several people share; false if you must keep a full year of audit',
    },
  },
  KEY_IDLE_EXPIRY: {
    group: 'Keeping data',
    hosted: true,
    default: '30d',
    description: 'An API key stops working after this long unused.',
  },
  SWEEP_INTERVAL: {
    group: 'Keeping data',
    default: '1m',
    description:
      'How often expiry and purges run, and wake-ups are checked. Storage is measured on the first run each hour, so over 1h leaves gaps in the console’s history.',
  },
};

/** One setting as the console shows it. */
export interface SettingView {
  key: EnvKey;
  info: SettingInfo;
  /** What .env says, its default, or undefined if neither; a secret's is always undefined. */
  value: string | undefined;
  /** Whether the environment sets it. */
  set: boolean;
  /** Goes against the recommendation, whether set or left at the default. */
  differs: boolean;
}

/** Every setting with its value, secrets reduced to set or not set. */
export function describeSettings(
  source: Record<string, string | undefined>,
  config: Omit<Config, 'settings'>,
): SettingView[] {
  return (Object.entries(SETTINGS) as [EnvKey, SettingInfo][])
    .filter(([, info]) => config.mode === 'hosted' || !info.hosted)
    .map(([key, info]) => {
      const raw = source[key]?.trim();
      const set = raw !== undefined && raw !== '';
      return {
        key,
        info,
        value: info.secret ? undefined : set ? (info.summarise?.(raw) ?? raw) : info.default,
        set,
        differs: info.recommended?.differs?.(config) ?? false,
      };
    });
}
