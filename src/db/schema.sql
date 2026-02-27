-- PadSplit Digest Database Schema

-- digest_items: All fetched items from scraping
CREATE TABLE IF NOT EXISTS digest_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,              -- sender category key
    sender_email TEXT,                 -- sender/member display name
    external_id TEXT UNIQUE,           -- scraper-generated message ID
    house_id TEXT,
    tenant_id TEXT,
    tenant_name TEXT,
    subject TEXT,
    body_raw TEXT,
    body_resolved TEXT,
    link_url TEXT,
    received_at TEXT NOT NULL,         -- ISO 8601 datetime
    fetched_at TEXT DEFAULT (datetime('now')),

    -- Classification
    intent TEXT,
    confidence REAL,
    is_high_risk INTEGER DEFAULT 0,
    urgency TEXT,
    classification_reason TEXT,
    classified_at TEXT,

    -- Digest tracking
    digest_id INTEGER,
    digest_sent_at TEXT,
    status TEXT DEFAULT 'pending',
    resolved_flag INTEGER DEFAULT 0
);

-- digests: Generated digest runs
CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at TEXT NOT NULL,
    item_count INTEGER,
    urgent_count INTEGER,
    recipient TEXT,
    visible_items_hash TEXT,
    status TEXT DEFAULT 'sent'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_items_status ON digest_items(status);
CREATE INDEX IF NOT EXISTS idx_items_received ON digest_items(received_at);
CREATE INDEX IF NOT EXISTS idx_items_external_id ON digest_items(external_id);
CREATE INDEX IF NOT EXISTS idx_items_house_tenant ON digest_items(house_id, tenant_id);
