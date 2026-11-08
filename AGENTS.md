# Project conventions

- Use Conventional Commits: `type(scope): description`, for example `feat(tasks): add recurring assignments` or `refactor(groups): generalize task tracking`. Use `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore` as appropriate.
- Treat this as a general task tracker for groups. Use neutral terminology in commands, interfaces, examples, and documentation. Keep personal participant names specific to each viewer.
- Assign tasks to fixed owners. A help request transfers only the selected occurrence to the first recipient who accepts; future occurrences retain their original owner.
- Preserve published migration files and existing data. Add a new numbered migration for schema changes.
- For code changes, run `npm run check` and `npm test`. Report checks that could not run. Keep tokens and connection strings out of the repository.
