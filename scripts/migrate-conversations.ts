/**
 * Migrate conversation history from agent-brain JSON files to SQLite
 *
 * Run: npm run migrate
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from '../src/db/init.js';
import { logger } from '../src/utils/logger.js';

const AGENT_BRAIN_DATA = '/Users/leon/n8n-local/agent-brain/data/conversations';

interface ConversationMessage {
  role: 'tenant' | 'assistant';
  content: string;
  timestamp: string;
}

function initConversationsTable(): void {
  const db = getDb();

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
  `);
}

function migrateConversations(): { houses: number; tenants: number; messages: number } {
  const db = getDb();
  const stats = { houses: 0, tenants: 0, messages: 0 };

  if (!existsSync(AGENT_BRAIN_DATA)) {
    logger.warn('Agent-brain data directory not found', { path: AGENT_BRAIN_DATA });
    return stats;
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO conversations (house_id, tenant_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const houseDirs = readdirSync(AGENT_BRAIN_DATA, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const houseDir of houseDirs) {
    const houseId = houseDir.name;
    const housePath = join(AGENT_BRAIN_DATA, houseId);
    stats.houses++;

    const tenantFiles = readdirSync(housePath)
      .filter((f) => f.endsWith('.json'));

    for (const tenantFile of tenantFiles) {
      const tenantId = tenantFile.replace('.json', '');
      const filePath = join(housePath, tenantFile);
      stats.tenants++;

      try {
        const content = readFileSync(filePath, 'utf-8');
        const messages: ConversationMessage[] = JSON.parse(content);

        for (const msg of messages) {
          insertStmt.run(houseId, tenantId, msg.role, msg.content, msg.timestamp);
          stats.messages++;
        }

        logger.debug('Migrated conversation', { houseId, tenantId, messages: messages.length });
      } catch (err) {
        logger.error('Failed to migrate file', { filePath, error: String(err) });
      }
    }
  }

  return stats;
}

async function main(): Promise<void> {
  console.log('\n=== Conversation Migration ===\n');
  console.log(`Source: ${AGENT_BRAIN_DATA}`);

  logger.info('Starting migration');

  initConversationsTable();
  const stats = migrateConversations();

  console.log('\n=== Migration Complete ===\n');
  console.log(`Houses:   ${stats.houses}`);
  console.log(`Tenants:  ${stats.tenants}`);
  console.log(`Messages: ${stats.messages}`);
  console.log('');

  logger.info('Migration complete', stats);

  closeDb();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
