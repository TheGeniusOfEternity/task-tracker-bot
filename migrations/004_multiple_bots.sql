CREATE TABLE bots (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{0,39}$'),
  name text NOT NULL,
  telegram_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bots (id,name) VALUES ('default','Task Tracker');

-- Existing data stays with the original bot, whose stable internal ID is "default".
ALTER TABLE app_users ADD COLUMN bot_id text NOT NULL DEFAULT 'default' REFERENCES bots(id);
ALTER TABLE task_groups ADD COLUMN bot_id text NOT NULL DEFAULT 'default' REFERENCES bots(id);
ALTER TABLE members ADD COLUMN bot_id text NOT NULL DEFAULT 'default' REFERENCES bots(id);
ALTER TABLE sessions ADD COLUMN bot_id text NOT NULL DEFAULT 'default' REFERENCES bots(id);
ALTER TABLE processed_updates ADD COLUMN bot_id text NOT NULL DEFAULT 'default' REFERENCES bots(id);
ALTER TABLE outbox ADD COLUMN bot_id text NOT NULL DEFAULT 'default' REFERENCES bots(id);

ALTER TABLE members DROP CONSTRAINT members_telegram_id_fkey;
ALTER TABLE sessions DROP CONSTRAINT sessions_telegram_id_fkey;
ALTER TABLE app_users DROP CONSTRAINT app_users_pkey;
ALTER TABLE app_users ADD PRIMARY KEY (bot_id,telegram_id);
ALTER TABLE members DROP CONSTRAINT members_telegram_id_key;
ALTER TABLE members ADD UNIQUE (bot_id,telegram_id);
ALTER TABLE members ADD CONSTRAINT members_bot_user_fkey FOREIGN KEY (bot_id,telegram_id) REFERENCES app_users(bot_id,telegram_id);
ALTER TABLE task_groups ADD UNIQUE (id,bot_id);
ALTER TABLE members ADD CONSTRAINT members_bot_group_fkey FOREIGN KEY (group_id,bot_id) REFERENCES task_groups(id,bot_id);
ALTER TABLE sessions DROP CONSTRAINT sessions_pkey;
ALTER TABLE sessions ADD PRIMARY KEY (bot_id,telegram_id);
ALTER TABLE sessions ADD CONSTRAINT sessions_bot_user_fkey FOREIGN KEY (bot_id,telegram_id) REFERENCES app_users(bot_id,telegram_id);
ALTER TABLE processed_updates DROP CONSTRAINT processed_updates_pkey;
ALTER TABLE processed_updates ADD PRIMARY KEY (bot_id,update_id);
ALTER TABLE outbox DROP CONSTRAINT outbox_dedupe_key_key;
ALTER TABLE outbox ADD UNIQUE (bot_id,dedupe_key);
CREATE INDEX outbox_bot_pending ON outbox (bot_id,available_at) WHERE state IN ('pending','sending');
