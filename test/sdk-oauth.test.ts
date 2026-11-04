import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Browser, CALLBACK, field, startHostedBudd, type HostedBudd } from './helpers/hosted.js';

let budd: HostedBudd;
beforeEach(async () => {
  budd = await startHostedBudd();
});
afterEach(async () => {
  await budd.close();
});

/**
 * The MCP SDK's client-side OAuth, as used by the MCP Inspector, mcp-remote
 * and other SDK-based clients. Only "the browser" is simulated.
 */
class TestProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;

  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MCP Inspector',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

it('completes the MCP SDK client OAuth flow end to end (what the MCP Inspector does)', async () => {
  const provider = new TestProvider();
  const url = new URL(`${budd.url}/mcp`);

  // 1. Unauthenticated connect: the SDK discovers metadata from the 401,
  //    registers dynamically, and sends the user to /authorize.
  const first = new Client({ name: 'inspector', version: '0' });
  await expect(
    first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider })),
  ).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.info?.client_id).toMatch(/^budd_client_/);
  const authUrl = provider.authorizationUrl;
  expect(authUrl?.origin).toBe(budd.url);
  expect(authUrl?.searchParams.get('resource')).toBe(`${budd.url}/mcp`);

  // 2. The human signs in and approves in the browser.
  const browser = new Browser(budd);
  budd.idp.user = { sub: 'insp', email: 'inspector@example.com' };
  const landing = await browser.go(authUrl?.toString() ?? '');
  const consent = await browser.post('/login', [['return', field(landing.body, 'return')]]);
  expect(consent.body).toContain('MCP Inspector');
  const back = await browser.post('/authorize', [
    ['_csrf', field(consent.body, '_csrf')],
    ['nonce', field(consent.body, 'nonce')],
    ['workspace', field(consent.body, 'workspace')],
    ['decision', 'approve'],
  ]);
  const code = new URL(back.url).searchParams.get('code') ?? '';

  // 3. The SDK exchanges the code and reconnects with the token.
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await transport.finishAuth(code);
  expect(provider.saved?.access_token).toMatch(/^budd_at_/);
  const client = new Client({ name: 'inspector', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain('whoami');
  const res = (await client.callTool({ name: 'whoami', arguments: {} })) as {
    content: { text: string }[];
  };
  expect(JSON.parse(res.content[0]?.text ?? '{}')).toMatchObject({
    workspace: 'inspector',
    connection: 'mcp-inspector',
    mode: 'hosted',
  });
  await client.close();
});
