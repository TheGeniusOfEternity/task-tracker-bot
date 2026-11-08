import { readFile } from 'node:fs/promises';
import { closeStore, getStore } from '../src/db.js';

try {
  const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
  await getStore().transaction(async db => { await db.query(sql); });
  console.log('Database schema is ready.');
} finally { await closeStore(); }
