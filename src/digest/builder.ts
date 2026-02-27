import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import {
  createDigest,
  getLastDigestHash,
  getVisibleClassifiedItems,
  markItemsSent,
  type DigestItem,
} from '../db/items.js';
import { logger } from '../utils/logger.js';

interface SenderGroup {
  key: string;
  label: string;
  items: DigestItem[];
}

function groupBySenderCategory(items: DigestItem[]): SenderGroup[] {
  const groupMap = new Map<string, SenderGroup>();

  for (const category of config.senderCategories) {
    groupMap.set(category.key, {
      key: category.key,
      label: category.label,
      items: [],
    });
  }

  for (const item of items) {
    const key = groupMap.has(item.source) ? item.source : 'others';
    const group = groupMap.get(key);
    if (!group) {
      continue;
    }
    group.items.push(item);
  }

  return config.senderCategories
    .map((category) => groupMap.get(category.key))
    .filter((group): group is SenderGroup => Boolean(group));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestampForFile(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function readDeployMetaLocalized(): string | null {
  const deployMetaPath = resolve(process.cwd(), 'public', 'deploy-meta.json');
  if (!existsSync(deployMetaPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(deployMetaPath, 'utf-8')) as { deployedAt?: unknown };
    if (typeof parsed.deployedAt !== 'string') {
      return null;
    }

    const deployedAt = new Date(parsed.deployedAt);
    if (Number.isNaN(deployedAt.getTime())) {
      return null;
    }

    return deployedAt.toLocaleString('en-US', {
      timeZone: config.schedule.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

function renderItems(group: SenderGroup): string {
  if (group.items.length === 0) {
    return '<p class="empty">No items in this category.</p>';
  }

  const rows = group.items.map((item) => {
    const subject = escapeHtml(item.subject || '(No subject)');
    const sender = escapeHtml(item.sender_email || item.source || 'unknown');
    const intent = escapeHtml(item.intent || 'unknown');
    const urgency = escapeHtml(item.urgency || 'medium');
    const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
      timeZone: config.schedule.timezone,
    });

    return `<tr>
      <td class="subject">${subject}</td>
      <td>${sender}</td>
      <td>${intent}</td>
      <td>${urgency}</td>
      <td>${escapeHtml(receivedAt)}</td>
    </tr>`;
  });

  return `<table>
    <thead>
      <tr>
        <th>Subject</th>
        <th>Sender</th>
        <th>Intent</th>
        <th>Urgency</th>
        <th>Received (${escapeHtml(config.schedule.timezone)})</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
    </tbody>
  </table>`;
}

function buildDigestHtml(groups: SenderGroup[], now: Date): string {
  const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);
  const urgentCount = groups.reduce(
    (sum, group) => sum + group.items.filter((item) => item.urgency === 'high').length,
    0
  );

  const generatedAt = now.toLocaleString('en-US', {
    timeZone: config.schedule.timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const deployedAt = readDeployMetaLocalized();

  const sections = groups.map((group) => `
    <section>
      <h2>${escapeHtml(group.label)} (${group.items.length})</h2>
      ${renderItems(group)}
    </section>
  `);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PadSplit Daily Digest</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --card: #ffffff;
      --text: #1e293b;
      --muted: #64748b;
      --line: #dce3ea;
      --accent: #0f766e;
    }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
    }
    main {
      max-width: 1100px;
      margin: 0 auto;
    }
    header {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 18px 20px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.4rem;
    }
    .meta {
      color: var(--muted);
      margin: 0;
      font-size: 0.95rem;
    }
    section {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 1.05rem;
      color: var(--accent);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.93rem;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      background: #fbfcfd;
    }
    .subject {
      font-weight: 600;
      min-width: 260px;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    li {
      margin: 6px 0;
    }
    .empty {
      color: var(--muted);
      margin: 0;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>PadSplit Daily Digest</h1>
      <p class="meta">Generated ${escapeHtml(generatedAt)} (${escapeHtml(config.schedule.timezone)})</p>
      ${deployedAt ? `<p class="meta">Deployed: ${escapeHtml(deployedAt)}</p>` : ''}
      <p class="meta">Total items: ${totalItems} | Urgent items: ${urgentCount}</p>
    </header>
    ${sections.join('\n')}
  </main>
</body>
</html>`;
}

function writeDigestReport(html: string, now: Date): string {
  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });

  const timestamp = formatTimestampForFile(now);
  const outputPath = resolve(outDir, `digest-${timestamp}.html`);

  writeFileSync(outputPath, html, 'utf-8');
  return outputPath;
}

export async function buildDigest(newItemCount = 0): Promise<{ itemCount: number; reportPath: string }> {
  const items = getVisibleClassifiedItems(config.digest.visibilityWindowHours);
  const groups = groupBySenderCategory(items);

  const urgentCount = items.filter((item) => item.urgency === 'high').length;
  const itemIds = items.map((item) => item.id).filter((id): id is number => Number.isInteger(id));
  const visibleItemsHash = createHash('sha256').update(JSON.stringify(itemIds)).digest('hex');

  const lastHash = getLastDigestHash();
  if (lastHash === visibleItemsHash && newItemCount === 0) {
    logger.info('Digest unchanged - skipping no-op digest', {
      visibleItemsHash,
      itemCount: items.length,
    });
    return { itemCount: items.length, reportPath: '' };
  }

  const now = new Date();
  const html = buildDigestHtml(groups, now);
  const reportPath = writeDigestReport(html, now);

  const digestId = createDigest({
    sent_at: now.toISOString(),
    item_count: items.length,
    urgent_count: urgentCount,
    recipient: 'local-report',
    visible_items_hash: visibleItemsHash,
    status: 'generated',
  });

  if (itemIds.length > 0) {
    markItemsSent(itemIds, digestId);
  }

  logger.info('Digest report written', {
    reportPath,
    itemCount: items.length,
    digestId,
  });

  return { itemCount: items.length, reportPath };
}
