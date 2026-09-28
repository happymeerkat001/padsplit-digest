

import { createHash } from 'node:crypto'; //computation/transformation
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; // boudary in/out 
import { resolve } from 'node:path'; // computation/transformation
import { config } from '../config.js'; // memory store
import {
  createDigest,
  getLastDigestHash,
  getVisibleClassifiedItems,
  markItemsSent,
  type DigestItem,
} from '../db/items.js'; // boundary in/out
import { logger } from '../utils/logger.js'; // boundary out

export interface SenderGroup {
  key: string;
  label: string;
  items: DigestItem[];
}

export type DigestRenderMode = 'local' | 'public';

const TASK_COLUMNS = [
  { status: 'Requests', color: '#555555' },
  { status: 'Open', color: '#0067c7' },
  { status: 'In Progress', color: '#ecbc3e' },
  { status: 'On Hold', color: '#d00000' },
  { status: 'Complete', color: '#128050' },
] as const;

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

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}...`;
}

function parseTaskDetails(item: DigestItem): {
  taskType: string;
  room: string;
  description: string;
  status: string;
} {
  const lines = (item.body_raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let status = '';
  const content = lines.filter((line) => {
    if (line.toLowerCase().startsWith('status:')) {
      status = line.replace(/^status:\s*/i, '').trim();
      return false;
    }
    return true;
  });

  return {
    taskType: content[0] || '(No type)',
    room: content[1] || '',
    description: content.slice(2).join(' ') || '(No description)',
    status: status || 'Other',
  };
}

/**
 * Public page (public/ and Firebase Hosting only).
 *
 * One line per house: "{house} · {n} open · oldest {k} days", plus a ticket
 * category only when ticket_category is exactly repair, lock, leak, or other.
 * The house name is house_id only when that value is a letter label with no
 * digits and is not copied from subject, body, sender, or tenant text.
 * Subject, description, room, and member rows are never printed.
 * Local digest HTML is unchanged. Neither mode embeds a site password or PIN.
 */
const PUBLIC_TICKET_CATEGORIES = ['repair', 'lock', 'leak', 'other'] as const;

const CLOSED_TICKET_STATUSES = new Set([
  'complete',
  'completed',
  'closed',
  'resolved',
  'cancelled',
  'canceled',
  'done',
]);

function structuredHouseLabel(item: DigestItem): string | null {
  const label = item.house_id?.trim() ?? '';
  if (!/^[A-Za-z]+(?:[ -][A-Za-z]+)*$/.test(label)) {
    return null;
  }

  const needle = label.toLowerCase();
  const freeText = [item.subject, item.body_raw, item.body_resolved, item.sender_email, item.tenant_name];
  if (freeText.some((value) => (value ?? '').toLowerCase().includes(needle))) {
    return null;
  }

  return label;
}

function structuredTicketCategory(item: DigestItem): (typeof PUBLIC_TICKET_CATEGORIES)[number] | null {
  const raw = item.ticket_category?.trim().toLowerCase() ?? '';
  if ((PUBLIC_TICKET_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as (typeof PUBLIC_TICKET_CATEGORIES)[number];
  }
  return null;
}

function isOpenMaintenanceTicket(item: DigestItem): boolean {
  const status = parseTaskDetails(item).status.trim().toLowerCase();
  return !CLOSED_TICKET_STATUSES.has(status);
}

function ageInDays(receivedAt: string, now: Date): number {
  const then = new Date(receivedAt).getTime();
  if (Number.isNaN(then)) {
    return 0;
  }
  const diff = now.getTime() - then;
  if (diff <= 0) {
    return 0;
  }
  return Math.floor(diff / 86_400_000);
}

function houseGroupKey(item: DigestItem): string {
  const label = structuredHouseLabel(item);
  if (label) {
    return `name:${label.toLowerCase()}`;
  }
  const houseId = item.house_id?.trim();
  if (houseId) {
    return `id:${houseId}`;
  }
  const subject = item.subject?.trim();
  if (subject) {
    return `subject:${subject}`;
  }
  return 'unknown';
}

function formatPublicHouseLine(
  label: string | null,
  count: number,
  oldestDays: number,
  categories: ReadonlySet<string>,
): string {
  const dayWord = oldestDays === 1 ? 'day' : 'days';
  const parts: string[] = [];
  if (label) {
    parts.push(label);
  }
  parts.push(`${count} open`);
  parts.push(`oldest ${oldestDays} ${dayWord}`);
  for (const category of PUBLIC_TICKET_CATEGORIES) {
    if (categories.has(category)) {
      parts.push(category);
    }
  }
  return parts.join(' · ');
}

function renderPublicDigest(groups: SenderGroup[], now: Date): string {
  const tickets = groups
    .filter((group) => group.key === 'tasks')
    .flatMap((group) => group.items)
    .filter((item) => isOpenMaintenanceTicket(item));

  const grouped = new Map<string, { label: string | null; items: DigestItem[] }>();
  for (const item of tickets) {
    const key = houseGroupKey(item);
    const bucket = grouped.get(key) ?? { label: structuredHouseLabel(item), items: [] };
    if (!bucket.label) {
      bucket.label = structuredHouseLabel(item);
    }
    bucket.items.push(item);
    grouped.set(key, bucket);
  }

  const lines = Array.from(grouped.entries())
    .map(([key, bucket]) => {
      const ages = bucket.items.map((item) => ageInDays(item.received_at, now));
      const oldestDays = ages.reduce((max, age) => Math.max(max, age), 0);
      const categories = new Set<string>();
      for (const item of bucket.items) {
        const category = structuredTicketCategory(item);
        if (category) {
          categories.add(category);
        }
      }
      const label = bucket.items.every((item) => structuredHouseLabel(item) === bucket.label)
        ? bucket.label
        : null;
      return {
        key,
        text: formatPublicHouseLine(label, bucket.items.length, oldestDays, categories),
      };
    })
    .sort((a, b) => a.text.localeCompare(b.text) || a.key.localeCompare(b.key));

  const updatedAt = now.toLocaleString('en-US', {
    timeZone: config.schedule.timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const body = lines.length
    ? `<ul>
    ${lines.map((line) => `<li>${escapeHtml(line.text)}</li>`).join('\n    ')}
  </ul>`
    : '<p>no open tickets.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>active maintenance tickets</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --card: #ffffff;
      --text: #1e293b;
      --muted: #64748b;
      --line: #dce3ea;
    }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
    }
    main {
      max-width: 720px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 18px 20px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.4rem;
    }
    .meta, .footer {
      color: var(--muted);
      margin: 0;
      font-size: 0.95rem;
    }
    ul {
      margin: 16px 0;
      padding-left: 20px;
    }
    li {
      margin: 6px 0;
    }
  </style>
</head>
<body>
  <main>
    <h1>active maintenance tickets</h1>
    <p class="meta">updated ${escapeHtml(updatedAt)}</p>
    ${body}
    <p class="footer">details are on the ops page (sign-in required).</p>
  </main>
</body>
</html>`;
}

