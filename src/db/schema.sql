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
  gap_days        DOUBLE PRECISION NOT NULL DEFAULT 2,
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

-- Count of memories written to each user's Walrus Memory, for /memory and
-- npm run stats. Added after launch, so it is added rather than declared.
ALTER TABLE users ADD COLUMN IF NOT EXISTS memory_count INTEGER NOT NULL DEFAULT 0;
-- Check-back gaps can be minutes or hours, so store fractional days.
ALTER TABLE items ALTER COLUMN gap_days TYPE DOUBLE PRECISION;

-- Text read from album photos while the rest of the album arrives.
CREATE TABLE IF NOT EXISTS media_parts (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  part_enc   TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id, message_id)
);
