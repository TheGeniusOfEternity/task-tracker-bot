-- Preserve data from the original schema while adopting general task groups.
DO $$
BEGIN
  IF to_regclass('public.families') IS NOT NULL
     AND to_regclass('public.task_groups') IS NULL THEN
    ALTER TABLE families RENAME TO task_groups;
    ALTER TABLE members RENAME COLUMN family_id TO group_id;
    ALTER TABLE tasks RENAME COLUMN family_id TO group_id;
    ALTER TABLE occurrences RENAME COLUMN family_id TO group_id;
  END IF;
END $$;
