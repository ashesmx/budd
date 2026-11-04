import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadConfig, parseDuration } from '../src/config.js';

const hostedEnv = {
  BUDD_MODE: 'hosted',
  HOST: '0.0.0.0',
  PUBLIC_URL: 'https://budd.corp.test',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  OPEN_SIGNUP: 'true',
};

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['1d', 86_400_000],
    ['1y', 365 * 86_400_000],
  ])('%s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', '1', 'd', '1.5d', '-1d', '1 day'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(/invalid duration/);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST'])(
    '%s is loopback',
    (h) => {
      expect(isLoopbackHost(h)).toBe(true);
    },
  );
  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com', 'localhost.evil.com'])(
    '%s is not',
    (h) => {
      expect(isLoopbackHost(h)).toBe(false);
    },
  );
});

describe('loadConfig', () => {
  it('defaults to local mode with the spec defaults', () => {
    const c = loadConfig({});
    expect(c.mode).toBe('local');
    expect(c.host).toBe('127.0.0.1');
    expect(c.ttl).toMatchObject({
      deliveryMs: 86_400_000,
      maxDeliveryMs: 7 * 86_400_000,
      retentionMs: 30 * 86_400_000,
      auditMs: 365 * 86_400_000,
    });
    expect(c.limits).toEqual({
      sendRatePerMin: 5,
      senderMaxOutstanding: 100,
      recipientMaxUnread: 100,
      inboxMaxLimit: 50,
      maxHandlesPerConnection: 25,
      maxMessageBytes: 32 * 1024,
      maxConnectionsPerWorkspace: 50,
      maxWorkspaceBytes: 100 * 1024 * 1024,
      maxAuditBytes: 500 * 1024 * 1024,
      rotateAudit: false,
      ipRatePerMin: 120,
      mcpRatePerMin: 120,
      uiRatePerMin: 300,
    });
    expect(c.keyIdleExpiryMs).toBe(30 * 86_400_000);
    expect(c.hosted).toBeUndefined();
  });

  it('refuses a non-loopback bind in local mode', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/loopback/);
  });

  it('requires hosted-mode settings in hosted mode', () => {
    expect(() => loadConfig({ BUDD_MODE: 'hosted' })).toThrow(
      /PUBLIC_URL[\s\S]*GOOGLE_CLIENT_ID[\s\S]*GOOGLE_CLIENT_SECRET/,
    );
  });

  it('validates PUBLIC_URL and OIDC_ISSUER in hosted mode', () => {
    expect(() => loadConfig({ ...hostedEnv, PUBLIC_URL: 'http://budd.corp.test' })).toThrow(
      /PUBLIC_URL: must be https/,
    );
    expect(() => loadConfig({ ...hostedEnv, PUBLIC_URL: 'https://budd.corp.test/x' })).toThrow(
      /PUBLIC_URL: must be just scheme, host and port/,
    );
    expect(() => loadConfig({ ...hostedEnv, OIDC_ISSUER: 'http://idp.example.com' })).toThrow(
      /OIDC_ISSUER: must be an https URL/,
    );
    expect(() => loadConfig({ ...hostedEnv, OIDC_ISSUER: 'node:internal/x' })).toThrow(
      /OIDC_ISSUER/,
    );
    const local = loadConfig({
      ...hostedEnv,
      PUBLIC_URL: 'http://localhost:8787/',
      OIDC_ISSUER: 'http://127.0.0.1:9000',
    });
    expect(local.hosted?.publicUrl).toBe('http://localhost:8787');
  });

  it('refuses the placeholder PUBLIC_URL from .env.example', () => {
    expect(() => loadConfig({ ...hostedEnv, PUBLIC_URL: 'https://budd.example.com' })).toThrow(
      /PUBLIC_URL: is still the placeholder/,
    );
  });

  it('refuses the placeholder credentials from .env.example', () => {
    expect(() =>
      loadConfig({ ...hostedEnv, GOOGLE_CLIENT_ID: 'replace-me.apps.googleusercontent.com' }),
    ).toThrow(/GOOGLE_CLIENT_ID: is still the placeholder/);
    expect(() => loadConfig({ ...hostedEnv, GOOGLE_CLIENT_SECRET: 'replace-me' })).toThrow(
      /GOOGLE_CLIENT_SECRET: is still the placeholder/,
    );
  });

  it('accepts OIDC_CLIENT_ID / OIDC_CLIENT_SECRET for a non-Google provider', () => {
    const c = loadConfig({
      BUDD_MODE: 'hosted',
      PUBLIC_URL: 'https://budd.corp.test',
      OIDC_ISSUER: 'https://login.example.com',
      ALLOWED_EMAILS: '@corp.test',
      OIDC_CLIENT_ID: 'oid',
      OIDC_CLIENT_SECRET: 'osecret',
    });
    expect(c.hosted).toMatchObject({ oidcClientId: 'oid', oidcClientSecret: 'osecret' });
  });

  it('allows a non-loopback bind in hosted mode and parses ALLOWED_HD and ALLOWED_EMAILS', () => {
    const c = loadConfig({
      ...hostedEnv,
      OPEN_SIGNUP: undefined,
      ALLOWED_HD: 'Example.com, other.org ,',
      ALLOWED_EMAILS: 'Bob@Example.net, @example.org',
    });
    expect(c.hosted?.allowedHd).toEqual(['example.com', 'other.org']);
    expect(c.hosted?.allowedEmails).toEqual(['bob@example.net', '@example.org']);
    expect(c.hosted?.oidcIssuer).toBe('https://accounts.google.com');
  });

  it('won’t start hosted until it’s decided who may sign in', () => {
    const undecided = { ...hostedEnv, OPEN_SIGNUP: undefined };
    expect(() => loadConfig(undecided)).toThrow(
      /ALLOWED_EMAILS: not set: hosted mode needs to know who may sign in/,
    );
    expect(loadConfig({ ...undecided, ALLOWED_EMAILS: '@example.org' }).hosted).toBeDefined();
    expect(loadConfig({ ...undecided, OPEN_SIGNUP: 'true' }).hosted?.allowedEmails).toEqual([]);
    expect(() => loadConfig({ ...hostedEnv, ALLOWED_HD: 'example.com' })).toThrow(
      /OPEN_SIGNUP: is true, so ALLOWED_HD and ALLOWED_EMAILS would do nothing/,
    );
    expect(() => loadConfig({ ...undecided, ALLOWED_EMAILS: 'example.org' })).toThrow(
      /ALLOWED_EMAILS: must be email addresses or @domains/,
    );
    expect(() => loadConfig({ ...undecided, ALLOWED_EMAILS: '*@example.org' })).toThrow(
      /ALLOWED_EMAILS: must be email addresses or @domains/,
    );
    expect(() =>
      loadConfig({
        ...undecided,
        ALLOWED_HD: 'example.com',
        OIDC_ISSUER: 'https://login.example.com',
      }),
    ).toThrow(/ALLOWED_HD: works only with Google/);
    expect(loadConfig({ ...undecided, ALLOWED_HD: 'example.com' }).hosted?.google).toBe(true);
    // Local mode has no sign-up to decide.
    expect(loadConfig({}).mode).toBe('local');
  });

  it('needs keys to last at least 2h unused (their use is recorded hourly)', () => {
    expect(() => loadConfig({ KEY_IDLE_EXPIRY: '1h' })).toThrow(/KEY_IDLE_EXPIRY.*at least 2h/);
    expect(loadConfig({ KEY_IDLE_EXPIRY: '2h' }).keyIdleExpiryMs).toBe(7_200_000);
  });

  it('reads AUDIT_ROTATE as true or false only', () => {
    expect(loadConfig({ AUDIT_ROTATE: 'true' }).limits.rotateAudit).toBe(true);
    expect(() => loadConfig({ AUDIT_ROTATE: 'yes' })).toThrow(
      /AUDIT_ROTATE: must be true or false/,
    );
  });

  it('rejects inconsistent TTLs', () => {
    expect(() => loadConfig({ DELIVERY_TTL: '8d' })).toThrow(/DELIVERY_TTL/);
    expect(() => loadConfig({ MAX_DELIVERY_TTL: '60d' })).toThrow(/RETENTION_TTL/);
  });

  it('rejects bad values with a ConfigError listing each problem', () => {
    try {
      loadConfig({ BUDD_MODE: 'cloud', PORT: '70000', INBOX_MAX_LIMIT: '-3' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/BUDD_MODE[\s\S]*PORT[\s\S]*INBOX_MAX_LIMIT/);
    }
  });
});
