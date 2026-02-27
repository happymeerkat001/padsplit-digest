import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }

  return db;
}

function initSchema(): void {
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db!.exec(schema);
  runMigrations();
}

function runMigrations(): void {
  const hasSenderEmailColumn = db!
    .prepare("SELECT 1 FROM pragma_table_info('digest_items') WHERE name = 'sender_email'")
    .get();

  if (!hasSenderEmailColumn) {
    db!.exec('ALTER TABLE digest_items ADD COLUMN sender_email TEXT');
  }

  const hasResolvedFlagColumn = db!
    .prepare("SELECT 1 FROM pragma_table_info('digest_items') WHERE name = 'resolved_flag'")
    .get();

  if (!hasResolvedFlagColumn) {
    db!.exec('ALTER TABLE digest_items ADD COLUMN resolved_flag INTEGER DEFAULT 0');
  }

  const hasVisibleItemsHashColumn = db!
    .prepare("SELECT 1 FROM pragma_table_info('digests') WHERE name = 'visible_items_hash'")
    .get();

  if (!hasVisibleItemsHashColumn) {
    db!.exec('ALTER TABLE digests ADD COLUMN visible_items_hash TEXT');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
