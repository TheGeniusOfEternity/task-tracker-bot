# Project conventions

- Use Conventional Commits: `type(scope): description`, for example `feat(tasks): add recurring assignments` or `refactor(groups): generalize task tracking`. Use `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore` as appropriate.
- Treat this as a general task tracker for groups. Use neutral terminology in commands, interfaces, examples, and documentation. Keep personal participant names specific to each viewer.
- Scope users, groups, wizards, update deduplication and outgoing messages to a stable bot ID. Never route queued messages using another bot's token or accept invitation/callback references from another bot. Keep bot tokens in environment variables, not database rows or source files.
- Assign tasks to fixed owners. A help request transfers only the selected occurrence to the first recipient who accepts; future occurrences retain their original owner.
- Keep calendar recurrence separate from overdue reminders. In weekend recovery mode, retain one pending occurrence across missed cycles; completion covers calendar dates through that day and resumes the next future calendar date. Preserve the original due date and any transferred assignee while pending.
- Preserve published migration files and existing data. Add a new numbered migration for schema changes.
- For code changes, run `npm run check` and `npm test`. Report checks that could not run. Keep tokens and connection strings out of the repository.
