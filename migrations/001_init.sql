CREATE TABLE IF NOT EXISTS app_users (
  telegram_id bigint PRIMARY KEY,
  profile_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS families (
  id serial PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  invite_hash text UNIQUE,
  invite_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
  id serial PRIMARY KEY,
  family_id integer NOT NULL REFERENCES families(id),
  telegram_id bigint NOT NULL UNIQUE REFERENCES app_users(telegram_id),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  UNIQUE (id, family_id)
);
CREATE TABLE IF NOT EXISTS aliases (
  viewer_id integer NOT NULL REFERENCES members(id),
  target_id integer NOT NULL REFERENCES members(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  PRIMARY KEY (viewer_id, target_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id serial PRIMARY KEY,
  family_id integer NOT NULL REFERENCES families(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  owner_id integer NOT NULL,
  schedule jsonb NOT NULL,
  next_on date,
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (owner_id, family_id) REFERENCES members(id, family_id)
);
CREATE TABLE IF NOT EXISTS occurrences (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id),
  family_id integer NOT NULL REFERENCES families(id),
  due_on date NOT NULL,
  original_owner_id integer NOT NULL,
  assignee_id integer NOT NULL,
  completed_by integer REFERENCES members(id),
  completed_at timestamptz,
  UNIQUE (task_id, due_on),
  FOREIGN KEY (original_owner_id, family_id) REFERENCES members(id, family_id),
  FOREIGN KEY (assignee_id, family_id) REFERENCES members(id, family_id)
);
CREATE INDEX IF NOT EXISTS occurrences_pending ON occurrences (family_id, assignee_id, due_on) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS help_requests (
  id serial PRIMARY KEY,
  occurrence_id integer NOT NULL REFERENCES occurrences(id),
  requester_id integer NOT NULL REFERENCES members(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'cancelled')),
  accepted_by integer REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_help ON help_requests (occurrence_id) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS help_recipients (
  request_id integer NOT NULL REFERENCES help_requests(id),
  member_id integer NOT NULL REFERENCES members(id),
  message_id bigint,
  PRIMARY KEY (request_id, member_id)
);
CREATE TABLE IF NOT EXISTS events (
  id serial PRIMARY KEY,
  occurrence_id integer NOT NULL REFERENCES occurrences(id),
  actor_id integer NOT NULL REFERENCES members(id),
  kind text NOT NULL CHECK (kind IN ('completed', 'reopened', 'help_requested', 'transferred', 'help_cancelled')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  telegram_id bigint PRIMARY KEY REFERENCES app_users(telegram_id),
  data jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour'
);
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id serial PRIMARY KEY,
  dedupe_key text UNIQUE NOT NULL,
  method text NOT NULL,
  payload jsonb NOT NULL,
  guard_help_id integer REFERENCES help_requests(id),
  recipient_id integer REFERENCES members(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (available_at) WHERE state IN ('pending', 'sending');
