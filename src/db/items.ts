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
  visible_items_hash?: string;
  status?: string;
}

// Get the most recent received_at timestamp from all items
export function getLastReceivedTimestamp(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT MAX(received_at) as last_received FROM digest_items').get() as { last_received: string | null } | undefined;
  return row?.last_received ?? null;
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

// Get classified items not yet sent (optionally bounded by a visibility window)
export function getUnsentClassifiedItems(windowHours?: number): DigestItem[] {
  const db = getDb();

  if (
    windowHours == null ||
    !Number.isFinite(windowHours) ||
    windowHours <= 0
  ) {
    return db.prepare(`
      SELECT * FROM digest_items WHERE status = 'classified' ORDER BY urgency DESC, received_at ASC
    `).all() as DigestItem[];
  }

  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  return db.prepare(`
    SELECT * FROM digest_items
    WHERE status = 'classified' AND received_at >= ?
    ORDER BY urgency DESC, received_at ASC
  `).all(cutoff) as DigestItem[];
}

export function getVisibleClassifiedItems(windowHours: number): DigestItem[] {
  const db = getDb();

  // fallback safety
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    return db.prepare(`
      SELECT *
      FROM digest_items
      WHERE intent IS NOT NULL
      ORDER BY received_at DESC
    `).all() as DigestItem[];
  }

  const cutoff = new Date(
    Date.now() - windowHours * 60 * 60 * 1000
  ).toISOString();

  return db.prepare(`
    SELECT *
    FROM digest_items
    WHERE intent IS NOT NULL
      AND received_at >= ?
    ORDER BY received_at DESC
  `).all(cutoff) as DigestItem[];
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
    WHERE id = ? AND status = 'classified'
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
    INSERT INTO digests (sent_at, item_count, urgent_count, recipient, gmail_message_id, visible_items_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    digest.sent_at,
    digest.item_count,
    digest.urgent_count,
    digest.recipient,
    digest.gmail_message_id ?? null,
    digest.visible_items_hash ?? null,
    digest.status ?? 'sent'
  );

  return result.lastInsertRowid as number;
}

export function getLastDigestHash(): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT visible_items_hash FROM digests ORDER BY id DESC LIMIT 1')
    .get() as { visible_items_hash: string | null } | undefined;
  return row?.visible_items_hash ?? null;
}
