import type { Migration } from './migrate.js';

export const controlMigrations: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE accounts (
        id          TEXT PRIMARY KEY,
        email       TEXT UNIQUE,            -- NULL for the implicit local-mode account
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,       -- immutable; names the workspace DB file
        slug        TEXT NOT NULL UNIQUE,   -- unique per instance, immutable in v1
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE memberships (
        account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (account_id, workspace_id)
      );
      CREATE INDEX memberships_workspace ON memberships(workspace_id);
    `,
  },
  {
    version: 2,
    up: `
      -- Hosted mode (§5). Humans sign in through OpenID Connect.
      ALTER TABLE accounts ADD COLUMN oidc_issuer TEXT;
      ALTER TABLE accounts ADD COLUMN oidc_subject TEXT;
      CREATE UNIQUE INDEX accounts_oidc ON accounts(oidc_issuer, oidc_subject);

      -- MCP clients from Dynamic Client Registration (RFC 7591).
      CREATE TABLE oauth_clients (
        client_id           TEXT PRIMARY KEY,
        client_secret_hash  TEXT,                 -- NULL for public clients
        auth_method         TEXT NOT NULL CHECK (auth_method IN
                              ('none', 'client_secret_post', 'client_secret_basic')),
        client_name         TEXT,                 -- self-reported, unverified
        slug_base           TEXT NOT NULL,        -- connection slug before collision suffix
        redirect_uris_json  TEXT NOT NULL,
        metadata_json       TEXT NOT NULL,
        created_at          INTEGER NOT NULL
      );

      -- A client authorized into a workspace: that pair is the connection.
      CREATE TABLE oauth_grants (
        id             TEXT PRIMARY KEY,
        client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        connection_id  TEXT NOT NULL,             -- in the workspace DB
        account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL,
        UNIQUE (client_id, workspace_id)
      );
      CREATE INDEX oauth_grants_connection ON oauth_grants(workspace_id, connection_id);

      -- Authorization codes and tokens are stored only as SHA-256 hashes.
      CREATE TABLE oauth_codes (
        code_hash       TEXT PRIMARY KEY,
        grant_id        TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
        redirect_uri    TEXT NOT NULL,
        code_challenge  TEXT NOT NULL,
        family_id       TEXT NOT NULL,            -- tokens issued from this code
        expires_at      INTEGER NOT NULL,
        used_at         INTEGER
      );
      CREATE TABLE oauth_tokens (
        token_hash   TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        grant_id     TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
        family_id    TEXT NOT NULL,               -- one login's chain of rotations
        expires_at   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        rotated_at   INTEGER,                     -- refresh tokens: when exchanged
        revoked_at   INTEGER
      );
      CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
      CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
      CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
    `,
  },
  {
    version: 3,
    up: `
      -- Local mode: the UI's username and password (ADR 0010). At most one row.
      CREATE TABLE local_logins (
        account_id     TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        username       TEXT NOT NULL,
        password_hash  TEXT NOT NULL,             -- scrypt, see src/auth/password.ts
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    up: `
      -- API keys for connections a human created in the UI (ADR 0016), stored
      -- only as SHA-256 hashes. A connection has at most one unrevoked key.
      CREATE TABLE connection_keys (
        key_hash       TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        connection_id  TEXT NOT NULL,             -- in the workspace DB
        account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        key_hint       TEXT NOT NULL,             -- its last 4 characters, to tell keys apart
        created_at     INTEGER NOT NULL,
        revoked_at     INTEGER
      );
      CREATE INDEX connection_keys_connection ON connection_keys(workspace_id, connection_id);
      CREATE UNIQUE INDEX connection_keys_live ON connection_keys(workspace_id, connection_id)
        WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 5,
    up: `
      -- The profile menu and preferences: the name and picture the sign-in
      -- provider gives (refreshed at each sign-in), and the chosen theme.
      ALTER TABLE accounts ADD COLUMN name TEXT;
      ALTER TABLE accounts ADD COLUMN picture TEXT;      -- an https URL, or NULL
      ALTER TABLE accounts ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'
        CHECK (theme IN ('system', 'light', 'dark'));
    `,
  },
  {
    version: 6,
    up: `
      -- API keys stop working after KEY_IDLE_EXPIRY unused: each use moves
      -- expires_at on. Keys made before this have none until Budd starts,
      -- which gives them a full KEY_IDLE_EXPIRY from then (SqliteStorage.init).
      ALTER TABLE connection_keys ADD COLUMN last_used_at INTEGER;
      ALTER TABLE connection_keys ADD COLUMN expires_at INTEGER;

      -- Local mode: one-time sign-in links that \`budd login\` prints, so a
      -- human locked out by failed password attempts can still get in.
      CREATE TABLE local_login_links (
        code_hash   TEXT PRIMARY KEY,           -- SHA-256 of the code in the link
        expires_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 7,
    up: `
      -- Each workspace's key for the secrets it stores encrypted (wake-up URLs
      -- and tokens), kept here so a workspace file alone doesn't reveal them.
      -- New workspaces get one when they are created.
      ALTER TABLE workspaces ADD COLUMN secret_key BLOB;
      UPDATE workspaces SET secret_key = randomblob(32) WHERE secret_key IS NULL;
    `,
  },
  {
    version: 8,
    up: `
      -- The operator console (ADR 0022).
      ALTER TABLE accounts ADD COLUMN last_sign_in_at INTEGER;

      CREATE TABLE operators (
        account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        added_at    INTEGER NOT NULL
      );

      -- One-time links that \`budd operator\` prints.
      CREATE TABLE operator_links (
        code_hash   TEXT PRIMARY KEY,           -- SHA-256 of the code in the link
        email       TEXT NOT NULL,              -- lowercased: only the account with it may use the link
        expires_at  INTEGER NOT NULL
      );

      -- Each workspace's storage, measured hourly and kept for 30 days.
      CREATE TABLE workspace_usage (
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        hour            INTEGER NOT NULL,       -- the hour's start, ms since the epoch (UTC)
        messages_bytes  INTEGER NOT NULL,       -- counted against MAX_WORKSPACE_MB
        audit_bytes     INTEGER NOT NULL,       -- counted against MAX_AUDIT_MB
        file_bytes      INTEGER NOT NULL,       -- the database file and its WAL on disk
        PRIMARY KEY (workspace_id, hour)
      ) WITHOUT ROWID;
      -- Covers the instance-wide figures (the total, a day's sample of each workspace).
      CREATE INDEX workspace_usage_hour ON workspace_usage(hour, workspace_id, messages_bytes);
    `,
  },
];
