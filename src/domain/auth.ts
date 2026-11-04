import type { Workspace } from './types.js';

/** The UI's colour theme: the operating system's, or one chosen in Preferences. */
export type Theme = 'system' | 'light' | 'dark';

/** Local mode: how long a `budd login` link works. */
export const LOGIN_LINK_TTL_MS = 10 * 60_000;
/** Hosted mode: how long a `budd operator` link works (ADR 0022). */
export const OPERATOR_LINK_TTL_MS = 10 * 60_000;

export interface Account {
  id: string;
  email: string | null;
  /** From the sign-in provider, refreshed at each sign-in. */
  name: string | null;
  /** An https URL from the sign-in provider, shown in the profile menu. */
  picture: string | null;
  theme: Theme;
  createdAt: number;
}

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/** An MCP client registered through Dynamic Client Registration. */
export interface OAuthClient {
  clientId: string;
  /** SHA-256 of the secret; null for public clients. */
  clientSecretHash: string | null;
  authMethod: ClientAuthMethod;
  /** Self-reported by the client: unverified. */
  clientName: string | null;
  slugBase: string;
  redirectUris: string[];
  /** The registration response (RFC 7591), minus the secret. */
  metadata: Record<string, unknown>;
  createdAt: number;
}

/** A client authorized into a workspace. The pair is the connection (§2). */
export interface OAuthGrant {
  id: string;
  clientId: string;
  workspaceId: string;
  connectionId: string;
  accountId: string;
  createdAt: number;
}

export interface CodeRecord {
  codeHash: string;
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  familyId: string;
  expiresAt: number;
}

export interface TokenPair {
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/** An API key for a connection a human created in the UI (ADR 0016). */
export interface ConnectionKey {
  workspaceId: string;
  connectionId: string;
  /** The account that created it; the key works only while it's a member of the workspace. */
  accountId: string;
  /** The key's last 4 characters, shown so a human can match it to the one deployed. */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** It stops working then unless used before; each use moves this on (KEY_IDLE_EXPIRY). */
  expiresAt: number;
}

/** What a valid access token resolves to. */
export interface TokenGrant {
  grant: OAuthGrant;
  familyId: string;
  expiresAt: number;
}

export interface LoginResult {
  account: Account;
  /** True the first time this identity signs in (a personal workspace was created). */
  created: boolean;
  workspaces: Workspace[];
}

/** Local mode: the one username and password that protect the UI (ADR 0010). */
/** An account deleted because erasing its workspace left it with none. */
export interface ErasedAccount {
  id: string;
  email: string | null;
}

export interface LocalLogin {
  accountId: string;
  username: string;
  passwordHash: string;
  createdAt: number;
}
