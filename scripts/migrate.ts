import { readFile, readdir } from 'node:fs/promises';
import { closeStore, getStore } from '../src/db.js';

try {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  await getStore().transaction(async db => {
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await db.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    for (const name of files) {
      if ((await db.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rows.length) continue;
      await db.query(await readFile(new URL(name, directory), 'utf8'));
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      console.log(`Applied ${name}`);
    }
  });
  console.log('Database schema is ready.');
} finally { await closeStore(); }
