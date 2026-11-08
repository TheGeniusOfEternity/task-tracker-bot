-- Group-local reminder hour, keeping existing groups at 19:00 Moscow time.
ALTER TABLE task_groups ADD COLUMN reminder_hour smallint NOT NULL DEFAULT 19 CHECK (reminder_hour BETWEEN 0 AND 23);
ALTER TABLE task_groups ADD COLUMN last_reminder_on date;
