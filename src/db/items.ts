import { getDb } from './init.js';

export interface DigestItem {
  id?: number;
  source: string;
  sender_email?: string;
  external_id: string;
  house_id?: string;
  tenant_id?: string;
  tenant_name?: string;
  subject?: string;
  body_raw?: string;
  body_resolved?: string;
  link_url?: string;
  received_at: string;
  fetched_at?: string;
  intent?: string;
  confidence?: number;
  is_high_risk?: number;
  urgency?: 'high' | 'medium' | 'low';
  classification_reason?: string;
  classified_at?: string;
  digest_id?: number;
  digest_sent_at?: string;
  status?: 'pending' | 'classified' | 'sent' | 'error';
}

export interface Digest {
  id?: number;
  sent_at: string;
  item_count: number;
  urgent_count: number;
  recipient: string;
  gmail_message_id?: string;
  status?: string;
}

// Check if item exists by external_id
export function itemExists(externalId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM digest_items WHERE external_id = ?').get(externalId);
  return row !== undefined;
}

// Insert new item (idempotent - skips if exists)
export function insertItem(item: Omit<DigestItem, 'id'>): number | null {
  if (itemExists(item.external_id)) {
    return null; // Already exists, skip
  }

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO digest_items (
      source, sender_email, external_id, house_id, tenant_id, tenant_name,
      subject, body_raw, body_resolved, link_url, received_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    item.source,
    item.sender_email ?? null,
    item.external_id,
    item.house_id ?? null,
    item.tenant_id ?? null,
    item.tenant_name ?? null,
    item.subject ?? null,
    item.body_raw ?? null,
    item.body_resolved ?? null,
    item.link_url ?? null,
    item.received_at,
    item.status ?? 'pending'
  );

  return result.lastInsertRowid as number;
}

// Get pending items (not yet classified)
export function getPendingItems(): DigestItem[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM digest_items WHERE status = 'pending' ORDER BY received_at ASC
  `).all() as DigestItem[];
}

// Get classified items not yet sent
export function getUnsentClassifiedItems(): DigestItem[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM digest_items WHERE status = 'classified' ORDER BY urgency DESC, received_at ASC
  `).all() as DigestItem[];
}

// Update item with classification
export function updateItemClassification(
  id: number,
  classification: {
    intent: string;
    confidence: number;
    is_high_risk: boolean;
    urgency: 'high' | 'medium' | 'low';
    reason: string;
  }
): void {
  const db = getDb();
  db.prepare(`
    UPDATE digest_items SET
      intent = ?,
      confidence = ?,
      is_high_risk = ?,
      urgency = ?,
      classification_reason = ?,
      classified_at = datetime('now'),
      status = 'classified'
    WHERE id = ?
  `).run(
    classification.intent,
    classification.confidence,
    classification.is_high_risk ? 1 : 0,
    classification.urgency,
    classification.reason,
    id
  );
}

// Update item with resolved body
export function updateItemResolved(id: number, bodyResolved: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE digest_items SET body_resolved = ? WHERE id = ?
  `).run(bodyResolved, id);
}

// Mark items as sent
export function markItemsSent(ids: number[], digestId: number): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE digest_items SET
      digest_id = ?,
      digest_sent_at = datetime('now'),
      status = 'sent'
    WHERE id = ?
  `);

  const transaction = db.transaction(() => {
    for (const id of ids) {
      stmt.run(digestId, id);
    }
  });

  transaction();
}

// Create digest record
export function createDigest(digest: Omit<Digest, 'id'>): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO digests (sent_at, item_count, urgent_count, recipient, gmail_message_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    digest.sent_at,
    digest.item_count,
    digest.urgent_count,
    digest.recipient,
    digest.gmail_message_id ?? null,
    digest.status ?? 'sent'
  );

  return result.lastInsertRowid as number;
}
