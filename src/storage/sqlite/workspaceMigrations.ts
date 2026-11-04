import type { Migration } from './migrate.js';

export const workspaceMigrations: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE connections (
        id            TEXT PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        label         TEXT,
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER
      );
      CREATE TABLE handles (
        connection_id  TEXT NOT NULL REFERENCES connections(id),
        name           TEXT NOT NULL,
        first_seen_at  INTEGER NOT NULL,
        PRIMARY KEY (connection_id, name)
      );
      CREATE TABLE messages (
        id                  TEXT PRIMARY KEY,
        type                TEXT NOT NULL CHECK (type IN ('message', 'notice')),
        from_connection_id  TEXT NOT NULL REFERENCES connections(id),
        from_handle         TEXT,
        to_json             TEXT NOT NULL,
        subject             TEXT,
        body_md             TEXT,
        payload_json        TEXT,
        thread_id           TEXT NOT NULL,
        reply_to            TEXT,
        created_at          INTEGER NOT NULL,
        expires_at          INTEGER NOT NULL
      );
      CREATE INDEX messages_thread ON messages(thread_id, created_at);
      CREATE INDEX messages_created ON messages(created_at);
      CREATE INDEX messages_from ON messages(from_connection_id);
      CREATE TABLE deliveries (
        message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        to_connection_id  TEXT NOT NULL REFERENCES connections(id),
        to_handle         TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'read', 'expired')),
        read_at           INTEGER,
        expires_at        INTEGER NOT NULL,
        PRIMARY KEY (message_id, to_connection_id, to_handle)
      );
      CREATE INDEX deliveries_mailbox ON deliveries(to_connection_id, state, to_handle, expires_at);
    `,
  },
  {
    version: 2,
    up: `
      -- Contact policies (§9). Every connection, existing ones included, starts
      -- as an empty allowlist: deny everyone else.
      ALTER TABLE connections ADD COLUMN policy_mode TEXT NOT NULL DEFAULT 'allowlist'
        CHECK (policy_mode IN ('all', 'allowlist'));
      CREATE TABLE policy_allowed (
        connection_id          TEXT NOT NULL REFERENCES connections(id),
        allowed_connection_id  TEXT NOT NULL REFERENCES connections(id),
        PRIMARY KEY (connection_id, allowed_connection_id)
      );

      -- Expiry sweeps and the per-sender outstanding count.
      CREATE INDEX deliveries_due ON deliveries(state, expires_at);

      -- Append-only audit log (§12). Metadata only.
      CREATE TABLE audit (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        at             INTEGER NOT NULL,
        event          TEXT NOT NULL,
        actor          TEXT NOT NULL CHECK (actor IN ('agent', 'human', 'system')),
        connection_id  TEXT,
        detail_json    TEXT NOT NULL
      );
      CREATE INDEX audit_at ON audit(at);
      CREATE TRIGGER audit_append_only BEFORE UPDATE ON audit
      BEGIN
        SELECT RAISE(ABORT, 'audit log is append-only');
      END;
    `,
  },
  {
    version: 3,
    up: `
      -- Archived connections (ADR 0011). An archived connection is also blocked.
      ALTER TABLE connections ADD COLUMN archived_at INTEGER;
    `,
  },
  {
    version: 4,
    up: `
      -- Filtering the audit log in the UI by event and by connection.
      CREATE INDEX audit_event ON audit(event);
      CREATE INDEX audit_connection ON audit(connection_id);
    `,
  },
  {
    version: 5,
    up: `
      -- How a connection signs in (ADR 0016): 'app' connected itself (OAuth, or
      -- its local URL); 'key' was created by a human in the UI, with an API key.
      ALTER TABLE connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'app'
        CHECK (kind IN ('app', 'key'));
    `,
  },
  {
    version: 6,
    up: `
      -- When a human last blocked a connection. An app may take over a blocked
      -- connection only if it registered after that, and soon after (ADR 0011).
      ALTER TABLE connections ADD COLUMN blocked_at INTEGER;

      -- What the workspace stores, as running totals so a write needn't add it
      -- all up: messages count towards MAX_WORKSPACE_MB, audit entries towards
      -- MAX_AUDIT_MB. Each row also counts a fixed overhead, so empty ones
      -- aren't free.
      CREATE TABLE stored_bytes (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        messages  INTEGER NOT NULL,
        audit     INTEGER NOT NULL
      );
      INSERT INTO stored_bytes (id, messages, audit) VALUES (
        1,
        (SELECT COALESCE(SUM(256 + length(CAST(to_json AS BLOB))
                                 + IFNULL(length(CAST(subject AS BLOB)), 0)
                                 + IFNULL(length(CAST(body_md AS BLOB)), 0)
                                 + IFNULL(length(CAST(payload_json AS BLOB)), 0)), 0)
         FROM messages),
        (SELECT COALESCE(SUM(64 + length(CAST(event AS BLOB))
                                + length(CAST(detail_json AS BLOB))), 0)
         FROM audit)
      );
      CREATE TRIGGER stored_bytes_message_insert AFTER INSERT ON messages
      BEGIN
        UPDATE stored_bytes SET messages = messages + 256
          + length(CAST(NEW.to_json AS BLOB))
          + IFNULL(length(CAST(NEW.subject AS BLOB)), 0)
          + IFNULL(length(CAST(NEW.body_md AS BLOB)), 0)
          + IFNULL(length(CAST(NEW.payload_json AS BLOB)), 0);
      END;
      CREATE TRIGGER stored_bytes_message_delete AFTER DELETE ON messages
      BEGIN
        UPDATE stored_bytes SET messages = messages - 256
          - length(CAST(OLD.to_json AS BLOB))
          - IFNULL(length(CAST(OLD.subject AS BLOB)), 0)
          - IFNULL(length(CAST(OLD.body_md AS BLOB)), 0)
          - IFNULL(length(CAST(OLD.payload_json AS BLOB)), 0);
      END;
      CREATE TRIGGER messages_not_edited BEFORE UPDATE OF to_json, subject, body_md, payload_json
        ON messages
      BEGIN
        SELECT RAISE(ABORT, 'messages are not edited');
      END;
      CREATE TRIGGER stored_bytes_audit_insert AFTER INSERT ON audit
      BEGIN
        UPDATE stored_bytes SET audit = audit + 64
          + length(CAST(NEW.event AS BLOB)) + length(CAST(NEW.detail_json AS BLOB));
      END;
      CREATE TRIGGER stored_bytes_audit_delete AFTER DELETE ON audit
      BEGIN
        UPDATE stored_bytes SET audit = audit - 64
          - length(CAST(OLD.event AS BLOB)) - length(CAST(OLD.detail_json AS BLOB));
      END;
    `,
  },
  {
    version: 7,
    up: `
      -- Archived mailboxes: a human hid it, it takes no mail, no agent can use
      -- it, and it doesn't count towards MAX_HANDLES_PER_CONNECTION.
      ALTER TABLE handles ADD COLUMN archived_at INTEGER;
    `,
  },
  {
    version: 8,
    up: `
      -- Wake-ups: an HTTPS address Budd POSTs to when a mailbox has mail. The
      -- address and token are sealed with the workspace's key, which lives in
      -- the control database; only the host and the token's last 4 characters
      -- are kept in the clear, to show.
      CREATE TABLE wake_ups (
        connection_id      TEXT NOT NULL,
        handle             TEXT NOT NULL,
        url_sealed         BLOB NOT NULL,
        token_sealed       BLOB,
        host               TEXT NOT NULL,
        token_hint         TEXT,
        retry_interval_ms  INTEGER NOT NULL,
        max_retries        INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        -- The current batch of mail: when it was first woken for, the latest
        -- wake-up or retry, and how many retries were sent.
        woken_at           INTEGER,
        attempt_at         INTEGER,
        retries            INTEGER NOT NULL DEFAULT 0,
        -- The latest result, a test included: when, and the status only.
        last_at            INTEGER,
        last_status        TEXT,
        last_ok            INTEGER,
        PRIMARY KEY (connection_id, handle),
        FOREIGN KEY (connection_id, handle) REFERENCES handles(connection_id, name)
      );
      -- When each mailbox was last read, which the wake-up sweep asks every minute.
      CREATE INDEX deliveries_read ON deliveries(to_connection_id, to_handle, read_at);
    `,
  },
  {
    version: 9,
    up: `
      -- Wake-ups can be signed (an HMAC secret, sealed like the token), and are
      -- capped per mailbox per hour (WAKE_UPS_PER_HOUR): a fixed hour window.
      ALTER TABLE wake_ups ADD COLUMN signing_secret_sealed BLOB;
      ALTER TABLE wake_ups ADD COLUMN hour_started_at INTEGER;
      ALTER TABLE wake_ups ADD COLUMN hour_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
