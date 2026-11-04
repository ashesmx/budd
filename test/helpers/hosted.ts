import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestBudd, type TestBudd, type ToolResult } from './harness.js';
import { startMockIdp, type IdpUser, type MockIdp } from './mockIdp.js';

export const CALLBACK = 'http://127.0.0.1:1/callback'; // never actually fetched

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

export interface HostedBudd extends TestBudd {
  idp: MockIdp;
}

/** Budd in hosted mode, signing humans in through a mock OpenID Connect provider. */
export async function startHostedBudd(env: Record<string, string> = {}): Promise<HostedBudd> {
  const clock = { now: Date.parse('2026-10-15T12:00:00Z') };
  const idp = await startMockIdp(clock);
  const port = await freePort();
  const budd = await startTestBudd(
    {
      BUDD_MODE: 'hosted',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${String(port)}`,
      OIDC_ISSUER: idp.issuer,
      GOOGLE_CLIENT_ID: idp.clientId,
      GOOGLE_CLIENT_SECRET: idp.clientSecret,
      ...(!env.ALLOWED_HD && !env.ALLOWED_EMAILS && { OPEN_SIGNUP: 'true' }),
      ...env,
    },
    clock,
  );
  const close = budd.close.bind(budd);
  return Object.assign(budd, {
    idp,
    async close() {
      await close();
      await idp.close();
    },
  });
}

export const unescapeHtml = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, e: 'amp' | 'lt' | 'gt' | 'quot' | '#39') =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e],
  );

/** Where a meta-refresh "continue" page sends the browser, and where its link goes. */
export function continueTarget(html: string): { refresh?: string; link?: string } {
  const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)?.[1];
  const link = /<a href="([^"]+)">/.exec(html)?.[1];
  return {
    ...(refresh !== undefined && { refresh: unescapeHtml(refresh) }),
    ...(link !== undefined && { link: unescapeHtml(link) }),
  };
}

/** Where a page's "Return to the app" link goes. */
export const returnLink = (html: string) =>
  unescapeHtml(/<a class="btn" href="([^"]+)">Return to the app<\/a>/.exec(html)?.[1] ?? '');

export interface Page {
  url: string;
  status: number;
  body: string;
  headers: Headers;
}

/**
 * A browser for one person: keeps Budd's cookies, follows redirects across
 * Budd and the IdP, and follows Budd's meta-refresh "continue" pages. Stops
 * when it is sent to an MCP client's redirect URI.
 */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly budd: HostedBudd) {}

  private cookieHeader(url: string): Record<string, string> {
    if (!url.startsWith(this.budd.url) || this.cookies.size === 0) return {};
    return { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  }

  private remember(url: string, res: Response): void {
    if (!url.startsWith(this.budd.url)) return;
    for (const c of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (attrs.some((a) => /max-age=0/i.test(a)) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** `stopAtContinue` returns a "continue" page itself instead of following it. */
  async go(start: string, init: RequestInit = {}, { stopAtContinue = false } = {}): Promise<Page> {
    let url = start.startsWith('http') ? start : this.budd.url + start;
    let request = init;
    for (let hops = 0; hops < 20; hops++) {
      if (url.startsWith(CALLBACK) || !url.startsWith('http')) {
        return { url, status: 0, body: '', headers: new Headers() };
      }
      const res = await fetch(url, {
        ...request,
        redirect: 'manual',
        headers: { ...(request.headers as Record<string, string>), ...this.cookieHeader(url) },
      });
      this.remember(url, res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        request = {};
        continue;
      }
      const body = await res.text();
      const { refresh } = continueTarget(body);
      if (refresh !== undefined && !stopAtContinue) {
        url = new URL(refresh, url).toString();
        request = {};
        continue;
      }
      return { url, status: res.status, body, headers: res.headers };
    }
    throw new Error('too many redirects');
  }

  /** Submits a form (urlencoded) and follows the response like a browser. */
  post(
    path: string,
    fields: [string, string][],
    opts: { stopAtContinue?: boolean } = {},
  ): Promise<Page> {
    return this.go(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: this.budd.url,
        },
        body: new URLSearchParams(fields).toString(),
      },
      opts,
    );
  }

  async signIn(user: IdpUser): Promise<Page> {
    this.budd.idp.user = user;
    return this.post('/login', [['return', '/ui']]);
  }
}

export const field = (html: string, name: string): string => {
  const m = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!m?.[1]) throw new Error(`no ${name} field in page`);
  return unescapeHtml(m[1]);
};

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
}

export async function register(
  budd: HostedBudd,
  metadata: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${budd.url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      ...metadata,
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const authorizeUrl = (
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
) =>
  `/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  }).toString()}`;

/** Answers a consent page, stopping at the page that returns to the client. */
export const decide = (browser: Browser, consentPage: Page, decision: 'approve' | 'deny') =>
  browser.post(
    '/authorize',
    [
      ['_csrf', field(consentPage.body, '_csrf')],
      ['nonce', field(consentPage.body, 'nonce')],
      ['workspace', field(consentPage.body, 'workspace')],
      ['decision', decision],
    ],
    { stopAtContinue: true },
  );

/** Runs the consent step (browser must be signed in); returns where Budd sends the browser back. */
export async function consent(
  browser: Browser,
  clientId: string,
  challenge: string,
  decision: 'approve' | 'deny' = 'approve',
): Promise<URL> {
  const page = await browser.go(authorizeUrl(clientId, challenge));
  if (page.status !== 200) throw new Error(`consent page: ${String(page.status)} ${page.body}`);
  const back = await decide(browser, page, decision);
  const to = continueTarget(back.body).refresh;
  if (to === undefined) throw new Error(`no return page: ${String(back.status)} ${back.body}`);
  return new URL(to);
}

export async function token(
  budd: HostedBudd,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${budd.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: await res.json() };
}

/** Full flow for a signed-in browser: register a client, consent, exchange the code. */
export async function connectClient(
  budd: HostedBudd,
  browser: Browser,
  name = 'Claude',
): Promise<{ clientId: string; access: string; refresh: string }> {
  const { body: client } = await register(budd, { client_name: name });
  const { verifier, challenge } = pkce();
  const back = await consent(browser, client.client_id, challenge);
  const code = back.searchParams.get('code') ?? '';
  const t = await token(budd, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
    client_id: client.client_id,
  });
  if (t.status !== 200) throw new Error(`token: ${JSON.stringify(t.body)}`);
  return { clientId: client.client_id, access: t.body.access_token, refresh: t.body.refresh_token };
}

/** An MCP client using a bearer token, like an AI app after OAuth. */
export async function mcpAs(budd: HostedBudd, accessToken: string) {
  const client = new Client({ name: 'hosted-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${budd.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const res = (await client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = res.content.map((c) => c.text).join('\n');
    return {
      isError: res.isError === true,
      text,
      data: res.isError ? undefined : JSON.parse(text),
    };
  };
  return {
    call,
    ok: async (tool: string, args?: Record<string, unknown>) => {
      const r = await call(tool, args);
      if (r.isError) throw new Error(`${tool}: ${r.text}`);
      return r.data;
    },
    close: () => client.close(),
  };
}

/** A raw MCP request with a bearer token; returns the HTTP status and headers. */
export async function rawMcp(budd: HostedBudd, accessToken?: string) {
  return fetch(`${budd.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  });
}
