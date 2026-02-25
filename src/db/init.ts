// The Real Takeaway
// State persistence + effect isolation.
// It is about:

// Owning and protecting an external resource.

// Inputs
// 	•	config.db.path (string path)
// 	•	schema.sql file (disk file)
// 	•	Current database file on disk (may or may not exist)

// Logic
// 	•	If DB not opened → open it
// 	•	Configure DB
// 	•	Initialize schema
// 	•	Apply migrations
// 	•	Return DB reference
// 	•	Later: close DB

// Outputs
// 	•	A persistent DB connection (heap + native)
// 	•	Possibly modified database file on disk
// 	•	No return data except the DB reference

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js'; // memory -shared container

const __dirname = dirname(fileURLToPath(import.meta.url)); //memory - rooted memory, shared contaner 

let db: Database.Database | null = null; // memory - rooted memory, shared container, external resource handler 

export function getDb(): Database.Database { // memory- state - shared container
  if (!db) { //control - routing flow 
    db = new Database(config.db.path); // effect - environment mutation, initializes database connection and assigns to external resource handler
    db.pragma('journal_mode = WAL'); // effect - environment mutation, sets database journal mode for better concurrency
    db.pragma('foreign_keys = ON'); // effect - environment mutation, enables foreign key constraints for data integrity
    initSchema(); // control - orchestration of effects, calls another effect to initialize the database schema on first access
  }
  return db; // state - returns shared resource handler, the database connection
}

function initSchema(): void { // effect - environment mutation, mutates external resource handler by setting up database schema
  const schemaPath = join(__dirname, 'schema.sql'); // memory - captured memory, local variable holding path to schema file
  const schema = readFileSync(schemaPath, 'utf-8'); // memory - captured memory, reads schema file content into memory
  db!.exec(schema); // effect - environment mutation, executes schema SQL to create necessary tables and indexes in the database
  runMigrations(); // control - orchestration of effects, calls migration function to handle any necessary schema updates after initial setup
}

function runMigrations(): void { // effect - environment mutation, mutates external resource handler by applying schema migrations
  const hasSenderEmailColumn = db! // memory - captured memory, accesses database to check current schema state
    .prepare("SELECT 1 FROM pragma_table_info('digest_items') WHERE name = 'sender_email'")
    .get(); //effect - environmental read

  if (!hasSenderEmailColumn) { // control - routing flow, checks if migration is needed based on current schema state
    db!.exec('ALTER TABLE digest_items ADD COLUMN sender_email TEXT'); // effect - environment mutation, applies schema migration to add new column for sender email in digest_items table
  }

  const hasVisibleItemsHashColumn = db!
    .prepare("SELECT 1 FROM pragma_table_info('digests') WHERE name = 'visible_items_hash'")
    .get();

  if (!hasVisibleItemsHashColumn) {
    db!.exec('ALTER TABLE digests ADD COLUMN visible_items_hash TEXT');
  }
}

export function closeDb(): void { // effect- environment mutation
  if (db) { // control - routing flow, checks if database connection exists before attempting to close it
    db.close(); // effect - environment mutation, closes database connection to free up resources
    db = null; 
  }
}