function filterTaskItemsByStatus(items: DigestItem[]): DigestItem[] {
  const { taskStatuses } = config.digest;
  if (taskStatuses.length === 0) {
    return items;
  }

  const allowedStatuses = new Set(taskStatuses);
  return items.filter((item) => allowedStatuses.has(parseTaskDetails(item).status));
}

function getRenderableTasks(items: DigestItem[]): DigestItem[] {
  return items.filter((item) => {
    const { description } = parseTaskDetails(item);
    const subject = (item.subject || '').trim().toLowerCase();
    const desc = description.trim().toLowerCase();
    if (!description) return false;
    if (desc === '(no description)' || desc === 'task item') return false;
    if (subject === 'task') return false;
    return true;
  });
}

function getRecentMemberMessages(items: DigestItem[], limit = 3): DigestItem[] {
  const uniqueByContent = new Map<string, DigestItem>();
  const sorted = [...items].sort(
    (a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime()
  );

  for (const item of sorted) {
    const key = `${item.body_raw ?? ''}::${item.sender_email ?? item.tenant_name ?? ''}`;
    if (!uniqueByContent.has(key)) {
      uniqueByContent.set(key, item);
    }
    if (uniqueByContent.size >= limit) {
      break;
    }
  }

  return Array.from(uniqueByContent.values());
}

function renderItems(group: SenderGroup): string {
  if (group.key === 'member_messages') {
    const latestMessages = getRecentMemberMessages(group.items, 3);

    const rows = latestMessages.map((item) => {
      const member = escapeHtml(item.sender_email || 'Member');
      const property = escapeHtml(item.subject || '(No property)');
      const message = escapeHtml(truncateText(item.body_raw || '(No message)', 60));
      const urgency = escapeHtml(item.urgency || 'medium');
      const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
        timeZone: config.schedule.timezone,
      });

      return `<tr>
      <td>${member}</td>
      <td class="subject">${property}</td>
      <td>${message}</td>
      <td>${urgency}</td>
      <td>${escapeHtml(receivedAt)}</td>
    </tr>`;
    });

    return `<table>
    <thead>
      <tr>
        <th>Member</th>
        <th>Property</th>
        <th>Message</th>
        <th>Urgency</th>
        <th>Received (${escapeHtml(config.schedule.timezone)})</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
    </tbody>
  </table>`;
  }

  if (group.key === 'tasks') {
    const filteredItems = getRenderableTasks(group.items);
    const byStatus = new Map<string, Array<{
      item: DigestItem;
      taskType: string;
      room: string;
      description: string;
      status: string;
    }>>();

    for (const item of filteredItems) {
      const { taskType, room, description, status } = parseTaskDetails(item);
      const statusKey = status || 'Other';
      const bucket = byStatus.get(statusKey) ?? [];
      bucket.push({
        item,
        taskType,
        room,
        description,
        status: statusKey,
      });
      byStatus.set(statusKey, bucket);
    }

    const { taskStatuses } = config.digest;
    if (taskStatuses.length > 0) {
      const allowedStatuses = new Set(taskStatuses);
      for (const key of Array.from(byStatus.keys())) {
        if (!allowedStatuses.has(key)) {
          byStatus.delete(key);
        }
      }
    }

    const knownStatuses = new Set<string>(TASK_COLUMNS.map((column) => column.status));
    const sections: string[] = [];

    for (const column of TASK_COLUMNS) {
      const cards = byStatus.get(column.status) ?? [];
      if (cards.length === 0) {
        continue;
      }

      const renderedCards = cards.map(({ item, taskType, room, description }) => {
        const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
          timeZone: config.schedule.timezone,
        });
        const meta = [taskType, room].filter(Boolean).join(' | ');
        const urgency = item.urgency || 'medium';

        return `<div class="task-card">
  <div class="task-address">${escapeHtml(item.subject || '(No address)')}</div>
  <div class="task-meta">${escapeHtml(meta || '(No type)')}</div>
  <div class="task-desc">${escapeHtml(description)}</div>
  <div class="task-footer">${escapeHtml(urgency)} · ${escapeHtml(receivedAt)}</div>
</div>`;
      });

      sections.push(`<h3 style="border-left: 4px solid ${column.color}">${escapeHtml(column.status)} (${cards.length})</h3>
${renderedCards.join('\n')}`);
    }

    const otherCards = Array.from(byStatus.entries())
      .filter(([status]) => !knownStatuses.has(status))
      .flatMap(([, cards]) => cards);

    if (otherCards.length > 0) {
      const renderedOther = otherCards.map(({ item, taskType, room, description, status }) => {
        const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
          timeZone: config.schedule.timezone,
        });
        const meta = [taskType, room].filter(Boolean).join(' | ');
        const urgency = item.urgency || 'medium';
        const descriptionWithStatus = status ? `${description} (${status})` : description;

        return `<div class="task-card">
  <div class="task-address">${escapeHtml(item.subject || '(No address)')}</div>
  <div class="task-meta">${escapeHtml(meta || '(No type)')}</div>
  <div class="task-desc">${escapeHtml(descriptionWithStatus)}</div>
  <div class="task-footer">${escapeHtml(urgency)} · ${escapeHtml(receivedAt)}</div>
</div>`;
      });

      sections.push(`<h3 style="border-left: 4px solid #6b7280">Other (${otherCards.length})</h3>
${renderedOther.join('\n')}`);
    }

    return `<div class="task-board">
${sections.join('\n')}
</div>`;
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

