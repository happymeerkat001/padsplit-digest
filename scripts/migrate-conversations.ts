/**
 * Migrate conversation history from agent-brain JSON files to SQLite
 *
 * Run: npm run migrate
 */
//  What the program actually does (inputs → logic → outputs)
// Inputs

// Filesystem directory tree at AGENT_BRAIN_DATA
// .../conversations/<houseId>/<tenantId>.json
// Each <tenantId>.json file contents
// It expects the file to be JSON that parses into:
// ConversationMessage[] where each element is { role, content, timestamp }

// Core logic (the “main idea”)

// Ensure DB schema exists
// Create table + index if missing.
// Walk the directory tree
// List house folders → list tenant JSON files → read each JSON file → loop messages.
// For each message, insert into SQLite idempotently
// “Insert if new; skip if already inserted.”
// Track counts while you do it
// stats.houses, stats.tenants, stats.messages
// Close DB
// finalize connection / release file handle.

// Outputs (what matters)
// Primary output: a SQLite file is mutated
// table conversations exists
// rows exist (one per message), with duplicates avoided
// Secondary outputs: logs/console text (progress + counts)

import { readdirSync, readFileSync, existsSync } from 'node:fs'; //state - imports for file system operations to read the agent-brain conversation JSON files during migration
import { join } from 'node:path';
import { getDb, closeDb } from '../src/db/init.js';
import { logger } from '../src/utils/logger.js';

const AGENT_BRAIN_DATA = '/Users/leon/n8n-local/agent-brain/data/conversations'; // state - reference 

interface ConversationMessage {
  role: 'tenant' | 'assistant';
  content: string;
  timestamp: string;
} // state - reference 

function initConversationsTable(): void { //control - effimeral 
  const db = getDb(); //effect - i/o read 
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      house_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      UNIQUE(house_id, tenant_id, timestamp)
    ); 

    CREATE INDEX IF NOT EXISTS idx_conv_house_tenant
    ON conversations(house_id, tenant_id);
  `); //effect - IO write 
}

function migrateConversations(): { houses: number; tenants: number; messages: number } { //control - orchastration 
  const db = getDb(); // effect - i/o write
  const stats = { houses: 0, tenants: 0, messages: 0 }; //state - reference 

  if (!existsSync(AGENT_BRAIN_DATA)) { //control- routing
    logger.warn('Agent-brain data directory not found', { path: AGENT_BRAIN_DATA }); //effect - telemetry 
    return stats; //control - routing
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO conversations (house_id, tenant_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `); //effect - i/o write 

  const houseDirs = readdirSync(AGENT_BRAIN_DATA, { withFileTypes: true }) //effect -i/o read
    .filter((d) => d.isDirectory()); 

  for (const houseDir of houseDirs) { //control - routing
    const houseId = houseDir.name; 
    const housePath = join(AGENT_BRAIN_DATA, houseId); 
    stats.houses++; 

    const tenantFiles = readdirSync(housePath)
      .filter((f) => f.endsWith('.json'));

    for (const tenantFile of tenantFiles) { //control - routing 
      const tenantId = tenantFile.replace('.json', '');
      const filePath = join(housePath, tenantFile);
      stats.tenants++;

      try { // control - iteration 
        const content = readFileSync(filePath, 'utf-8');
        const messages: ConversationMessage[] = JSON.parse(content);

        for (const msg of messages) { //control - routing flow 
          insertStmt.run(houseId, tenantId, msg.role, msg.content, msg.timestamp);
          stats.messages++;
        }

        logger.debug('Migrated conversation', { houseId, tenantId, messages: messages.length });
      } catch (err) { //control - routing error handling
        logger.error('Failed to migrate file', { filePath, error: String(err) });
      }
    }
  }

  return stats;
}

async function main(): Promise<void> { //timing -scheduled 
  console.log('\n=== Conversation Migration ===\n'); //effect
  console.log(`Source: ${AGENT_BRAIN_DATA}`); //effect

  logger.info('Starting migration'); //effect

  initConversationsTable(); //control - orchastration 
  const stats = migrateConversations(); //control - orchastration

  console.log('\n=== Migration Complete ===\n'); //effect
  console.log(`Houses:   ${stats.houses}`); //effect
  console.log(`Tenants:  ${stats.tenants}`); //effect
  console.log(`Messages: ${stats.messages}`); //effect
  console.log('');

  logger.info('Migration complete', stats); //effect

  closeDb(); // Timing- important to ensure all data is flushed to disk before process exits
}

main().catch((err) => { //control- routing error handling
  console.error('Migration failed:', err); //effect
  process.exit(1); //effect- process control
});
