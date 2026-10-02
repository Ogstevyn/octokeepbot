-- OctoKeep schema. Idempotent: safe to run on every deploy.
-- Content (titles, summaries, task details, pending conversation state and
-- Walrus Memory credentials) is stored encrypted with APP_ENCRYPTION_KEY.
-- Postgres sees only ids, times and statuses.

CREATE TABLE IF NOT EXISTS users (
  id               BIGINT PRIMARY KEY,           -- Telegram user id
  chat_id          BIGINT NOT NULL,
  first_name       TEXT NOT NULL DEFAULT '',
  timezone         TEXT,
  default_gap_days INTEGER NOT NULL DEFAULT 2 CHECK (default_gap_days BETWEEN 1 AND 60),
  creds_enc        TEXT,
  pending_enc      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('save', 'task')),
  status          TEXT NOT NULL CHECK (status IN ('draft', 'open', 'quiet', 'done', 'dropped')),
  payload_enc     TEXT NOT NULL,
  gap_days        INTEGER NOT NULL DEFAULT 2,
  due_at          TIMESTAMPTZ,
  next_at         TIMESTAMPTZ,
  nudge_count     INTEGER NOT NULL DEFAULT 0,
  last_nudged_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_due_idx ON items (next_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS items_user_idx ON items (user_id, status);

-- Memory writes that failed are retried by the scheduler.
CREATE TABLE IF NOT EXISTS memory_outbox (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text_enc   TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_try   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_outbox_next_idx ON memory_outbox (next_try);

-- Telegram can deliver the same update more than once.
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id BIGINT PRIMARY KEY,
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