function buildDigestHtml(groups: SenderGroup[], now: Date, mode: DigestRenderMode = 'local'): string {
  if (mode === 'public') {
    return renderPublicDigest(groups, now);
  }

  const { groups: allowedGroups } = config.digest;
  const visibleGroups = groups
    .map((group): SenderGroup => {
      if (group.key !== 'tasks') {
        if (group.key === 'member_messages') {
          return {
            ...group,
            items: getRecentMemberMessages(group.items, 3),
          };
        }
        return group;
      }

      return {
        ...group,
        items: getRenderableTasks(filterTaskItemsByStatus(group.items)),
      };
    })
    .filter((group) => group.items.length > 0)
    .filter((group) => allowedGroups.length === 0 || allowedGroups.includes(group.key));

  const totalItems = visibleGroups.reduce((sum, group) => sum + group.items.length, 0);
  const urgentCount = visibleGroups.reduce(
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

  const sections = visibleGroups.map((group) => {
    const label = group.key === 'member_messages' ? 'Recent Context (Last 3)' : group.label;
    const displayCount =
      group.key === 'member_messages'
        ? getRecentMemberMessages(group.items, 3).length
        : group.key === 'tasks'
          ? getRenderableTasks(group.items).length
          : group.items.length;
    return `
    <section>
      <h2>${escapeHtml(label)} (${displayCount})</h2>
      ${renderItems(group)}
    </section>
  `;
  });

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
    .task-board h3 {
      padding: 4px 0 4px 10px;
      margin: 14px 0 8px;
      font-size: 0.95rem;
    }
    .task-card {
      background: #fbfcfd;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .task-address {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .task-meta {
      color: var(--muted);
      font-size: 0.88rem;
      margin-bottom: 4px;
    }
    .task-desc {
      font-size: 0.9rem;
      margin-bottom: 6px;
    }
    .task-footer {
      font-size: 0.83rem;
      color: var(--muted);
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

export function renderDigestPage(
  groups: SenderGroup[],
  now: Date,
  mode: DigestRenderMode,
): string {
  return buildDigestHtml(groups, now, mode);
}

function writeDigestReport(html: string, now: Date): string {
  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });

  const timestamp = formatTimestampForFile(now);
  const outputPath = resolve(outDir, `digest-${timestamp}.html`);

  writeFileSync(outputPath, html, 'utf-8');
  return outputPath;
}

export async function buildDigest(newItemCount = 0): Promise<{
  itemCount: number;
  reportPath: string;
  groups: SenderGroup[];
  generatedAt: Date;
}> {
  const items = getVisibleClassifiedItems(config.digest.visibilityWindowHours); // boundary in
  const groups = groupBySenderCategory(items); // computation/transformation

  const urgentCount = items.filter((item) => item.urgency === 'high').length; // computation/transformation
  const itemIds = items.map((item) => item.id).filter((id): id is number => Number.isInteger(id)); // computation/transformation
  const visibleItemsHash = createHash('sha256').update(JSON.stringify(itemIds)).digest('hex'); // computation/transformation

  const lastHash = getLastDigestHash(); // boundary in
  if (lastHash === visibleItemsHash && newItemCount === 0) { // computation/ iteration
    logger.info('Digest unchanged - skipping no-op digest', {
      visibleItemsHash,
      itemCount: items.length,
    });
    return { itemCount: items.length, reportPath: '', groups: [], generatedAt: new Date() };
  }

  const now = new Date();
  const html = renderDigestPage(groups, now, 'local');
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

  return { itemCount: items.length, reportPath, groups, generatedAt: now };
}
