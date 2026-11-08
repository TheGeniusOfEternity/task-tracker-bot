-- Selected tasks retain a single pending occurrence across missed calendar cycles.
ALTER TABLE occurrences ADD COLUMN IF NOT EXISTS coalesced boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS one_coalesced_pending_occurrence
  ON occurrences (task_id) WHERE coalesced AND completed_at IS NULL;
